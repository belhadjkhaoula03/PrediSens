from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.api.auth import current_user, get_db, require_roles
from app.infrastructure.models import (
    AlertRow,
    InterventionRow,
    MachineRow,
    MaintenanceFailureRow,
    UserRow,
)

router = APIRouter(prefix="/api/director", tags=["direction"])
director_only = require_roles("director")
MAX_REPORT_ROWS = 300


def _period(
    days: int,
    start: datetime | None,
    end: datetime | None,
) -> tuple[datetime, datetime]:
    if (start is None) != (end is None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Les dates de début et de fin doivent être fournies ensemble.",
        )

    if start is not None and end is not None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if start >= end:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "La date de début doit précéder la date de fin.",
            )
        return start, end

    end = datetime.now(timezone.utc)
    return end - timedelta(days=days), end


def _validate_machine(db: Session, machine_id: str | None) -> None:
    if machine_id is None:
        return
    machine = db.get(MachineRow, machine_id)
    if machine is None or not machine.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable.")


def _machine_scope(statement, machine_id: str | None):
    if machine_id is not None:
        statement = statement.where(MachineRow.id == machine_id)
    return statement


def _failure_scope(statement, machine_id: str | None):
    if machine_id is not None:
        statement = statement.where(MaintenanceFailureRow.machine_id == machine_id)
    return statement


def _intervention_scope(statement, machine_id: str | None):
    if machine_id is not None:
        statement = statement.where(InterventionRow.machine_id == machine_id)
    return statement


def _overview(
    db: Session,
    start: datetime,
    end: datetime,
    machine_id: str | None,
) -> dict:
    _validate_machine(db, machine_id)

    machines = db.scalars(
        _machine_scope(
            select(MachineRow)
            .where(MachineRow.active.is_(True))
            .order_by(MachineRow.name),
            machine_id,
        )
    ).all()
    active_alerts = db.scalar(
        _machine_scope(
            select(func.count(AlertRow.id))
            .join(MachineRow, MachineRow.id == AlertRow.machine_id)
            .where(MachineRow.active.is_(True), AlertRow.status != "closed"),
            machine_id,
        )
    ) or 0
    critical_events = db.scalar(
        _failure_scope(
            select(func.count(MaintenanceFailureRow.id)).where(
                MaintenanceFailureRow.detected_at >= start,
                MaintenanceFailureRow.detected_at < end,
            ),
            machine_id,
        )
    ) or 0
    intervention_statement = _intervention_scope(
        select(InterventionRow.status, func.count(InterventionRow.id).label("status_count"))
        .join(MachineRow, MachineRow.id == InterventionRow.machine_id)
        .where(
            MachineRow.active.is_(True),
            InterventionRow.created_at >= start,
            InterventionRow.created_at < end,
        )
        .group_by(InterventionRow.status),
        machine_id,
    )
    intervention_counts = {
        row.status: row.status_count
        for row in db.execute(intervention_statement)
    }

    online_count = sum(machine.status == "online" for machine in machines)
    without_measurement_count = sum(machine.last_seen is None for machine in machines)
    offline_count = sum(
        machine.status == "offline" and machine.last_seen is not None
        for machine in machines
    )
    return {
        "period": {"start": start, "end": end},
        "machine_count": len(machines),
        "online_count": online_count,
        "offline_count": offline_count,
        "without_measurement_count": without_measurement_count,
        "active_alert_count": active_alerts,
        "critical_event_count": critical_events,
        "intervention_counts": intervention_counts,
        "availability": {
            "value": None,
            "coverage": None,
            "status": "unavailable",
            "reason": (
                "Le planning de production et les périodes de panne confirmées "
                "ne sont pas historisés."
            ),
        },
        "mtbf": {
            "value": None,
            "reason": "Un historique suffisant de pannes confirmées est nécessaire.",
        },
        "mttr": {
            "value": None,
            "reason": "Un historique suffisant de pannes confirmées et résolues est nécessaire.",
        },
        "downtime_cost": {
            "value": None,
            "status": "unconfigured",
            "reason": "Aucun coût horaire d’arrêt n’est configuré.",
        },
        "machines": [
            {
                "id": machine.id,
                "name": machine.name,
                "status": machine.status,
                "last_seen": machine.last_seen,
                "has_measurement": machine.last_seen is not None,
            }
            for machine in machines
        ],
    }


def _critical_events(
    db: Session,
    start: datetime,
    end: datetime,
    machine_id: str | None,
    limit: int,
) -> list[dict]:
    statement = _failure_scope(
        select(
            MaintenanceFailureRow,
            MachineRow.name.label("machine_name"),
            AlertRow.severity.label("severity"),
            AlertRow.status.label("alert_status"),
            AlertRow.value.label("alert_value"),
        )
        .join(MachineRow, MachineRow.id == MaintenanceFailureRow.machine_id)
        .join(AlertRow, AlertRow.id == MaintenanceFailureRow.alert_id)
        .where(
            MachineRow.active.is_(True),
            MaintenanceFailureRow.detected_at >= start,
            MaintenanceFailureRow.detected_at < end,
        )
        .order_by(desc(MaintenanceFailureRow.detected_at))
        .limit(limit),
        machine_id,
    )
    return [
        {
            "id": failure.id,
            "machine_id": failure.machine_id,
            "machine_name": machine_name,
            "metric": failure.failure_type,
            "description": failure.description,
            "diagnosis": failure.diagnosis,
            "intervention": failure.intervention,
            "result": failure.result,
            "severity": severity,
            "alert_status": alert_status,
            "value": alert_value,
            "detected_at": failure.detected_at,
            "resolved_at": failure.resolved_at,
        }
        for failure, machine_name, severity, alert_status, alert_value
        in db.execute(statement)
    ]


@router.get("/overview")
def director_overview(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    return _overview(db, period_start, period_end, machine_id)


@router.get("/events")
def director_events(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    limit: int = Query(default=100, ge=1, le=MAX_REPORT_ROWS),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    _validate_machine(db, machine_id)
    return _critical_events(db, period_start, period_end, machine_id, limit)


@router.get("/report")
def director_report(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    db: Session = Depends(get_db),
    user: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    _validate_machine(db, machine_id)
    summary = _overview(db, period_start, period_end, machine_id)

    intervention_statement = _intervention_scope(
        select(
            InterventionRow,
            MachineRow.name.label("machine_name"),
            UserRow.full_name.label("technician_name"),
        )
        .join(MachineRow, MachineRow.id == InterventionRow.machine_id)
        .outerjoin(UserRow, UserRow.id == InterventionRow.assigned_to_id)
        .where(
            MachineRow.active.is_(True),
            InterventionRow.created_at >= period_start,
            InterventionRow.created_at < period_end,
        )
        .order_by(desc(InterventionRow.created_at))
        .limit(MAX_REPORT_ROWS),
        machine_id,
    )
    interventions = [
        {
            "id": intervention.id,
            "machine_id": intervention.machine_id,
            "machine_name": machine_name,
            "technician_name": technician_name or "",
            "title": intervention.title,
            "status": intervention.status,
            "priority": intervention.priority,
            "created_at": intervention.created_at,
            "resolved_at": intervention.resolved_at,
            "duration_minutes": intervention.duration_minutes,
        }
        for intervention, machine_name, technician_name in db.execute(intervention_statement)
    ]

    return {
        **summary,
        "events": _critical_events(
            db, period_start, period_end, machine_id, MAX_REPORT_ROWS
        ),
        "interventions": interventions,
        "generated_for_user": user.full_name or user.email,
        "row_limit": MAX_REPORT_ROWS,
    }
