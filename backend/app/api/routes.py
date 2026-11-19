import hashlib
import logging
import secrets
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, desc, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.auth import authenticate, current_user, get_db, hash_password, issue_token, password_hash, require_roles
from app.application.services import MeasurementInput
from app.infrastructure.models import (
    AlertEventRow,
    AlertRow,
    AppliedOfflineActionRow,
    CalibrationRecordRow,
    InterventionRow,
    InterventionPhotoRow,
    LoginEventRow,
    MachineRow,
    MachineTechnicianAccessRow,
    ManagerFailureRow,
    MaintenanceFailureRow,
    MeasurementRow,
    MeasurementSensorSourceRow,
    PasswordResetAttemptRow,
    PasswordResetTokenRow,
    PushSubscriptionRow,
    SensorRow,
    ThresholdRow,
    TechnicianNotificationRow,
    UserNotificationRow,
    UserRow,
)
from app.infrastructure.notifications import send_email
from app.infrastructure.repository import SqlMeasurementRepository
from app.infrastructure.web_push import dispatch_web_push, web_push_is_configured
from app.settings import settings

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)
MANAGERS = ("manager",)
MAINTENANCE = ("technician", "manager")
METRICS = {"temperature", "humidity", "vibration_rate", "current_rms"}
INTERVENTION_STATUSES = {"assigned", "accepted", "in_progress", "completed", "cancelled"}
RESET_WINDOW = timedelta(minutes=15)
RESET_REQUEST_LIMIT = 3
MAX_INTERVENTION_PHOTO_BYTES = 8 * 1024 * 1024
WEB_PUSH_HOST_SUFFIXES = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "notify.windows.com",
    "push.apple.com",
)


class LoginInput(BaseModel):
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class ThresholdInput(BaseModel):
    warning: float = Field(ge=0)
    critical: float = Field(gt=0)
    enabled: bool = True


class InterventionInput(BaseModel):
    description: str = Field(min_length=3, max_length=4000)
    duration_minutes: int = Field(default=0, ge=0, le=100000)
    alert_id: int | None = None


class InterventionAssignmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine_id: str = Field(min_length=2, max_length=80)
    assigned_to_id: int = Field(gt=0)
    title: str = Field(min_length=2, max_length=200)
    description: str = Field(min_length=3, max_length=4000)
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    due_at: datetime | None = None
    alert_id: int | None = None
    failure_id: int | None = Field(default=None, gt=0)


class InterventionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["assigned", "accepted", "in_progress", "completed", "cancelled"] | None = None
    diagnosis: str | None = Field(default=None, max_length=4000)
    work_done: str | None = Field(default=None, max_length=4000)
    result: str | None = Field(default=None, max_length=4000)
    assigned_to_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=2, max_length=200)
    description: str | None = Field(default=None, min_length=3, max_length=4000)
    priority: Literal["low", "normal", "high", "urgent"] | None = None
    due_at: datetime | None = None
    expected_revision: int | None = Field(default=None, ge=1)
    client_action_id: str | None = Field(default=None, min_length=8, max_length=64)


class FailureUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    diagnosis: str = Field(max_length=4000)
    intervention: str = Field(max_length=4000)
    result: str = Field(max_length=4000)


class CalibrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine_id: str = Field(min_length=2, max_length=80)
    sensor_id: int = Field(gt=0)
    reference_value: float
    measured_value: float
    observations: str = Field(default="", max_length=2000)


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=160)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=255)
    phone: str = Field(default="", max_length=40)


class PushSubscriptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=2048)
    p256dh: str = Field(min_length=16, max_length=255)
    auth: str = Field(min_length=8, max_length=255)

    @field_validator("endpoint")
    @classmethod
    def require_https_endpoint(cls, value: str) -> str:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        is_allowed_host = any(
            host == suffix or host.endswith(f".{suffix}")
            for suffix in WEB_PUSH_HOST_SUFFIXES
        )
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 443)
            or not is_allowed_host
        ):
            raise ValueError("Le point de terminaison Push doit utiliser HTTPS et un service navigateur pris en charge")
        return value


class PushSubscriptionDeleteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=2048)


class NotificationReceiptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    notification_ids: list[int] = Field(min_length=1, max_length=100)


class ProfilePasswordInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)


class PasswordResetRequestInput(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=255)


class PasswordResetCompleteInput(BaseModel):
    token: str = Field(min_length=32, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)
    confirm_password: str = Field(min_length=12, max_length=200)


class MachineCreate(BaseModel):
    id: str = Field(min_length=2, max_length=80, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=2000)


class MachineUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=2000)
    active: bool = True


class SensorCreate(BaseModel):
    metric: Literal["temperature", "humidity", "vibration_rate", "current_rms"]
    sensor_type: str = Field(min_length=2, max_length=80)
    gpio: int | None = Field(default=None, ge=0, le=39)
    unit: str = Field(min_length=1, max_length=20)


class SensorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sensor_type: str | None = Field(default=None, min_length=2, max_length=80)
    gpio: int | None = Field(default=None, ge=0, le=39)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    enabled: bool | None = None


def can_access_machine(db: Session, user: UserRow, machine_id: str) -> bool:
    if user.role != "technician":
        return True
    machine = db.get(MachineRow, machine_id)
    if machine is None or not machine.active:
        return False
    return db.scalar(
        select(MachineTechnicianAccessRow.id).where(
            MachineTechnicianAccessRow.machine_id == machine_id,
            MachineTechnicianAccessRow.technician_id == user.id,
        )
    ) is not None


def require_machine_access(db: Session, user: UserRow, machine_id: str) -> MachineRow:
    machine = db.get(MachineRow, machine_id)
    if machine is None or not can_access_machine(db, user, machine_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou non autorisée")
    return machine


def grant_machine_access(db: Session, machine_id: str, technician_id: int, granted_by_id: int) -> None:
    technician = db.get(UserRow, technician_id)
    if technician is None or technician.role != "technician" or not technician.active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le compte sélectionné n'est pas un technicien actif")
    existing = db.scalar(
        select(MachineTechnicianAccessRow).where(
            MachineTechnicianAccessRow.machine_id == machine_id,
            MachineTechnicianAccessRow.technician_id == technician_id,
        )
    )
    if existing is None:
        db.add(
            MachineTechnicianAccessRow(
                machine_id=machine_id,
                technician_id=technician_id,
                granted_by_id=granted_by_id,
            )
        )


def add_technician_notification(
    db: Session,
    user_id: int,
    key: str,
    notification_type: str,
    message: str,
    target_type: str = "",
    target_id: str = "",
) -> TechnicianNotificationRow | None:
    existing = db.scalar(
        select(TechnicianNotificationRow).where(
            TechnicianNotificationRow.user_id == user_id,
            TechnicianNotificationRow.notification_key == key,
        )
    )
    if existing is None:
        notification = TechnicianNotificationRow(
            user_id=user_id,
            notification_key=key,
            notification_type=notification_type,
            message=message,
            target_type=target_type,
            target_id=target_id,
        )
        db.add(notification)
        return notification
    return None


def intervention_dict(row: InterventionRow, db: Session) -> dict:
    assignee = db.get(UserRow, row.assigned_to_id) if row.assigned_to_id else None
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "alert_id": row.alert_id,
        "created_by_id": row.user_id,
        "assigned_to_id": row.assigned_to_id,
        "assigned_to_name": assignee.full_name if assignee else "",
        "title": row.title or "Intervention",
        "description": row.description,
        "priority": row.priority,
        "status": row.status,
        "due_at": row.due_at,
        "diagnosis": row.diagnosis,
        "work_done": row.work_done,
        "result": row.result,
        "duration_minutes": row.duration_minutes,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "resolved_at": row.resolved_at,
        "revision": row.revision,
    }


def failure_dict(row: MaintenanceFailureRow) -> dict:
    return {
        "id": row.id,
        "alert_id": row.alert_id,
        "machine_id": row.machine_id,
        "failure_type": row.failure_type,
        "description": row.description,
        "diagnosis": row.diagnosis,
        "intervention": row.intervention,
        "result": row.result,
        "detected_at": row.detected_at,
        "resolved_at": row.resolved_at,
    }


@router.get("/health")
def health():
    return {"status": "ok"}


@router.post("/auth/login")
def login(data: LoginInput, request: Request, db: Session = Depends(get_db)):
    user = authenticate(db, data.email, data.password)
    db.add(
        LoginEventRow(
            email=data.email.lower(),
            ip_address=request.client.host if request.client else "",
            success=user is not None,
        )
    )
    if not user:
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Identifiants incorrects")
    user.last_login = datetime.now(timezone.utc)
    db.commit()
    return {
        "access_token": issue_token(user, db),
        "token_type": "bearer",
        "role": user.role,
        "email": user.email,
    }


@router.get("/auth/me")
def me(user: UserRow = Depends(current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role,
    }


def machine_dict(
    machine: MachineRow,
    latest_measurement: MeasurementRow | None = None,
    server_time: datetime | None = None,
) -> dict:
    if server_time is None:
        server_time = datetime.now(timezone.utc)
    recorded_at = latest_measurement.recorded_at if latest_measurement else None
    if recorded_at is not None and recorded_at.tzinfo is None:
        recorded_at = recorded_at.replace(tzinfo=timezone.utc)
    return {
        "id": machine.id,
        "name": machine.name,
        "description": machine.description,
        "status": machine.status,
        "active": machine.active,
        "last_seen": machine.last_seen,
        "last_measurement_mode": (
            latest_measurement.acquisition_mode if latest_measurement else None
        ),
        "measurement_recorded_at": recorded_at,
        "measurement_server_time": server_time,
        "measurement_age_seconds": (
            max(0, (server_time - recorded_at).total_seconds()) if recorded_at else None
        ),
        "created_at": machine.created_at,
    }


def alert_creation_events(db: Session, alert_ids: list[int]) -> dict[int, AlertEventRow]:
    if not alert_ids:
        return {}
    events = db.scalars(
        select(AlertEventRow)
        .where(AlertEventRow.alert_id.in_(alert_ids), AlertEventRow.action == "created")
        .order_by(AlertEventRow.created_at, AlertEventRow.id)
    ).all()
    result: dict[int, AlertEventRow] = {}
    for event in events:
        result.setdefault(event.alert_id, event)
    return result


def alert_dict(row: AlertRow, machine: MachineRow, creation_event: AlertEventRow | None = None) -> dict:
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "machine_name": machine.name,
        "metric": row.metric,
        "severity": row.severity,
        "value": row.value,
        "acquisition_mode": row.acquisition_mode,
        "status": row.status,
        "created_at": row.created_at,
        "acknowledged_by_id": row.acknowledged_by_id,
        "acknowledged_at": row.acknowledged_at,
        "detected_at": creation_event.created_at if creation_event else None,
        "source_measurement_id": creation_event.source_measurement_id if creation_event else None,
        "processing_delay_ms": creation_event.processing_delay_ms if creation_event else None,
    }


@router.get("/machines/{machine_id}/details")
def machine_details(
    machine_id: str,
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    machine = require_machine_access(db, user, machine_id)
    latest = db.scalar(
        select(MeasurementRow)
        .where(MeasurementRow.machine_id == machine_id)
        .order_by(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id))
        .limit(1)
    )
    sensors = db.scalars(
        select(SensorRow).where(SensorRow.machine_id == machine_id).order_by(SensorRow.id)
    ).all()
    sensor_ids: dict[str, int] = {}
    if latest is not None:
        sources = db.scalars(
            select(MeasurementSensorSourceRow).where(
                MeasurementSensorSourceRow.measurement_id == latest.id
            )
        ).all()
        sensor_ids = {source.metric: source.sensor_id for source in sources}
    alerts = db.scalars(
        select(AlertRow)
        .where(
            AlertRow.machine_id == machine_id,
            AlertRow.status.not_in(("closed", "false_positive")),
        )
        .order_by(desc(AlertRow.created_at), desc(AlertRow.id))
        .limit(50)
    ).all()
    events = alert_creation_events(db, [row.id for row in alerts])
    active_intervention_count = db.scalar(
        select(func.count())
        .select_from(InterventionRow)
        .where(
            InterventionRow.machine_id == machine_id,
            InterventionRow.status.in_(("assigned", "accepted", "in_progress")),
            or_(
                InterventionRow.assigned_to_id == user.id,
                (InterventionRow.assigned_to_id.is_(None)) & (InterventionRow.user_id == user.id),
            ),
        )
    ) or 0
    server_time = datetime.now(timezone.utc)
    return {
        "machine": machine_dict(machine, latest, server_time),
        "sensors": [sensor_dict(sensor) for sensor in sensors],
        "latest_measurement": (
            measurement_dict(latest, server_time, sensor_ids) if latest is not None else None
        ),
        "active_alerts": [
            alert_dict(row, machine, events.get(row.id)) for row in alerts
        ],
        "active_intervention_count": active_intervention_count,
    }


@router.get("/machines")
def machines(user: UserRow = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(MachineRow).order_by(MachineRow.name)
    if user.role == "technician":
        stmt = (
            stmt.join(
                MachineTechnicianAccessRow,
                MachineTechnicianAccessRow.machine_id == MachineRow.id,
            )
            .where(
                MachineTechnicianAccessRow.technician_id == user.id,
                MachineRow.active.is_(True),
            )
        )
    elif user.role != "manager":
        stmt = stmt.where(MachineRow.active.is_(True))
    machine_rows = db.scalars(stmt).all()
    machine_ids = [row.id for row in machine_rows]
    latest_by_machine = {}
    if machine_ids:
        ranked_measurements = (
            select(
                MeasurementRow.id.label("measurement_id"),
                func.row_number().over(
                    partition_by=MeasurementRow.machine_id,
                    order_by=(
                        desc(MeasurementRow.recorded_at),
                        desc(MeasurementRow.id),
                    ),
                ).label("measurement_rank"),
            )
            .where(MeasurementRow.machine_id.in_(machine_ids))
            .subquery()
        )
        measurements = db.scalars(
            select(MeasurementRow)
            .join(ranked_measurements, ranked_measurements.c.measurement_id == MeasurementRow.id)
            .where(ranked_measurements.c.measurement_rank == 1)
        ).all()
        for measurement in measurements:
            latest_by_machine[measurement.machine_id] = measurement
    server_time = datetime.now(timezone.utc)
    return [
        machine_dict(row, latest_by_machine.get(row.id), server_time)
        for row in machine_rows
    ]


@router.post("/machines", status_code=status.HTTP_201_CREATED)
def create_machine(
    data: MachineCreate,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    if db.get(MachineRow, data.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Cet identifiant de machine existe déjà")
    row = MachineRow(id=data.id, name=data.name, description=data.description, status="offline", active=True)
    db.add(row)
    db.commit()
    db.refresh(row)
    return machine_dict(row)


@router.put("/machines/{machine_id}")
def update_machine(
    machine_id: str,
    data: MachineUpdate,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    row = db.get(MachineRow, machine_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    row.name, row.description, row.active = data.name, data.description, data.active
    if not row.active:
        row.status = "offline"
    db.commit()
    db.refresh(row)
    return machine_dict(row)


@router.get("/machines/{machine_id}/sensors")
def list_sensors(
    machine_id: str,
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_machine_access(db, user, machine_id)
    rows = db.scalars(select(SensorRow).where(SensorRow.machine_id == machine_id).order_by(SensorRow.id)).all()
    return [sensor_dict(row) for row in rows]


def sensor_dict(row: SensorRow) -> dict:
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "metric": row.metric,
        "sensor_type": row.sensor_type,
        "gpio": row.gpio,
        "unit": row.unit,
        "enabled": row.enabled,
        "created_at": row.created_at,
    }


@router.get("/machines/{machine_id}/technicians")
def machine_technicians(
    machine_id: str,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    if db.get(MachineRow, machine_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    rows = db.execute(
        select(UserRow.id, UserRow.full_name, UserRow.email)
        .join(MachineTechnicianAccessRow, MachineTechnicianAccessRow.technician_id == UserRow.id)
        .where(MachineTechnicianAccessRow.machine_id == machine_id)
        .order_by(UserRow.full_name)
    ).all()
    return [{"id": row.id, "full_name": row.full_name, "email": row.email} for row in rows]


@router.post("/machines/{machine_id}/sensors", status_code=status.HTTP_201_CREATED)
def create_sensor(
    machine_id: str,
    data: SensorCreate,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    if db.get(MachineRow, machine_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    existing = db.scalar(
        select(SensorRow.id).where(
            SensorRow.machine_id == machine_id,
            SensorRow.metric == data.metric,
        )
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Un capteur est déjà déclaré pour cette grandeur")
    row = SensorRow(machine_id=machine_id, **data.model_dump(), enabled=True)
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Un capteur est déjà déclaré pour cette grandeur",
        ) from exc
    db.refresh(row)
    return sensor_dict(row)


@router.patch("/sensors/{sensor_id}")
def update_sensor(
    sensor_id: int,
    data: SensorUpdate,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    row = db.get(SensorRow, sensor_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Capteur introuvable")
    values = data.model_dump(exclude_unset=True)
    if values.get("enabled") is True and db.scalar(
        select(SensorRow.id).where(
            SensorRow.machine_id == row.machine_id,
            SensorRow.metric == row.metric,
            SensorRow.enabled.is_(True),
            SensorRow.id != row.id,
        )
    ) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Un capteur actif existe déjà pour cette grandeur",
        )
    for key, value in values.items():
        setattr(row, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Un capteur actif existe déjà pour cette grandeur",
        ) from exc
    db.refresh(row)
    return sensor_dict(row)


@router.delete("/machines/{machine_id}", status_code=status.HTTP_200_OK)
def archive_machine(
    machine_id: str,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    row = db.get(MachineRow, machine_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    row.active, row.status = False, "offline"
    db.commit()
    return machine_dict(row)


@router.get("/machines/{machine_id}/telemetry")
def telemetry(
    machine_id: str,
    limit: int = Query(100, ge=1, le=1000),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    acquisition_mode: Literal["hardware", "simulated"] | None = Query(None),
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_machine_access(db, user, machine_id)
    if start and end and start >= end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "La période sélectionnée est invalide")
    stmt = select(MeasurementRow).where(MeasurementRow.machine_id == machine_id)
    if start:
        stmt = stmt.where(MeasurementRow.recorded_at >= start)
    if end:
        stmt = stmt.where(MeasurementRow.recorded_at <= end)
    if acquisition_mode is not None:
        stmt = stmt.where(MeasurementRow.acquisition_mode == acquisition_mode)
    rows = db.scalars(
        stmt.order_by(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id)).limit(limit)
    ).all()
    server_time = datetime.now(timezone.utc)
    ordered_rows = list(reversed(rows))
    sources_by_measurement: dict[int, dict[str, int]] = {}
    if ordered_rows:
        source_rows = db.scalars(
            select(MeasurementSensorSourceRow).where(
                MeasurementSensorSourceRow.measurement_id.in_([row.id for row in ordered_rows])
            )
        ).all()
        for source in source_rows:
            sources_by_measurement.setdefault(source.measurement_id, {})[source.metric] = source.sensor_id
    return [
        measurement_dict(row, server_time, sources_by_measurement.get(row.id, {}))
        for row in ordered_rows
    ]


def measurement_dict(
    row: MeasurementRow,
    server_time: datetime | None = None,
    sensor_ids: dict[str, int] | None = None,
) -> dict:
    server_time = server_time or datetime.now(timezone.utc)
    recorded_at = row.recorded_at
    if recorded_at.tzinfo is None:
        recorded_at = recorded_at.replace(tzinfo=timezone.utc)
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "seq": row.seq,
        "temperature": row.temperature,
        "humidity": row.humidity,
        "vibration_rate": row.vibration_rate,
        "vibration_edges": row.vibration_edges,
        "current_rms": row.current_rms,
        "current_source": row.current_source,
        "acquisition_mode": row.acquisition_mode,
        "sensor_ids": sensor_ids or {},
        "recorded_at": row.recorded_at,
        "received_at": row.received_at,
        "server_time": server_time,
        "age_seconds": max(0, (server_time - recorded_at).total_seconds()),
    }


@router.get("/alerts")
def alerts(
    status_filter: Literal["new", "acknowledged", "closed", "false_positive"] | None = Query(None, alias="status"),
    acquisition_mode: Literal["hardware", "simulated", "unknown"] | None = Query(None),
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    stmt = select(AlertRow).order_by(desc(AlertRow.created_at)).limit(300)
    if user.role == "technician":
        stmt = stmt.where(
            AlertRow.machine_id.in_(
                select(MachineTechnicianAccessRow.machine_id).where(
                    MachineTechnicianAccessRow.technician_id == user.id
                )
            )
        )
    if status_filter:
        stmt = stmt.where(AlertRow.status == status_filter)
    if acquisition_mode in ("hardware", "simulated"):
        stmt = stmt.where(AlertRow.acquisition_mode == acquisition_mode)
    elif acquisition_mode == "unknown":
        stmt = stmt.where(AlertRow.acquisition_mode.is_(None))
    rows = db.scalars(stmt.order_by(desc(AlertRow.created_at), desc(AlertRow.id))).all()
    events = alert_creation_events(db, [row.id for row in rows])
    return [
        alert_dict(row, db.get(MachineRow, row.machine_id), events.get(row.id))
        for row in rows
    ]


@router.post("/telemetry/{machine_id}", status_code=status.HTTP_202_ACCEPTED)
def ingest_http(
    machine_id: str,
    data: MeasurementInput,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    """Authenticated manual ingestion endpoint, intended for commissioning and tests."""
    try:
        row = SqlMeasurementRepository(db).receive(machine_id, data)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return {"accepted": True, "measurement_id": row.id}


@router.post("/alerts/{alert_id}/acknowledge")
def acknowledge(
    alert_id: int,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    row = db.get(AlertRow, alert_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alerte introuvable")
    require_machine_access(db, user, row.machine_id)
    if row.status == "new":
        row.status = "acknowledged"
        row.acknowledged_by_id = user.id
        row.acknowledged_at = datetime.now(timezone.utc)
        db.add(AlertEventRow(alert_id=row.id, user_id=user.id, action="acknowledged"))
    db.commit()
    return {
        "id": row.id,
        "status": row.status,
        "acknowledged_by_id": row.acknowledged_by_id,
        "acknowledged_at": row.acknowledged_at,
    }


@router.get("/alerts/{alert_id}/history")
def alert_history(
    alert_id: int,
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    alert = db.get(AlertRow, alert_id)
    if alert is None or not can_access_machine(db, user, alert.machine_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alerte introuvable")
    rows = db.scalars(
        select(AlertEventRow)
        .where(AlertEventRow.alert_id == alert.id)
        .order_by(AlertEventRow.created_at, AlertEventRow.id)
    ).all()
    return [
        {
            "id": row.id,
            "action": row.action,
            "details": row.details,
            "user_name": (db.get(UserRow, row.user_id).full_name if row.user_id and db.get(UserRow, row.user_id) else ""),
            "created_at": row.created_at,
            "source_measurement_id": row.source_measurement_id,
            "processing_delay_ms": row.processing_delay_ms,
        }
        for row in rows
    ]


@router.post("/alerts/{alert_id}/close")
def close_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    row = db.get(AlertRow, alert_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alerte introuvable")
    require_machine_access(db, user, row.machine_id)
    if row.status not in {"closed", "false_positive"}:
        row.status, row.closed_at = "closed", datetime.now(timezone.utc)
        db.add(AlertEventRow(alert_id=row.id, user_id=user.id, action="closed"))
        failure = db.scalar(
            select(MaintenanceFailureRow).where(MaintenanceFailureRow.alert_id == row.id)
        )
        if failure is not None and failure.resolved_at is None:
            failure.resolved_at = row.closed_at
    db.commit()
    return {"id": row.id, "status": row.status}


@router.post("/machines/{machine_id}/interventions", status_code=status.HTTP_201_CREATED)
def add_intervention(
    machine_id: str,
    data: InterventionInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    require_machine_access(db, user, machine_id)
    if data.alert_id is not None:
        alert = db.get(AlertRow, data.alert_id)
        if alert is None or alert.machine_id != machine_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "L'alerte ne correspond pas à cette machine")
    row = InterventionRow(
        machine_id=machine_id,
        user_id=user.id,
        assigned_to_id=user.id if user.role == "technician" else None,
        title="Compte rendu d'intervention",
        status="completed",
        work_done=data.description,
        resolved_at=datetime.now(timezone.utc),
        **data.model_dump(),
    )
    db.add(row)
    if user.role == "technician":
        grant_machine_access(db, machine_id, user.id, user.id)
    db.commit()
    db.refresh(row)
    return intervention_dict(row, db)


@router.get("/technicians")
def available_technicians(
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    rows = db.scalars(
        select(UserRow).where(UserRow.role == "technician", UserRow.active.is_(True)).order_by(UserRow.full_name)
    ).all()
    return [{"id": row.id, "full_name": row.full_name, "email": row.email} for row in rows]


@router.post("/interventions", status_code=status.HTTP_201_CREATED)
def assign_intervention(
    data: InterventionAssignmentInput,
    db: Session = Depends(get_db),
    manager: UserRow = Depends(require_roles(*MANAGERS)),
):
    machine = db.get(MachineRow, data.machine_id)
    if machine is None or not machine.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou archivée")
    technician = db.get(UserRow, data.assigned_to_id)
    if technician is None or technician.role != "technician" or not technician.active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le compte sélectionné n'est pas un technicien actif")
    if data.alert_id is not None:
        alert = db.get(AlertRow, data.alert_id)
        if alert is None or alert.machine_id != data.machine_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "L'alerte ne correspond pas à cette machine")
    confirmed_failure = None
    if data.failure_id is not None:
        confirmed_failure = db.get(ManagerFailureRow, data.failure_id)
        if (
            confirmed_failure is None
            or confirmed_failure.machine_id != data.machine_id
            or confirmed_failure.resolved_at is not None
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "La panne sélectionnée est introuvable, clôturée ou liée à une autre machine.",
            )
    row = InterventionRow(
        machine_id=data.machine_id,
        alert_id=data.alert_id,
        user_id=manager.id,
        assigned_to_id=technician.id,
        title=data.title.strip(),
        description=data.description.strip(),
        priority=data.priority,
        status="assigned",
        due_at=data.due_at,
        updated_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    if confirmed_failure is not None:
        confirmed_failure.intervention_id = row.id
    grant_machine_access(db, machine.id, technician.id, manager.id)
    notification = add_technician_notification(
        db,
        technician.id,
        f"intervention-assigned:{row.id}:{row.revision}",
        "intervention_assigned",
        f"Une intervention vous a été attribuée : {row.title}.",
        "intervention",
        str(row.id),
    )
    db.commit()
    dispatch_web_push(db, [notification] if notification is not None else [])
    db.refresh(row)
    return intervention_dict(row, db)


@router.get("/interventions")
def list_interventions(
    machine_id: str | None = Query(None, min_length=2, max_length=80),
    status_filter: str | None = Query(None, alias="status"),
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    if user.role not in ("technician", "manager", "director", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Permission insuffisante")
    stmt = select(InterventionRow).order_by(desc(InterventionRow.created_at))
    if user.role != "technician":
        stmt = stmt.limit(300)
    if user.role == "technician":
        stmt = stmt.where(
            or_(
                InterventionRow.assigned_to_id == user.id,
                (InterventionRow.assigned_to_id.is_(None)) & (InterventionRow.user_id == user.id),
            )
        ).join(
            MachineTechnicianAccessRow,
            MachineTechnicianAccessRow.machine_id == InterventionRow.machine_id,
        ).where(
            MachineTechnicianAccessRow.technician_id == user.id,
            MachineRow.active.is_(True),
        ).join(MachineRow, MachineRow.id == InterventionRow.machine_id)
    if machine_id:
        if user.role == "technician" and not can_access_machine(db, user, machine_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou non autorisée")
        stmt = stmt.where(InterventionRow.machine_id == machine_id)
    if status_filter:
        if status_filter not in INTERVENTION_STATUSES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Statut d'intervention non reconnu")
        stmt = stmt.where(InterventionRow.status == status_filter)
    return [intervention_dict(row, db) for row in db.scalars(stmt).all()]


def require_intervention_access(
    db: Session,
    user: UserRow,
    intervention_id: int,
) -> InterventionRow:
    row = db.get(InterventionRow, intervention_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intervention introuvable")
    if user.role == "technician":
        is_assignee = row.assigned_to_id == user.id or (
            row.assigned_to_id is None and row.user_id == user.id
        )
        if not is_assignee or not can_access_machine(db, user, row.machine_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Intervention introuvable")
    return row


def intervention_photo_dict(row: InterventionPhotoRow) -> dict:
    return {
        "id": row.id,
        "intervention_id": row.intervention_id,
        "original_name": row.original_name,
        "content_type": row.content_type,
        "size_bytes": row.size_bytes,
        "uploaded_by_id": row.uploaded_by_id,
        "created_at": row.created_at,
    }


def image_type(header: bytes) -> tuple[str, str] | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


@router.post("/interventions/{intervention_id}/photos", status_code=status.HTTP_201_CREATED)
async def upload_intervention_photo(
    intervention_id: int,
    photo: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    require_intervention_access(db, user, intervention_id)
    await photo.seek(0)
    kind = image_type(await photo.read(12))
    await photo.seek(0)
    if kind is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Format non accepté. Utilisez une image JPEG, PNG ou WebP.",
        )
    content_type, extension = kind
    directory = Path(settings.intervention_photo_directory)
    temporary_path: Path | None = None
    stored_path: Path | None = None
    committed = False
    try:
        directory.mkdir(parents=True, exist_ok=True)
        storage_name = f"{uuid.uuid4().hex}.{extension}"
        temporary_path = directory / f".{storage_name}.tmp"
        stored_path = directory / storage_name
        size_bytes = 0
        with temporary_path.open("xb") as destination:
            while chunk := await photo.read(64 * 1024):
                size_bytes += len(chunk)
                if size_bytes > MAX_INTERVENTION_PHOTO_BYTES:
                    raise HTTPException(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        "La photo ne peut pas dépasser 8 Mio.",
                    )
                destination.write(chunk)
        if size_bytes == 0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le fichier est vide.")
        temporary_path.replace(stored_path)
        original_name = re.split(r"[\\/]", photo.filename or "photo")[-1]
        original_name = "".join(char for char in original_name if char.isprintable())[:255] or "photo"
        row = InterventionPhotoRow(
            intervention_id=intervention_id,
            uploaded_by_id=user.id,
            storage_name=storage_name,
            original_name=original_name,
            content_type=content_type,
            size_bytes=size_bytes,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        committed = True
        return intervention_photo_dict(row)
    except HTTPException:
        raise
    except (OSError, SQLAlchemyError):
        db.rollback()
        logger.exception("Échec du stockage d'une photo d'intervention (intervention_id=%s)", intervention_id)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "La photo n'a pas pu être enregistrée.",
        )
    finally:
        if not committed:
            for path in (temporary_path, stored_path):
                if path is not None and path.exists():
                    try:
                        path.unlink()
                    except OSError:
                        logger.exception(
                            "Impossible de nettoyer un fichier photo temporaire (intervention_id=%s)",
                            intervention_id,
                        )


@router.get("/interventions/{intervention_id}/photos")
def list_intervention_photos(
    intervention_id: int,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    require_intervention_access(db, user, intervention_id)
    rows = db.scalars(
        select(InterventionPhotoRow)
        .where(InterventionPhotoRow.intervention_id == intervention_id)
        .order_by(InterventionPhotoRow.created_at, InterventionPhotoRow.id)
    ).all()
    return [intervention_photo_dict(row) for row in rows]


@router.get("/interventions/{intervention_id}/photos/{photo_id}")
def download_intervention_photo(
    intervention_id: int,
    photo_id: int,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    require_intervention_access(db, user, intervention_id)
    row = db.get(InterventionPhotoRow, photo_id)
    if row is None or row.intervention_id != intervention_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo introuvable")
    if not re.fullmatch(r"[0-9a-f]{32}\.(jpg|png|webp)", row.storage_name):
        logger.error("Nom de stockage photo invalide (photo_id=%s)", row.id)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo introuvable")
    path = Path(settings.intervention_photo_directory) / row.storage_name
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fichier photo indisponible")
    return FileResponse(
        path,
        media_type=row.content_type,
        headers={
            "Content-Disposition": f'inline; filename="{row.storage_name}"',
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, no-store",
        },
    )


@router.patch("/interventions/{intervention_id}")
def update_intervention(
    intervention_id: int,
    data: InterventionUpdate,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    row = db.get(InterventionRow, intervention_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intervention introuvable")
    if user.role == "technician" and (
        row.assigned_to_id != user.id
        and not (row.assigned_to_id is None and row.user_id == user.id)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intervention introuvable")
    if user.role == "technician" and not can_access_machine(db, user, row.machine_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intervention introuvable")

    values = data.model_dump(exclude_unset=True)
    client_action_id = values.pop("client_action_id", None)
    expected_revision = values.pop("expected_revision", None)
    if any(
        key in values and values[key] is None
        for key in ("status", "diagnosis", "work_done", "result", "title", "description", "priority")
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Les champs de suivi ne peuvent pas être nuls")
    if client_action_id:
        previous_action = db.scalar(
            select(AppliedOfflineActionRow).where(
                AppliedOfflineActionRow.user_id == user.id,
                AppliedOfflineActionRow.client_action_id == client_action_id,
            )
        )
        if previous_action:
            return intervention_dict(db.get(InterventionRow, previous_action.intervention_id), db)
    if expected_revision is not None and expected_revision != row.revision:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cette intervention a été modifiée depuis la dernière synchronisation. Actualisez-la avant de réessayer.",
        )

    if user.role == "technician":
        forbidden = set(values) - {"status", "diagnosis", "work_done", "result"}
        if forbidden:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Vous ne pouvez modifier que le suivi de votre intervention")
        if values.get("status") == "completed" and not values.get("work_done", row.work_done).strip():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Renseignez le travail réalisé avant de terminer l'intervention",
            )
        if "status" in values:
            allowed_transitions = {
                "assigned": {"accepted", "in_progress"},
                "accepted": {"in_progress", "completed"},
                "in_progress": {"completed"},
                "completed": set(),
                "cancelled": set(),
            }
            target_status = values["status"]
            if target_status != row.status and target_status not in allowed_transitions[row.status]:
                raise HTTPException(status.HTTP_409_CONFLICT, "Cette transition de statut n'est pas autorisée")
    else:
        assigned_to_id = values.get("assigned_to_id")
        if assigned_to_id is not None:
            technician = db.get(UserRow, assigned_to_id)
            if technician is None or technician.role != "technician" or not technician.active:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le compte sélectionné n'est pas un technicien actif")
            grant_machine_access(db, row.machine_id, technician.id, user.id)
            values["assigned_to_id"] = technician.id

    status_changed = values.get("status") is not None and values["status"] != row.status
    now = datetime.now(timezone.utc)
    persisted_values = dict(values)
    persisted_values["updated_at"] = now
    persisted_values["revision"] = InterventionRow.revision + 1
    if status_changed:
        persisted_values["resolved_at"] = now if values["status"] in {"completed", "cancelled"} else None
    changed = db.execute(
        update(InterventionRow)
        .where(
            InterventionRow.id == row.id,
            InterventionRow.revision == row.revision,
        )
        .values(**persisted_values)
        .execution_options(synchronize_session=False)
    )
    if changed.rowcount != 1:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cette intervention a été modifiée depuis la dernière synchronisation. Actualisez-la avant de réessayer.",
        )
    db.refresh(row)
    notification = None
    if row.assigned_to_id:
        notification = add_technician_notification(
            db,
            row.assigned_to_id,
            f"intervention-updated:{row.id}:{row.revision}",
            "intervention_updated",
            f"Le suivi de l'intervention « {row.title} » a été mis à jour.",
            "intervention",
            str(row.id),
        )
    if client_action_id:
        db.add(
            AppliedOfflineActionRow(
                user_id=user.id,
                client_action_id=client_action_id,
                intervention_id=row.id,
            )
        )
    db.commit()
    dispatch_web_push(db, [notification] if notification is not None else [])
    db.refresh(row)
    return intervention_dict(row, db)


@router.get("/technician/overview")
def technician_overview(
    acquisition_mode: Literal["hardware", "simulated"] | None = Query(None),
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles("technician")),
):
    machine_ids = select(MachineTechnicianAccessRow.machine_id).where(
        MachineTechnicianAccessRow.technician_id == user.id
    )
    machines_rows = db.scalars(
        select(MachineRow).where(MachineRow.id.in_(machine_ids), MachineRow.active.is_(True))
    ).all()
    alert_count_stmt = (
        select(func.count())
        .select_from(AlertRow)
        .where(AlertRow.machine_id.in_(machine_ids), AlertRow.status.not_in(("closed", "false_positive")))
    )
    latest_stmt = (
        select(MeasurementRow)
        .where(MeasurementRow.machine_id.in_(machine_ids))
    )
    if acquisition_mode is not None:
        alert_count_stmt = alert_count_stmt.where(AlertRow.acquisition_mode == acquisition_mode)
        latest_stmt = latest_stmt.where(MeasurementRow.acquisition_mode == acquisition_mode)
    active_alerts = db.scalar(alert_count_stmt) or 0
    active_interventions = db.scalar(
        select(func.count()).select_from(InterventionRow).where(
            InterventionRow.assigned_to_id == user.id,
            InterventionRow.status.in_(("assigned", "accepted", "in_progress")),
        )
    ) or 0
    overdue_interventions = db.scalar(
        select(func.count()).select_from(InterventionRow).where(
            InterventionRow.assigned_to_id == user.id,
            InterventionRow.status.in_(("assigned", "accepted", "in_progress")),
            InterventionRow.due_at < datetime.now(timezone.utc),
        )
    ) or 0
    latest = db.scalar(
        latest_stmt.order_by(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id)).limit(1)
    )
    server_time = datetime.now(timezone.utc)
    return {
        "server_time": server_time,
        "machine_count": len(machines_rows),
        "online_count": sum(machine.status == "online" for machine in machines_rows),
        "active_alert_count": active_alerts,
        "active_intervention_count": active_interventions,
        "overdue_intervention_count": overdue_interventions,
        "latest": measurement_dict(latest, server_time) if latest else None,
    }


@router.put("/machines/{machine_id}/technicians/{technician_id}")
def authorize_technician_for_machine(
    machine_id: str,
    technician_id: int,
    db: Session = Depends(get_db),
    manager: UserRow = Depends(require_roles(*MANAGERS)),
):
    machine = db.get(MachineRow, machine_id)
    if machine is None or not machine.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou archivée")
    grant_machine_access(db, machine_id, technician_id, manager.id)
    db.commit()
    return {"machine_id": machine_id, "technician_id": technician_id, "authorized": True}


@router.delete("/machines/{machine_id}/technicians/{technician_id}")
def revoke_technician_for_machine(
    machine_id: str,
    technician_id: int,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    access = db.scalar(
        select(MachineTechnicianAccessRow).where(
            MachineTechnicianAccessRow.machine_id == machine_id,
            MachineTechnicianAccessRow.technician_id == technician_id,
        )
    )
    if access is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Autorisation introuvable")
    db.delete(access)
    db.commit()
    return {"machine_id": machine_id, "technician_id": technician_id, "authorized": False}


@router.get("/failures")
def list_failures(
    machine_id: str | None = Query(None, min_length=2, max_length=80),
    failure_type: Literal["temperature", "humidity", "vibration_rate", "current_rms"] | None = None,
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    if start and end and start >= end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "La période sélectionnée est invalide")
    stmt = select(MaintenanceFailureRow).order_by(desc(MaintenanceFailureRow.detected_at)).limit(300)
    if user.role == "technician":
        stmt = stmt.where(
            MaintenanceFailureRow.machine_id.in_(
                select(MachineTechnicianAccessRow.machine_id).where(
                    MachineTechnicianAccessRow.technician_id == user.id
                )
            )
        )
    if machine_id:
        if not can_access_machine(db, user, machine_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou non autorisée")
        stmt = stmt.where(MaintenanceFailureRow.machine_id == machine_id)
    if failure_type:
        stmt = stmt.where(MaintenanceFailureRow.failure_type == failure_type)
    if start:
        stmt = stmt.where(MaintenanceFailureRow.detected_at >= start)
    if end:
        stmt = stmt.where(MaintenanceFailureRow.detected_at <= end)
    return [failure_dict(row) for row in db.scalars(stmt).all()]


@router.patch("/failures/{failure_id}")
def update_failure(
    failure_id: int,
    data: FailureUpdate,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    row = db.get(MaintenanceFailureRow, failure_id)
    if row is None or not can_access_machine(db, user, row.machine_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Événement introuvable")
    for key, value in data.model_dump().items():
        setattr(row, key, value.strip())
    db.commit()
    db.refresh(row)
    return failure_dict(row)


@router.get("/calibrations")
def list_calibrations(
    machine_id: str | None = Query(None, min_length=2, max_length=80),
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    stmt = select(CalibrationRecordRow).order_by(desc(CalibrationRecordRow.created_at)).limit(300)
    if user.role == "technician":
        stmt = stmt.where(
            CalibrationRecordRow.machine_id.in_(
                select(MachineTechnicianAccessRow.machine_id).where(
                    MachineTechnicianAccessRow.technician_id == user.id
                )
            )
        )
    if machine_id:
        if not can_access_machine(db, user, machine_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou non autorisée")
        stmt = stmt.where(CalibrationRecordRow.machine_id == machine_id)
    rows = db.scalars(stmt).all()
    return [
        {
            "id": row.id,
            "machine_id": row.machine_id,
            "sensor_id": row.sensor_id,
            "technician_id": row.technician_id,
            "reference_value": row.reference_value,
            "measured_value": row.measured_value,
            "observations": row.observations,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.post("/calibrations", status_code=status.HTTP_201_CREATED)
def create_calibration(
    data: CalibrationInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles(*MAINTENANCE)),
):
    require_machine_access(db, user, data.machine_id)
    sensor = db.get(SensorRow, data.sensor_id)
    if sensor is None or sensor.machine_id != data.machine_id or not sensor.enabled:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le capteur ne correspond pas à la machine active")
    row = CalibrationRecordRow(
        machine_id=data.machine_id,
        sensor_id=data.sensor_id,
        technician_id=user.id,
        reference_value=data.reference_value,
        measured_value=data.measured_value,
        observations=data.observations.strip(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "sensor_id": row.sensor_id,
        "technician_id": row.technician_id,
        "reference_value": row.reference_value,
        "measured_value": row.measured_value,
        "observations": row.observations,
        "created_at": row.created_at,
    }


@router.get("/notifications")
def list_user_notifications(
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    now = datetime.now(timezone.utc)
    reminders = db.scalars(
        select(InterventionRow).where(
            InterventionRow.assigned_to_id == user.id,
            InterventionRow.status.in_(("assigned", "accepted", "in_progress")),
            InterventionRow.due_at.is_not(None),
            InterventionRow.due_at <= now + timedelta(hours=24),
            InterventionRow.due_at >= now,
        )
    ).all()
    reminder_notifications = []
    for intervention in reminders:
        due_day = _utc(intervention.due_at).date().isoformat()
        notification = add_technician_notification(
            db,
            user.id,
            f"intervention-due:{intervention.id}:{due_day}",
            "due_reminder",
            f"L’échéance de l’intervention « {intervention.title} » approche.",
            "intervention",
            str(intervention.id),
        )
        if notification is not None:
            reminder_notifications.append(notification)
    if reminders:
        db.commit()
        dispatch_web_push(db, reminder_notifications)
    account_rows = db.scalars(
        select(UserNotificationRow)
        .where(UserNotificationRow.user_id == user.id)
        .order_by(desc(UserNotificationRow.created_at))
        .limit(100)
    ).all()
    technician_rows = db.scalars(
        select(TechnicianNotificationRow)
        .where(TechnicianNotificationRow.user_id == user.id)
        .order_by(desc(TechnicianNotificationRow.created_at))
        .limit(100)
    ).all()
    combined = [
        {
            "id": f"account-{row.id}",
            "type": "account_update",
            "message": row.message,
            "target_type": "",
            "target_id": "",
            "created_at": row.created_at,
            "push_sent_at": None,
            "received_at": None,
            "delivery_delay_ms": None,
            "read": row.read_at is not None,
        }
        for row in account_rows
    ] + [
        {
            "id": f"technician-{row.id}",
            "type": row.notification_type,
            "message": row.message,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "created_at": row.created_at,
            "push_sent_at": row.push_sent_at,
            "received_at": row.received_at,
            "delivery_delay_ms": (
                max(0, int((_utc(row.received_at) - _utc(row.created_at)).total_seconds() * 1000))
                if row.received_at is not None
                else None
            ),
            "read": row.read_at is not None,
        }
        for row in technician_rows
    ]
    return sorted(combined, key=lambda row: row["created_at"], reverse=True)


@router.get("/notifications/push/vapid-key")
def push_vapid_key(_: UserRow = Depends(require_roles("technician"))):
    enabled = web_push_is_configured()
    return {
        "enabled": enabled,
        "public_key": settings.web_push_vapid_public_key if enabled else None,
    }


@router.post("/notifications/push/subscriptions", status_code=status.HTTP_201_CREATED)
def create_push_subscription(
    data: PushSubscriptionInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles("technician")),
):
    if not web_push_is_configured():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Les notifications Push ne sont pas configurées sur ce serveur",
        )
    existing = db.scalar(
        select(PushSubscriptionRow).where(PushSubscriptionRow.endpoint == data.endpoint)
    )
    if existing is not None and existing.user_id != user.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cette inscription Push est déjà associée à un autre compte",
        )
    if existing is None:
        db.add(
            PushSubscriptionRow(
                user_id=user.id,
                endpoint=data.endpoint,
                p256dh=data.p256dh,
                auth=data.auth,
            )
        )
    else:
        existing.p256dh = data.p256dh
        existing.auth = data.auth
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cette inscription Push existe déjà.",
        ) from exc
    return {"subscribed": True}


@router.delete("/notifications/push/subscriptions")
def delete_push_subscription(
    data: PushSubscriptionDeleteInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles("technician")),
):
    existing = db.scalar(
        select(PushSubscriptionRow).where(
            PushSubscriptionRow.endpoint == data.endpoint,
            PushSubscriptionRow.user_id == user.id,
        )
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
    return {"subscribed": False}


@router.post("/notifications/received")
def record_notification_receipt(
    data: NotificationReceiptInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(require_roles("technician")),
):
    rows = db.scalars(
        select(TechnicianNotificationRow).where(
            TechnicianNotificationRow.id.in_(data.notification_ids),
            TechnicianNotificationRow.user_id == user.id,
            TechnicianNotificationRow.received_at.is_(None),
        )
    ).all()
    received_at = datetime.now(timezone.utc)
    for row in rows:
        row.received_at = received_at
    if rows:
        db.commit()
    return {"recorded": len(rows), "received_at": received_at}


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: str,
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    try:
        source, raw_id = notification_id.split("-", 1)
        row_id = int(raw_id)
    except (ValueError, AttributeError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification introuvable")
    if source == "account":
        row = db.get(UserNotificationRow, row_id)
    elif source == "technician":
        row = db.get(TechnicianNotificationRow, row_id)
    else:
        row = None
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification introuvable")
    if row.read_at is None:
        row.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"id": notification_id, "read": True}


@router.get("/profile")
def get_user_profile(user: UserRow = Depends(current_user)):
    return {
        "id": user.id,
        "full_name": user.full_name,
        "email": user.email,
        "phone": user.phone,
        "role": user.role,
    }


@router.patch("/profile")
def update_user_profile(
    data: ProfileInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    email = data.email.strip().lower()
    duplicate = db.scalar(select(UserRow).where(UserRow.email == email, UserRow.id != user.id))
    if duplicate:
        raise HTTPException(status.HTTP_409_CONFLICT, "Cette adresse e-mail est déjà utilisée")
    user.full_name = data.full_name.strip()
    user.email = email
    user.phone = data.phone.strip()
    db.commit()
    db.refresh(user)
    return get_user_profile(user)


@router.post("/profile/password")
def change_user_password(
    data: ProfilePasswordInput,
    db: Session = Depends(get_db),
    user: UserRow = Depends(current_user),
):
    if not password_hash.verify(data.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Le mot de passe actuel est incorrect")
    user.password_hash = hash_password(data.new_password)
    user.token_version += 1
    notification = UserNotificationRow(
        user_id=user.id,
        email_to=user.email,
        message="Le mot de passe de votre compte PrediMaint a été modifié.",
        delivery_status="pending",
    )
    db.add(notification)
    db.commit()
    delivery_status, delivery_error = send_email(
        user.email,
        "Mot de passe modifié — PrediMaint",
        "Bonjour,\n\nLe mot de passe de votre compte PrediMaint a été modifié. "
        "Si vous n'êtes pas à l'origine de cette opération, contactez votre administrateur.\n",
    )
    notification.delivery_status = delivery_status
    notification.delivery_error = delivery_error
    db.commit()
    return {"updated": True, "sessions_revoked": True}


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _generic_reset_response() -> dict:
    return {
        "message": "Si cette adresse correspond à un compte actif, un lien de réinitialisation sera envoyé.",
    }


@router.post("/auth/password-reset/request")
def request_password_reset(
    data: PasswordResetRequestInput,
    request: Request,
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    email = data.email.strip().lower()
    ip_address = request.client.host if request.client else "unknown"
    email_hash = _digest(email)
    ip_hash = _digest(ip_address)
    db.execute(
        delete(PasswordResetAttemptRow).where(
            PasswordResetAttemptRow.requested_at < now - timedelta(days=1)
        )
    )
    recent_email_requests = db.scalar(
        select(func.count()).select_from(PasswordResetAttemptRow).where(
            PasswordResetAttemptRow.email_hash == email_hash,
            PasswordResetAttemptRow.requested_at >= now - RESET_WINDOW,
        )
    ) or 0
    recent_ip_requests = db.scalar(
        select(func.count()).select_from(PasswordResetAttemptRow).where(
            PasswordResetAttemptRow.ip_hash == ip_hash,
            PasswordResetAttemptRow.requested_at >= now - RESET_WINDOW,
        )
    ) or 0
    db.add(PasswordResetAttemptRow(email_hash=email_hash, ip_hash=ip_hash, requested_at=now))
    db.commit()
    if recent_email_requests >= RESET_REQUEST_LIMIT or recent_ip_requests >= RESET_REQUEST_LIMIT:
        return _generic_reset_response()

    user = db.scalar(select(UserRow).where(UserRow.email == email, UserRow.active.is_(True)))
    if user is None:
        return _generic_reset_response()
    for old_token in db.scalars(
        select(PasswordResetTokenRow).where(
            PasswordResetTokenRow.user_id == user.id,
            PasswordResetTokenRow.used_at.is_(None),
        )
    ).all():
        old_token.used_at = now
    raw_token = secrets.token_urlsafe(32)
    db.add(
        PasswordResetTokenRow(
            user_id=user.id,
            token_hash=_digest(raw_token),
            expires_at=now + RESET_WINDOW,
        )
    )
    db.commit()
    reset_link = f"{settings.public_base_url.rstrip('/')}/#reset_token={raw_token}"
    delivery_status, _ = send_email(
        user.email,
        "Réinitialisation du mot de passe — PrediMaint",
        "Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien à usage unique "
        f"valable 15 minutes :\n{reset_link}\n\n"
        "Si vous n'avez pas demandé cette opération, ignorez ce message.",
    )
    if delivery_status == "failed":
        logger.warning("Password reset email delivery failed")
    return _generic_reset_response()


@router.post("/auth/password-reset/complete")
def complete_password_reset(
    data: PasswordResetCompleteInput,
    db: Session = Depends(get_db),
):
    if data.new_password != data.confirm_password:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Les nouveaux mots de passe ne correspondent pas")
    now = datetime.now(timezone.utc)
    token_row = db.scalar(
        select(PasswordResetTokenRow).where(
            PasswordResetTokenRow.token_hash == _digest(data.token),
            PasswordResetTokenRow.used_at.is_(None),
        )
    )
    if token_row is None or _utc(token_row.expires_at) <= now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Le lien est invalide ou a expiré")
    user = db.get(UserRow, token_row.user_id)
    if user is None or not user.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Le lien est invalide ou a expiré")
    claimed = db.execute(
        update(PasswordResetTokenRow)
        .where(
            PasswordResetTokenRow.id == token_row.id,
            PasswordResetTokenRow.used_at.is_(None),
            PasswordResetTokenRow.expires_at > now,
        )
        .values(used_at=now)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Le lien est invalide ou a expiré")
    user.password_hash = hash_password(data.new_password)
    user.token_version += 1
    db.commit()
    send_email(
        user.email,
        "Mot de passe réinitialisé — PrediMaint",
        "Bonjour,\n\nLe mot de passe de votre compte PrediMaint vient d'être réinitialisé. "
        "Toutes les sessions précédentes ont été révoquées. Si vous n'êtes pas à l'origine de cette opération, "
        "contactez votre administrateur.",
    )
    return {"updated": True}


@router.get("/dashboard")
def dashboard(
    acquisition_mode: Literal["hardware", "simulated"] | None = Query(None),
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    machine_stmt = select(MachineRow)
    if user.role == "technician":
        machine_stmt = machine_stmt.join(
            MachineTechnicianAccessRow,
            MachineTechnicianAccessRow.machine_id == MachineRow.id,
        ).where(
            MachineTechnicianAccessRow.technician_id == user.id,
            MachineRow.active.is_(True),
        )
    elif user.role != "manager":
        machine_stmt = machine_stmt.where(MachineRow.active.is_(True))
    machines_rows = db.scalars(machine_stmt).all()
    alert_stmt = select(AlertRow).where(AlertRow.status.not_in(("closed", "false_positive")))
    latest_stmt = select(MeasurementRow)
    if user.role == "technician":
        accessible_ids = select(MachineTechnicianAccessRow.machine_id).where(
            MachineTechnicianAccessRow.technician_id == user.id
        )
        alert_stmt = alert_stmt.where(AlertRow.machine_id.in_(accessible_ids))
        latest_stmt = latest_stmt.where(MeasurementRow.machine_id.in_(accessible_ids))
    if acquisition_mode is not None:
        alert_stmt = alert_stmt.where(AlertRow.acquisition_mode == acquisition_mode)
        latest_stmt = latest_stmt.where(MeasurementRow.acquisition_mode == acquisition_mode)
    active_alerts = db.scalars(alert_stmt).all()
    latest = db.scalars(
        latest_stmt.order_by(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id)).limit(1)
    ).first()
    return {
        "server_time": datetime.now(timezone.utc),
        "role": user.role,
        "machine_count": len(machines_rows),
        "online_count": sum(row.status == "online" for row in machines_rows),
        "active_alert_count": len(active_alerts),
        "latest": measurement_dict(latest) if latest else None,
    }


@router.get("/thresholds/{machine_id}")
def get_thresholds(
    machine_id: str,
    user: UserRow = Depends(current_user),
    db: Session = Depends(get_db),
):
    require_machine_access(db, user, machine_id)
    rows = db.scalars(select(ThresholdRow).where(ThresholdRow.machine_id == machine_id)).all()
    return [
        {"metric": row.metric, "warning": row.warning, "critical": row.critical, "enabled": row.enabled}
        for row in rows
    ]


@router.put("/thresholds/{machine_id}/{metric}")
def set_threshold(
    machine_id: str,
    metric: str,
    data: ThresholdInput,
    db: Session = Depends(get_db),
    _: UserRow = Depends(require_roles(*MANAGERS)),
):
    if metric not in METRICS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Grandeur non reconnue")
    if data.warning >= data.critical:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Le seuil critique doit dépasser l'avertissement")
    if not db.get(MachineRow, machine_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable")
    row = db.scalar(
        select(ThresholdRow).where(ThresholdRow.machine_id == machine_id, ThresholdRow.metric == metric)
    )
    if row is None:
        row = ThresholdRow(machine_id=machine_id, metric=metric, warning=data.warning, critical=data.critical)
        db.add(row)
    row.warning, row.critical, row.enabled = data.warning, data.critical, data.enabled
    db.commit()
    return {
        "machine_id": machine_id,
        "metric": metric,
        "warning": row.warning,
        "critical": row.critical,
        "enabled": row.enabled,
    }
