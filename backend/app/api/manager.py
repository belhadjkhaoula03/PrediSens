from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.api.auth import get_db, require_roles
from app.infrastructure.models import (
    AlertEventRow,
    AlertRow,
    MachineRow,
    MachineStatusEventRow,
    ManagerFailureRow,
    MeasurementRow,
    SystemSettingRow,
    UserRow,
)

router = APIRouter(prefix="/api/manager", tags=["responsable-maintenance"])
manager_only = require_roles("manager")
PERIODS = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}
SLA_SETTING_KEY = "manager_performance_sla_target"


class ManagerFailureCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine_id: str = Field(min_length=2, max_length=80)
    failure_type: Literal["mechanical", "electrical", "thermal", "control", "other"]
    description: str = Field(min_length=3, max_length=4000)


class ManagerFailureResolution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    diagnosis: str = Field(min_length=3, max_length=4000)
    work_done: str = Field(min_length=3, max_length=4000)
    result: str = Field(min_length=3, max_length=4000)


class SlaTargetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_percentage: float = Field(gt=0, le=100)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _window(
    period: str,
    start: datetime | None,
    end: datetime | None,
    now: datetime,
) -> tuple[datetime, datetime]:
    if (start is None) != (end is None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Les dates de début et de fin doivent être fournies ensemble.",
        )
    if start is not None and end is not None:
        start, end = _utc(start), _utc(end)
        if start >= end or end > now:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "La période doit être valide et ne pas se terminer dans le futur.",
            )
        return start, end
    return now - PERIODS[period], now


def _period_totals(
    machines: list[MachineRow],
    events_by_machine: dict[str, list[MachineStatusEventRow]],
    start: datetime,
    end: datetime,
) -> dict:
    online_seconds = 0.0
    offline_seconds = 0.0
    observed_seconds = 0.0
    expected_seconds = 0.0
    per_machine: dict[str, dict] = {}

    for machine in machines:
        observation_start = max(start, _utc(machine.created_at))
        expected = max(0.0, (end - observation_start).total_seconds())
        expected_seconds += expected
        events = sorted(
            events_by_machine.get(machine.id, []),
            key=lambda event: (_utc(event.occurred_at), event.id),
        )
        previous = [
            event for event in events
            if _utc(event.occurred_at) <= observation_start
        ]
        if previous:
            current_state = previous[-1].status
            cursor = observation_start
            remaining = [event for event in events if _utc(event.occurred_at) > observation_start]
        else:
            first = next(
                (event for event in events if _utc(event.occurred_at) > observation_start),
                None,
            )
            if first is None:
                per_machine[machine.id] = {
                    "online_seconds": None,
                    "offline_seconds": None,
                    "observed_seconds": 0.0,
                    "expected_seconds": expected,
                    "availability_percentage": None,
                    "coverage_percentage": 0.0 if expected else None,
                }
                continue
            current_state = first.status
            cursor = _utc(first.occurred_at)
            remaining = [
                event for event in events
                if _utc(event.occurred_at) > cursor
            ]

        machine_online = 0.0
        machine_offline = 0.0
        for event in remaining:
            event_time = min(end, _utc(event.occurred_at))
            seconds = max(0.0, (event_time - cursor).total_seconds())
            if current_state == "online":
                machine_online += seconds
            elif current_state == "offline":
                machine_offline += seconds
            cursor = event_time
            current_state = event.status
            if cursor >= end:
                break

        seconds = max(0.0, (end - cursor).total_seconds())
        if current_state == "online":
            machine_online += seconds
        elif current_state == "offline":
            machine_offline += seconds

        machine_observed = machine_online + machine_offline
        online_seconds += machine_online
        offline_seconds += machine_offline
        observed_seconds += machine_observed
        per_machine[machine.id] = {
            "online_seconds": machine_online,
            "offline_seconds": machine_offline,
            "observed_seconds": machine_observed,
            "expected_seconds": expected,
            "availability_percentage": (
                machine_online / machine_observed * 100 if machine_observed else None
            ),
            "coverage_percentage": (
                machine_observed / expected * 100 if expected else None
            ),
        }

    return {
        "online_seconds": online_seconds,
        "offline_seconds": offline_seconds,
        "observed_seconds": observed_seconds,
        "expected_seconds": expected_seconds,
        "coverage_percentage": (
            observed_seconds / expected_seconds * 100 if expected_seconds else None
        ),
        "availability_percentage": (
            online_seconds / observed_seconds * 100 if observed_seconds else None
        ),
        "per_machine": per_machine,
    }


def _failure_dict(row: ManagerFailureRow, db: Session) -> dict:
    machine = db.get(MachineRow, row.machine_id)
    creator = db.get(UserRow, row.detected_by_id)
    duration_seconds = (
        max(0.0, (_utc(row.resolved_at) - _utc(row.detected_at)).total_seconds())
        if row.resolved_at is not None else None
    )
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "machine_name": machine.name if machine else row.machine_id,
        "failure_type": row.failure_type,
        "description": row.description,
        "diagnosis": row.diagnosis,
        "work_done": row.work_done,
        "result": row.result,
        "intervention_id": row.intervention_id,
        "detected_by": creator.full_name if creator else "Utilisateur inconnu",
        "detected_at": row.detected_at,
        "resolved_at": row.resolved_at,
        "duration_seconds": duration_seconds,
        "status": "resolved" if row.resolved_at else "open",
    }


@router.get("/performance")
def performance(
    period: Literal["24h", "7d", "30d"] = Query("7d"),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    db: Session = Depends(get_db),
    _: UserRow = Depends(manager_only),
):
    now = datetime.now(timezone.utc)
    start, end = _window(period, start, end, now)
    machines = db.scalars(
        select(MachineRow).where(MachineRow.active.is_(True)).order_by(MachineRow.name)
    ).all()
    machine_ids = [machine.id for machine in machines]

    events_by_machine: dict[str, list[MachineStatusEventRow]] = {
        machine_id: [] for machine_id in machine_ids
    }
    if machine_ids:
        prior_ranked = (
            select(
                MachineStatusEventRow.id.label("event_id"),
                func.row_number().over(
                    partition_by=MachineStatusEventRow.machine_id,
                    order_by=(
                        desc(MachineStatusEventRow.occurred_at),
                        desc(MachineStatusEventRow.id),
                    ),
                ).label("event_rank"),
            )
            .where(
                MachineStatusEventRow.machine_id.in_(machine_ids),
                MachineStatusEventRow.occurred_at < start,
            )
            .subquery()
        )
        prior_events = db.scalars(
            select(MachineStatusEventRow)
            .join(prior_ranked, prior_ranked.c.event_id == MachineStatusEventRow.id)
            .where(prior_ranked.c.event_rank == 1)
        ).all()
        period_events = db.scalars(
            select(MachineStatusEventRow)
            .where(
                MachineStatusEventRow.machine_id.in_(machine_ids),
                MachineStatusEventRow.occurred_at >= start,
                MachineStatusEventRow.occurred_at <= end,
            )
            .order_by(MachineStatusEventRow.occurred_at, MachineStatusEventRow.id)
        ).all()
        for event in [*prior_events, *period_events]:
            events_by_machine[event.machine_id].append(event)

    totals = _period_totals(machines, events_by_machine, start, end)
    failure_rows = db.scalars(
        select(ManagerFailureRow)
        .where(
            ManagerFailureRow.detected_at >= start,
            ManagerFailureRow.detected_at < end,
            ManagerFailureRow.machine_id.in_(machine_ids),
        )
        .order_by(desc(ManagerFailureRow.detected_at), desc(ManagerFailureRow.id))
    ).all() if machine_ids else []
    resolved_failures = [
        row for row in failure_rows
        if row.resolved_at is not None and _utc(row.resolved_at) <= end
    ]
    mtbf_hours = (
        totals["online_seconds"] / len(failure_rows) / 3600
        if failure_rows and totals["observed_seconds"] > 0 else None
    )
    mttr_hours = (
        sum((_utc(row.resolved_at) - _utc(row.detected_at)).total_seconds() for row in resolved_failures)
        / len(resolved_failures) / 3600
        if resolved_failures else None
    )
    active_alert_count = db.scalar(
        select(func.count(AlertRow.id)).where(
            AlertRow.status.not_in(("closed", "false_positive")),
            AlertRow.machine_id.in_(machine_ids),
        )
    ) or 0

    latest_by_machine: dict[str, MeasurementRow] = {}
    if machine_ids:
        latest_ranked = (
            select(
                MeasurementRow.id.label("measurement_id"),
                func.row_number().over(
                    partition_by=MeasurementRow.machine_id,
                    order_by=(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id)),
                ).label("measurement_rank"),
            )
            .where(MeasurementRow.machine_id.in_(machine_ids))
            .subquery()
        )
        for measurement in db.scalars(
            select(MeasurementRow)
            .join(latest_ranked, latest_ranked.c.measurement_id == MeasurementRow.id)
            .where(latest_ranked.c.measurement_rank == 1)
        ).all():
            latest_by_machine[measurement.machine_id] = measurement

    coverage = totals["coverage_percentage"]
    availability_quality = (
        "unavailable" if totals["availability_percentage"] is None
        else "sufficient" if coverage is not None and coverage >= 95
        else "insufficient_coverage"
    )
    setting = db.get(SystemSettingRow, SLA_SETTING_KEY)
    sla_target = None
    if setting is not None:
        try:
            sla_target = float(setting.value)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "La configuration de disponibilité cible est invalide.",
            ) from exc

    window_hours = (end - start).total_seconds() / 3600
    tolerated_offline_hours = (
        window_hours * (1 - sla_target / 100) if sla_target is not None else None
    )
    actual_offline_hours = totals["offline_seconds"] / 3600
    sla_status = (
        "unconfigured" if sla_target is None
        else "insufficient_coverage" if availability_quality != "sufficient"
        else "met" if actual_offline_hours <= tolerated_offline_hours + 1e-9
        else "missed"
    )

    bucket_count = {"24h": 24, "7d": 7, "30d": 30}[period] if start == now - PERIODS[period] else 12
    bucket_seconds = (end - start).total_seconds() / bucket_count if bucket_count else 0
    trend = []
    for index in range(bucket_count):
        bucket_start = start + timedelta(seconds=index * bucket_seconds)
        bucket_end = end if index == bucket_count - 1 else bucket_start + timedelta(seconds=bucket_seconds)
        bucket_totals = _period_totals(machines, events_by_machine, bucket_start, bucket_end)
        trend.append({
            "start": bucket_start,
            "end": bucket_end,
            "availability_percentage": bucket_totals["availability_percentage"],
            "coverage_percentage": bucket_totals["coverage_percentage"],
        })

    return {
        "updated_at": now,
        "period": {"start": start, "end": end, "hours": window_hours},
        "machine_count": len(machines),
        "online_count": sum(machine.status == "online" for machine in machines),
        "offline_count": sum(machine.status == "offline" for machine in machines),
        "unknown_count": sum(machine.last_seen is None for machine in machines),
        "anomaly_count": active_alert_count,
        "confirmed_failure_count": len(failure_rows),
        "availability": {
            "value": totals["availability_percentage"],
            "quality": availability_quality,
            "coverage_percentage": coverage,
            "online_hours": totals["online_seconds"] / 3600,
            "offline_hours": actual_offline_hours,
            "observed_hours": totals["observed_seconds"] / 3600,
            "reason": (
                None if totals["observed_seconds"] > 0
                else "Aucune transition d’état n’a encore été observée."
            ),
        },
        "mtbf": {
            "value_hours": mtbf_hours,
            "reason": None if mtbf_hours is not None else "Aucune panne confirmée avec temps de fonctionnement observé.",
        },
        "mttr": {
            "value_hours": mttr_hours,
            "reason": None if mttr_hours is not None else "Aucune réparation confirmée et clôturée sur la période.",
        },
        "sla": {
            "target_percentage": sla_target,
            "tolerated_offline_hours": tolerated_offline_hours,
            "actual_offline_hours": actual_offline_hours,
            "margin_hours": (
                tolerated_offline_hours - actual_offline_hours
                if tolerated_offline_hours is not None else None
            ),
            "status": sla_status,
        },
        "machines": [
            {
                "id": machine.id,
                "name": machine.name,
                "status": machine.status,
                "last_communication_at": machine.last_seen,
                "last_telemetry_at": (
                    latest_by_machine[machine.id].recorded_at
                    if machine.id in latest_by_machine else None
                ),
                **totals["per_machine"][machine.id],
                "confirmed_failure_count": sum(
                    row.machine_id == machine.id for row in failure_rows
                ),
                "mtbf_hours": (
                    totals["per_machine"][machine.id]["online_seconds"] / 3600
                    / sum(row.machine_id == machine.id for row in failure_rows)
                    if sum(row.machine_id == machine.id for row in failure_rows)
                    and totals["per_machine"][machine.id]["online_seconds"] is not None
                    else None
                ),
                "mttr_hours": (
                    sum(
                        (_utc(row.resolved_at) - _utc(row.detected_at)).total_seconds()
                        for row in resolved_failures if row.machine_id == machine.id
                    ) / len([row for row in resolved_failures if row.machine_id == machine.id]) / 3600
                    if any(row.machine_id == machine.id for row in resolved_failures)
                    else None
                ),
            }
            for machine in machines
        ],
        "failures": [_failure_dict(row, db) for row in failure_rows[:100]],
        "trend": trend,
    }


@router.put("/performance/sla")
def set_performance_sla(
    data: SlaTargetInput,
    db: Session = Depends(get_db),
    _: UserRow = Depends(manager_only),
):
    row = db.get(SystemSettingRow, SLA_SETTING_KEY)
    if row is None:
        row = SystemSettingRow(key=SLA_SETTING_KEY, value=str(data.target_percentage))
        db.add(row)
    else:
        row.value = str(data.target_percentage)
    db.commit()
    return {"target_percentage": float(row.value)}


@router.get("/failures")
def list_manager_failures(
    limit: int = Query(100, ge=1, le=300),
    db: Session = Depends(get_db),
    _: UserRow = Depends(manager_only),
):
    rows = db.scalars(
        select(ManagerFailureRow)
        .order_by(desc(ManagerFailureRow.detected_at), desc(ManagerFailureRow.id))
        .limit(limit)
    ).all()
    return [_failure_dict(row, db) for row in rows]


@router.post("/failures", status_code=status.HTTP_201_CREATED)
def create_manager_failure(
    data: ManagerFailureCreate,
    db: Session = Depends(get_db),
    manager: UserRow = Depends(manager_only),
):
    machine = db.get(MachineRow, data.machine_id)
    if machine is None or not machine.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou archivée.")
    row = ManagerFailureRow(
        machine_id=machine.id,
        failure_type=data.failure_type,
        description=data.description.strip(),
        detected_by_id=manager.id,
        detected_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _failure_dict(row, db)


@router.patch("/failures/{failure_id}/resolve")
def resolve_manager_failure(
    failure_id: int,
    data: ManagerFailureResolution,
    db: Session = Depends(get_db),
    _: UserRow = Depends(manager_only),
):
    row = db.get(ManagerFailureRow, failure_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Panne confirmée introuvable.")
    if row.resolved_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Cette panne est déjà clôturée.")
    row.diagnosis = data.diagnosis.strip()
    row.work_done = data.work_done.strip()
    row.result = data.result.strip()
    row.resolved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _failure_dict(row, db)


@router.post("/alerts/{alert_id}/false-positive")
def mark_alert_false_positive(
    alert_id: int,
    db: Session = Depends(get_db),
    manager: UserRow = Depends(manager_only),
):
    row = db.get(AlertRow, alert_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alerte introuvable.")
    if row.status == "false_positive":
        return {"id": row.id, "status": row.status}
    if row.status == "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Une alerte clôturée ne peut pas être requalifiée.")
    row.status = "false_positive"
    row.closed_at = datetime.now(timezone.utc)
    db.add(
        AlertEventRow(
            alert_id=row.id,
            user_id=manager.id,
            action="false_positive",
            details="Marquée comme fausse alerte par le Responsable de maintenance.",
            created_at=row.closed_at,
        )
    )
    db.commit()
    return {"id": row.id, "status": row.status, "closed_at": row.closed_at}
