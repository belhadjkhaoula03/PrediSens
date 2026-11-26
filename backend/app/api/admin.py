from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.api.auth import current_user, get_db, hash_password, password_hash, require_roles
from app.infrastructure.models import (
    AdminActivityRow,
    AlertRow,
    DatabaseBackupRow,
    InterventionRow,
    LoginEventRow,
    MachineRow,
    MeasurementRow,
    SensorReplacementRow,
    SensorRow,
    SystemSettingRow,
    UserNotificationRow,
    UserRow,
)
from app.infrastructure.notifications import send_account_notification
from app.infrastructure.database_backups import (
    BackupError,
    backup_configuration,
    backup_file_path,
    create_backup,
    set_backup_schedule,
)

router = APIRouter(prefix="/api/admin", tags=["administration"])
admin_only = require_roles("admin")
RoleName = Literal["technician", "manager", "director", "admin"]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=160)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=255)
    phone: str = Field(default="", max_length=40)
    role: RoleName
    password: str = Field(min_length=12, max_length=200)
    active: bool = True


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str | None = Field(default=None, min_length=2, max_length=160)
    email: str | None = Field(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=255)
    phone: str | None = Field(default=None, max_length=40)
    role: RoleName | None = None
    active: bool | None = None


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=160)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=255)
    phone: str = Field(default="", max_length=40)


class PasswordUpdate(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email_notifications: bool
    language: Literal["fr", "en"]
    session_minutes: Literal[15, 30, 60, 120]
    telemetry_stale_after_seconds: int | None = Field(default=None, ge=5, le=3600)


class BackupScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    interval_minutes: int = Field(ge=1, le=525600)


class SensorReplacementInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sensor_type: str = Field(min_length=2, max_length=80)
    gpio: int | None = Field(default=None, ge=0, le=39)
    unit: str = Field(min_length=1, max_length=20)
    reason: str = Field(min_length=3, max_length=2000)


def user_dict(user: UserRow) -> dict:
    return {
        "id": user.id,
        "full_name": user.full_name,
        "email": user.email,
        "phone": user.phone,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "last_login": user.last_login,
    }


def log_activity(db: Session, actor: UserRow, action: str, target: str, details: str = "") -> None:
    db.add(AdminActivityRow(actor_email=actor.email, action=action, target=target, details=details))


def ensure_active_administrator(db: Session, user: UserRow, role: str, active: bool) -> None:
    if user.role == "admin" and user.active and (role != "admin" or not active):
        remaining = db.scalar(
            select(func.count()).select_from(UserRow).where(
                UserRow.role == "admin",
                UserRow.active.is_(True),
                UserRow.id != user.id,
            )
        )
        if not remaining:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Impossible de désactiver ou rétrograder le dernier administrateur actif",
            )


def add_user_notification(
    db: Session,
    user: UserRow,
    email_to: str,
    message: str,
) -> UserNotificationRow:
    notification = UserNotificationRow(
        user_id=user.id,
        email_to=email_to,
        message=message,
        delivery_status="pending",
    )
    db.add(notification)
    db.flush()
    return notification


def deliver_notification(db: Session, notification: UserNotificationRow) -> str:
    if get_setting(db, "email_notifications", "true") != "true":
        delivery_status, error = "in_app_only", ""
    else:
        delivery_status, error = send_account_notification(notification.email_to, notification.message)
    notification.delivery_status = delivery_status
    notification.delivery_error = error
    db.commit()
    return delivery_status


def get_setting(db: Session, key: str, default: str) -> str:
    row = db.get(SystemSettingRow, key)
    return row.value if row else default


@router.get("/overview")
def overview(db: Session = Depends(get_db), _: UserRow = Depends(admin_only)):
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.scalar(select(func.count()).select_from(UserRow)) or 0
    active = db.scalar(select(func.count()).select_from(UserRow).where(UserRow.active.is_(True))) or 0
    role_rows = db.execute(select(UserRow.role, func.count()).group_by(UserRow.role)).all()
    role_counts = {role: count for role, count in role_rows}
    login_count = db.scalar(
        select(func.count()).select_from(LoginEventRow).where(
            LoginEventRow.success.is_(True),
            LoginEventRow.created_at >= today,
        )
    ) or 0
    recent_activity = db.scalars(
        select(AdminActivityRow).order_by(desc(AdminActivityRow.created_at)).limit(6)
    ).all()
    notifications = db.scalars(
        select(UserNotificationRow).order_by(desc(UserNotificationRow.created_at)).limit(4)
    ).all()
    active_alerts = db.scalars(
        select(AlertRow).where(AlertRow.status.not_in(("closed", "false_positive"))).order_by(desc(AlertRow.created_at)).limit(4)
    ).all()
    latest_measurement = db.scalar(
        select(MeasurementRow)
        .order_by(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id))
        .limit(1)
    )
    measurement_recorded_at = latest_measurement.recorded_at if latest_measurement else None
    if measurement_recorded_at is not None and measurement_recorded_at.tzinfo is None:
        measurement_recorded_at = measurement_recorded_at.replace(tzinfo=timezone.utc)
    trend = []
    for offset in range(6, -1, -1):
        day = (now - timedelta(days=offset)).date()
        start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        count = db.scalar(
            select(func.count()).select_from(UserRow).where(
                UserRow.created_at >= start,
                UserRow.created_at < end,
            )
        ) or 0
        trend.append({"date": day.isoformat(), "count": count})
    return {
        "total_users": total,
        "active_users": active,
        "disabled_users": total - active,
        "role_counts": role_counts,
        "logins_today": login_count,
        "acquisition_mode": latest_measurement.acquisition_mode if latest_measurement else "waiting",
        "measurement_source": latest_measurement.current_source if latest_measurement else "waiting",
        "measurement_recorded_at": measurement_recorded_at,
        "measurement_server_time": now,
        "measurement_age_seconds": (
            max(0, (now - measurement_recorded_at).total_seconds())
            if latest_measurement else None
        ),
        "measurement_current_rms": latest_measurement.current_rms if latest_measurement else None,
        "user_trend": trend,
        "recent_activity": [
            {
                "id": row.id,
                "created_at": row.created_at,
                "actor_email": row.actor_email,
                "action": row.action,
                "target": row.target,
            }
            for row in recent_activity
        ],
        "recent_notifications": sorted(
            [
                {
                    "id": row.id,
                    "created_at": row.created_at,
                    "message": row.message,
                    "delivery_status": row.delivery_status,
                }
                for row in notifications
            ] + [
                {
                    "id": f"alert-{row.id}",
                    "created_at": row.created_at,
                    "message": f"Alerte {row.severity} — {row.metric} : {row.value}",
                    "delivery_status": "system_alert",
                    "machine_name": db.get(MachineRow, row.machine_id).name,
                }
                for row in active_alerts
            ],
            key=lambda item: item["created_at"],
            reverse=True,
        )[:4],
    }


@router.get("/users")
def list_users(
    search: str = Query(default="", max_length=160),
    role: RoleName | None = None,
    active: bool | None = None,
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    stmt = select(UserRow).order_by(UserRow.full_name, UserRow.email)
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where((UserRow.full_name.ilike(pattern)) | (UserRow.email.ilike(pattern)))
    if role:
        stmt = stmt.where(UserRow.role == role)
    if active is not None:
        stmt = stmt.where(UserRow.active.is_(active))
    return [user_dict(user) for user in db.scalars(stmt).all()]


@router.post("/users", status_code=status.HTTP_201_CREATED)
def create_user(
    data: UserCreate,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    email = str(data.email).lower()
    if db.scalar(select(UserRow).where(UserRow.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Cette adresse e-mail est déjà utilisée")
    user = UserRow(
        full_name=data.full_name.strip(),
        email=email,
        phone=data.phone.strip(),
        role=data.role,
        password_hash=hash_password(data.password),
        active=data.active,
    )
    db.add(user)
    db.flush()
    log_activity(db, actor, "creation", email, f"Rôle : {data.role}")
    notification = add_user_notification(
        db,
        user,
        email,
        "Votre compte PrediMaint a été créé par l'administrateur système. Vous pouvez vous connecter avec les identifiants qui vous ont été communiqués.",
    )
    db.commit()
    db.refresh(user)
    delivery_status = deliver_notification(db, notification)
    return {**user_dict(user), "notification_status": delivery_status}


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    user = db.get(UserRow, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if value is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Le champ {key} ne peut pas être nul")
        if key == "email" and value is not None:
            value = str(value).lower()
            duplicate = db.scalar(select(UserRow).where(UserRow.email == value, UserRow.id != user.id))
            if duplicate:
                raise HTTPException(status.HTTP_409_CONFLICT, "Cette adresse e-mail est déjà utilisée")
        if key in {"full_name", "phone"} and value is not None:
            value = value.strip()
        changes[key] = value
    ensure_active_administrator(
        db,
        user,
        changes.get("role", user.role),
        changes.get("active", user.active),
    )
    previous_email = user.email
    changed = {key: value for key, value in changes.items() if getattr(user, key) != value}
    if not changed:
        return user_dict(user)
    invalidate_sessions = "role" in changed or "active" in changed
    for key, value in changed.items():
        setattr(user, key, value)
    if invalidate_sessions:
        user.token_version += 1
    log_activity(db, actor, "modification", user.email, ", ".join(sorted(changed)))
    notification = add_user_notification(
        db,
        user,
        previous_email,
        "Les informations de votre compte PrediMaint ont été mises à jour par l'administrateur système.",
    )
    db.commit()
    db.refresh(user)
    delivery_status = deliver_notification(db, notification)
    return {**user_dict(user), "notification_status": delivery_status}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    user = db.get(UserRow, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    if user.id == actor.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Vous ne pouvez pas supprimer votre propre compte")
    ensure_active_administrator(db, user, "deleted", False)
    has_interventions = db.scalar(
        select(func.count()).select_from(InterventionRow).where(InterventionRow.user_id == user.id)
    )
    if has_interventions:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cet utilisateur possède un historique d'interventions. Désactivez son compte plutôt que de le supprimer.",
        )
    email = user.email
    notification = add_user_notification(
        db,
        user,
        email,
        "Votre compte PrediMaint a été supprimé par l'administrateur système.",
    )
    log_activity(db, actor, "suppression", email)
    db.delete(user)
    db.commit()
    delivery_status = deliver_notification(db, notification)
    return {"deleted": True, "notification_status": delivery_status}


@router.get("/roles")
def roles(db: Session = Depends(get_db), _: UserRow = Depends(admin_only)):
    definitions = [
        ("technician", "Technicien de maintenance", "Mesures, alertes et interventions"),
        ("manager", "Responsable de maintenance", "Machines, capteurs, seuils et interventions"),
        ("director", "Directeur de production", "Indicateurs et consultation en lecture seule"),
        ("admin", "Administrateur système", "Comptes, rôles, sécurité et journaux"),
    ]
    counts = dict(db.execute(select(UserRow.role, func.count()).group_by(UserRow.role)).all())
    return [
        {"id": key, "name": name, "permissions": permissions, "user_count": counts.get(key, 0)}
        for key, name, permissions in definitions
    ]


@router.get("/login-history")
def login_history(
    search: str = Query(default="", max_length=255),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    stmt = select(LoginEventRow).order_by(desc(LoginEventRow.created_at)).limit(limit)
    if search:
        stmt = stmt.where(LoginEventRow.email.ilike(f"%{search.strip()}%"))
    return [
        {
            "id": row.id,
            "email": row.email,
            "ip_address": row.ip_address,
            "event_type": row.event_type,
            "success": row.success,
            "created_at": row.created_at,
        }
        for row in db.scalars(stmt).all()
    ]


@router.get("/activity")
def activity(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    rows = db.scalars(select(AdminActivityRow).order_by(desc(AdminActivityRow.created_at)).limit(limit)).all()
    return [
        {
            "id": row.id,
            "actor_email": row.actor_email,
            "action": row.action,
            "target": row.target,
            "details": row.details,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.get("/notifications")
def admin_notifications(
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    rows = db.scalars(select(UserNotificationRow).order_by(desc(UserNotificationRow.created_at)).limit(200)).all()
    account_notifications = [
        {
            "id": row.id,
            "type": "account",
            "user_id": row.user_id,
            "email_to": row.email_to,
            "message": row.message,
            "delivery_status": row.delivery_status,
            "delivery_error": row.delivery_error,
            "created_at": row.created_at,
            "read_at": row.read_at,
        }
        for row in rows
    ]
    alerts = db.scalars(
        select(AlertRow).where(AlertRow.status.not_in(("closed", "false_positive"))).order_by(desc(AlertRow.created_at)).limit(100)
    ).all()
    system_notifications = [
        {
            "id": f"alert-{row.id}",
            "type": "system_alert",
            "user_id": None,
            "email_to": row.machine_id,
            "machine_name": db.get(MachineRow, row.machine_id).name,
            "message": f"Alerte {row.severity} — {row.metric} : {row.value}",
            "severity": row.severity,
            "delivery_status": "system_alert",
            "delivery_error": "",
            "created_at": row.created_at,
        }
        for row in alerts
    ]
    return sorted(account_notifications + system_notifications, key=lambda item: item["created_at"], reverse=True)


@router.get("/profile")
def get_profile(user: UserRow = Depends(admin_only)):
    return user_dict(user)


@router.patch("/profile")
def update_profile(
    data: ProfileUpdate,
    db: Session = Depends(get_db),
    user: UserRow = Depends(admin_only),
):
    email = str(data.email).lower()
    duplicate = db.scalar(select(UserRow).where(UserRow.email == email, UserRow.id != user.id))
    if duplicate:
        raise HTTPException(status.HTTP_409_CONFLICT, "Cette adresse e-mail est déjà utilisée")
    previous_email = user.email
    changes = {
        "full_name": data.full_name.strip(),
        "email": email,
        "phone": data.phone.strip(),
    }
    changed = {key: value for key, value in changes.items() if getattr(user, key) != value}
    if not changed:
        return user_dict(user)
    for key, value in changed.items():
        setattr(user, key, value)
    log_activity(db, user, "modification du profil", user.email, ", ".join(sorted(changed)))
    notification = add_user_notification(
        db,
        user,
        previous_email,
        "Les informations de votre compte PrediMaint ont été mises à jour par l'administrateur système.",
    )
    db.commit()
    db.refresh(user)
    delivery_status = deliver_notification(db, notification)
    return {**user_dict(user), "notification_status": delivery_status}


@router.post("/profile/password")
def update_password(
    data: PasswordUpdate,
    db: Session = Depends(get_db),
    user: UserRow = Depends(admin_only),
):
    if not password_hash.verify(data.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Le mot de passe actuel est incorrect")
    user.password_hash = hash_password(data.new_password)
    user.token_version += 1
    log_activity(db, user, "changement de mot de passe", user.email)
    notification = add_user_notification(
        db,
        user,
        user.email,
        "Le mot de passe de votre compte PrediMaint a été modifié.",
    )
    db.commit()
    delivery_status = deliver_notification(db, notification)
    return {"updated": True, "sessions_revoked": True, "notification_status": delivery_status}


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), _: UserRow = Depends(admin_only)):
    return {
        "email_notifications": get_setting(db, "email_notifications", "true") == "true",
        "language": get_setting(db, "language", "fr"),
        "session_minutes": int(get_setting(db, "session_minutes", "30")),
        "telemetry_stale_after_seconds": int(
            get_setting(db, "director_telemetry_stale_seconds", "30")
        ),
    }


@router.put("/settings")
def update_settings(
    data: SettingsUpdate,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    values = {
        "email_notifications": str(data.email_notifications).lower(),
        "language": data.language,
        "session_minutes": str(data.session_minutes),
    }
    if data.telemetry_stale_after_seconds is not None:
        values["director_telemetry_stale_seconds"] = str(
            data.telemetry_stale_after_seconds
        )
    for key, value in values.items():
        row = db.get(SystemSettingRow, key)
        if row is None:
            db.add(SystemSettingRow(key=key, value=value))
        else:
            row.value = value
    log_activity(db, actor, "modification des paramètres", "Paramètres système")
    db.commit()
    return data.model_dump()


def backup_dict(row: DatabaseBackupRow) -> dict:
    return {
        "id": row.id,
        "filename": row.filename,
        "created_at": row.created_at,
        "size_bytes": row.size_bytes,
        "status": row.status,
        "trigger": row.trigger,
        "error_message": row.error_message,
    }


@router.get("/sensors")
def list_sensors_for_replacement(
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    rows = db.execute(
        select(SensorRow, MachineRow.name, MachineRow.active)
        .join(MachineRow, MachineRow.id == SensorRow.machine_id)
        .order_by(MachineRow.name, SensorRow.metric, SensorRow.id)
    ).all()
    return [
        {
            "id": sensor.id,
            "machine_id": sensor.machine_id,
            "machine_name": machine_name,
            "machine_active": machine_active,
            "metric": sensor.metric,
            "sensor_type": sensor.sensor_type,
            "gpio": sensor.gpio,
            "unit": sensor.unit,
            "enabled": sensor.enabled,
            "created_at": sensor.created_at,
        }
        for sensor, machine_name, machine_active in rows
    ]


@router.get("/sensor-replacements")
def list_sensor_replacements(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    old_sensor = aliased(SensorRow)
    new_sensor = aliased(SensorRow)
    rows = db.execute(
        select(
            SensorReplacementRow,
            MachineRow.name,
            old_sensor.metric,
            old_sensor.sensor_type,
            new_sensor.sensor_type,
        )
        .join(MachineRow, MachineRow.id == SensorReplacementRow.machine_id)
        .join(old_sensor, old_sensor.id == SensorReplacementRow.old_sensor_id)
        .join(new_sensor, new_sensor.id == SensorReplacementRow.new_sensor_id)
        .order_by(desc(SensorReplacementRow.replaced_at), desc(SensorReplacementRow.id))
        .limit(limit)
    ).all()
    return [
        {
            "id": replacement.id,
            "machine_id": replacement.machine_id,
            "machine_name": machine_name,
            "metric": metric,
            "old_sensor_id": replacement.old_sensor_id,
            "old_sensor_type": old_sensor_type,
            "new_sensor_id": replacement.new_sensor_id,
            "new_sensor_type": new_sensor_type,
            "reason": replacement.reason,
            "replaced_at": replacement.replaced_at,
            "administrator_id": replacement.administrator_id,
            "administrator_name": replacement.administrator_name,
            "administrator_email": replacement.administrator_email,
        }
        for (
            replacement,
            machine_name,
            metric,
            old_sensor_type,
            new_sensor_type,
        ) in rows
    ]


@router.post(
    "/machines/{machine_id}/sensors/{sensor_id}/replace",
    status_code=status.HTTP_201_CREATED,
)
def replace_sensor(
    machine_id: str,
    sensor_id: int,
    data: SensorReplacementInput,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    machine = db.get(MachineRow, machine_id)
    if machine is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    if not machine.active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Impossible de remplacer un capteur sur une machine archivée")
    old_sensor = db.scalar(
        select(SensorRow)
        .where(
            SensorRow.id == sensor_id,
            SensorRow.machine_id == machine_id,
        )
        .with_for_update()
    )
    if old_sensor is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Capteur introuvable sur cette machine")
    if not old_sensor.enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Seul un capteur actif peut être remplacé")
    if db.scalar(
        select(SensorRow.id).where(
            SensorRow.machine_id == machine_id,
            SensorRow.metric == old_sensor.metric,
            SensorRow.enabled.is_(True),
            SensorRow.id != old_sensor.id,
        )
    ) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Un autre capteur actif existe déjà pour cette grandeur",
        )

    sensor_type = data.sensor_type.strip()
    unit = data.unit.strip()
    reason = data.reason.strip()
    if len(sensor_type) < 2 or not unit or len(reason) < 3:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Le type, l'unité et le motif du remplacement sont requis",
        )
    old_sensor.enabled = False
    db.flush([old_sensor])
    new_sensor = SensorRow(
        machine_id=machine_id,
        metric=old_sensor.metric,
        sensor_type=sensor_type,
        gpio=data.gpio,
        unit=unit,
        enabled=True,
    )
    db.add(new_sensor)
    try:
        db.flush()
        replacement = SensorReplacementRow(
            machine_id=machine_id,
            old_sensor_id=old_sensor.id,
            new_sensor_id=new_sensor.id,
            reason=reason,
            replaced_at=datetime.now(timezone.utc),
            administrator_id=actor.id,
            administrator_name=actor.full_name,
            administrator_email=actor.email,
        )
        db.add(replacement)
        log_activity(
            db,
            actor,
            "remplacement de capteur",
            f"{machine_id} · {old_sensor.metric}",
            f"Capteur {old_sensor.id} remplacé par {new_sensor.id} : {reason}",
        )
        db.commit()
        db.refresh(new_sensor)
        db.refresh(replacement)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Un remplacement concurrent ou un doublon empêche cette opération",
        ) from exc

    return {
        "id": replacement.id,
        "machine_id": machine_id,
        "metric": old_sensor.metric,
        "old_sensor": {
            "id": old_sensor.id,
            "sensor_type": old_sensor.sensor_type,
            "enabled": old_sensor.enabled,
        },
        "new_sensor": {
            "id": new_sensor.id,
            "sensor_type": new_sensor.sensor_type,
            "gpio": new_sensor.gpio,
            "unit": new_sensor.unit,
            "enabled": new_sensor.enabled,
        },
        "reason": replacement.reason,
        "replaced_at": replacement.replaced_at,
        "administrator_id": actor.id,
    }


@router.get("/backups")
def list_backups(db: Session = Depends(get_db), _: UserRow = Depends(admin_only)):
    rows = db.scalars(
        select(DatabaseBackupRow)
        .order_by(desc(DatabaseBackupRow.created_at), desc(DatabaseBackupRow.id))
        .limit(100)
    ).all()
    latest_success = db.scalar(
        select(DatabaseBackupRow)
        .where(DatabaseBackupRow.status == "succeeded")
        .order_by(desc(DatabaseBackupRow.created_at), desc(DatabaseBackupRow.id))
        .limit(1)
    )
    configuration = backup_configuration(db)
    return {
        **configuration,
        "last_backup": backup_dict(latest_success) if latest_success else None,
        "last_attempt": backup_dict(rows[0]) if rows else None,
        "items": [backup_dict(row) for row in rows],
    }


@router.post("/backups", status_code=status.HTTP_201_CREATED)
def create_database_backup(
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    try:
        row = create_backup(db, trigger="manual")
    except BackupError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    configuration = backup_configuration(db)
    if configuration["enabled"]:
        set_backup_schedule(db, True, configuration["interval_minutes"])
    log_activity(db, actor, "sauvegarde créée", row.filename, f"{row.size_bytes} octets")
    db.commit()
    return backup_dict(row)


@router.get("/backups/config")
def read_backup_schedule(
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    return backup_configuration(db)


@router.put("/backups/config")
def update_backup_schedule(
    data: BackupScheduleUpdate,
    db: Session = Depends(get_db),
    actor: UserRow = Depends(admin_only),
):
    next_run_at = set_backup_schedule(db, data.enabled, data.interval_minutes)
    log_activity(
        db,
        actor,
        "configuration des sauvegardes",
        "Sauvegarde PostgreSQL",
        f"Automatique {'activée' if data.enabled else 'désactivée'}; intervalle {data.interval_minutes} min",
    )
    db.commit()
    return {
        "enabled": data.enabled,
        "interval_minutes": data.interval_minutes,
        "next_run_at": next_run_at,
    }


@router.get("/backups/{backup_id}/download")
def download_database_backup(
    backup_id: int,
    db: Session = Depends(get_db),
    _: UserRow = Depends(admin_only),
):
    row = db.get(DatabaseBackupRow, backup_id)
    if row is None or row.status != "succeeded":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sauvegarde disponible introuvable")
    try:
        path: Path = backup_file_path(row.filename)
    except BackupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fichier de sauvegarde introuvable") from exc
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fichier de sauvegarde introuvable")
    return FileResponse(path, media_type="application/octet-stream", filename=row.filename)


@router.get("/notifications/me")
def user_notifications(
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    rows = db.scalars(
        select(UserNotificationRow)
        .where(UserNotificationRow.user_id == user.id)
        .order_by(desc(UserNotificationRow.created_at))
        .limit(100)
    ).all()
    return [
        {
            "id": row.id,
            "message": row.message,
            "delivery_status": row.delivery_status,
            "created_at": row.created_at,
        }
        for row in rows
    ]
