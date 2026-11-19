from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.api.auth import get_db, require_roles
from app.infrastructure.models import (
    AlertRow,
    DirectorMachineCostRateRow,
    InterventionRow,
    MachineRow,
    MachineStatusEventRow,
    ManagerFailureRow,
    MaintenanceFailureRow,
    MeasurementRow,
    SystemSettingRow,
    UserRow,
)

router = APIRouter(prefix="/api/director", tags=["direction"])
director_only = require_roles("director")
MAX_REPORT_ROWS = 300
DEFAULT_TELEMETRY_STALE_SECONDS = 30


class DirectorCostRateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hourly_rate: Decimal = Field(ge=Decimal("0"), max_digits=14, decimal_places=3)
    currency: str = Field(pattern=r"^[A-Z]{3}$")


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
        if start >= end or end > datetime.now(timezone.utc):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "La période doit être valide et ne pas se terminer dans le futur.",
            )
        return start, end
    end = datetime.now(timezone.utc)
    return end - timedelta(days=days), end


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


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


def _acquisition_scope(statement, acquisition_mode: str | None):
    if acquisition_mode in ("hardware", "simulated"):
        statement = statement.where(AlertRow.acquisition_mode == acquisition_mode)
    elif acquisition_mode == "unknown":
        statement = statement.where(AlertRow.acquisition_mode.is_(None))
    return statement


def _merge_intervals(
    intervals: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    merged: list[tuple[datetime, datetime]] = []
    for interval_start, interval_end in sorted(intervals):
        if interval_start >= interval_end:
            continue
        if merged and interval_start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], interval_end))
        else:
            merged.append((interval_start, interval_end))
    return merged


def _subtract_intervals(
    intervals: list[tuple[datetime, datetime]],
    exclusions: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    result: list[tuple[datetime, datetime]] = []
    for interval_start, interval_end in intervals:
        cursor = interval_start
        for excluded_start, excluded_end in _merge_intervals(exclusions):
            if excluded_end <= cursor:
                continue
            if excluded_start >= interval_end:
                break
            if excluded_start > cursor:
                result.append((cursor, min(excluded_start, interval_end)))
            cursor = max(cursor, excluded_end)
            if cursor >= interval_end:
                break
        if cursor < interval_end:
            result.append((cursor, interval_end))
    return result


def _status_offline_intervals(
    events: list[MachineStatusEventRow],
    start: datetime,
    end: datetime,
) -> list[tuple[datetime, datetime]]:
    previous = [event for event in events if _utc(event.occurred_at) <= start]
    current_state = previous[-1].status if previous else None
    cursor = start
    offline: list[tuple[datetime, datetime]] = []
    for event in events:
        event_at = _utc(event.occurred_at)
        if event_at <= start:
            continue
        if event_at >= end:
            break
        if current_state == "offline":
            offline.append((cursor, event_at))
        current_state = event.status
        cursor = event_at
    if current_state == "offline":
        offline.append((cursor, end))
    return offline


def _telemetry_intervals(
    rows: list[MeasurementRow],
    start: datetime,
    end: datetime,
    stale_after_seconds: int,
) -> list[tuple[datetime, datetime]]:
    freshness = timedelta(seconds=stale_after_seconds)
    intervals = []
    for row in rows:
        recorded_at = _utc(row.recorded_at)
        interval_start = max(start, recorded_at)
        interval_end = min(end, recorded_at + freshness)
        if interval_start < interval_end:
            intervals.append((interval_start, interval_end))
    return _merge_intervals(intervals)


def _service_metrics(
    machines: list[MachineRow],
    events_by_machine: dict[str, list[MachineStatusEventRow]],
    measurements_by_machine: dict[str, list[MeasurementRow]],
    start: datetime,
    end: datetime,
    stale_after_seconds: int,
) -> dict:
    expected_seconds = 0.0
    online_seconds = 0.0
    known_seconds = 0.0
    per_machine: dict[str, dict] = {}
    for machine in machines:
        observation_start = max(start, _utc(machine.created_at))
        expected = max(0.0, (end - observation_start).total_seconds())
        offline = _status_offline_intervals(
            events_by_machine.get(machine.id, []), observation_start, end
        )
        online = _subtract_intervals(
            _telemetry_intervals(
                measurements_by_machine.get(machine.id, []),
                observation_start,
                end,
                stale_after_seconds,
            ),
            offline,
        )
        known = _merge_intervals([*online, *offline])
        machine_online = sum((right - left).total_seconds() for left, right in online)
        machine_known = sum((right - left).total_seconds() for left, right in known)
        expected_seconds += expected
        online_seconds += machine_online
        known_seconds += machine_known
        per_machine[machine.id] = {
            "expected_seconds": expected,
            "online_seconds": machine_online,
            "known_seconds": machine_known,
            "unobserved_seconds": max(0.0, expected - machine_known),
            "unavailable_seconds": max(0.0, expected - machine_online),
            "availability_percentage": (
                machine_online / expected * 100 if expected else 0.0
            ),
            "coverage_percentage": (
                machine_known / expected * 100 if expected else 0.0
            ),
        }
    return {
        "online_seconds": online_seconds,
        "known_seconds": known_seconds,
        "unobserved_seconds": max(0.0, expected_seconds - known_seconds),
        "unavailable_seconds": max(0.0, expected_seconds - online_seconds),
        "availability_percentage": (
            online_seconds / expected_seconds * 100 if expected_seconds else 0.0
        ),
        "coverage_percentage": (
            known_seconds / expected_seconds * 100 if expected_seconds else 0.0
        ),
        "per_machine": per_machine,
    }


def _rate_history(
    db: Session,
    machine_ids: list[str],
    end: datetime,
) -> tuple[dict[str, list[DirectorMachineCostRateRow]], dict[str, DirectorMachineCostRateRow]]:
    if not machine_ids:
        return {}, {}
    rows = db.scalars(
        select(DirectorMachineCostRateRow)
        .where(
            DirectorMachineCostRateRow.machine_id.in_(machine_ids),
            DirectorMachineCostRateRow.updated_at <= end,
        )
        .order_by(
            DirectorMachineCostRateRow.machine_id,
            DirectorMachineCostRateRow.updated_at,
            DirectorMachineCostRateRow.id,
        )
    ).all()
    history: dict[str, list[DirectorMachineCostRateRow]] = {
        machine_id: [] for machine_id in machine_ids
    }
    for row in rows:
        history[row.machine_id].append(row)
    latest = {
        machine_id: rows_for_machine[-1]
        for machine_id, rows_for_machine in history.items()
        if rows_for_machine
    }
    return history, latest


def _cost_breakdown(
    machines: list[MachineRow],
    failures: list[ManagerFailureRow],
    rates_by_machine: dict[str, list[DirectorMachineCostRateRow]],
    start: datetime,
    end: datetime,
) -> dict:
    totals = {
        machine.id: {
            "machine_id": machine.id,
            "machine_name": machine.name,
            "downtime_hours": 0.0,
            "unpriced_downtime_hours": 0.0,
            "costs_by_currency": {},
        }
        for machine in machines
    }
    outages_by_machine: dict[str, list[tuple[datetime, datetime]]] = {
        machine.id: [] for machine in machines
    }
    for failure in failures:
        if failure.machine_id not in outages_by_machine:
            continue
        outage_start = max(start, _utc(failure.detected_at))
        outage_end = min(
            end,
            _utc(failure.resolved_at) if failure.resolved_at else end,
        )
        if outage_start < outage_end:
            outages_by_machine[failure.machine_id].append((outage_start, outage_end))

    for machine_id, outages in outages_by_machine.items():
        item = totals[machine_id]
        rate_history = rates_by_machine.get(machine_id, [])
        for outage_start, outage_end in _merge_intervals(outages):
            item["downtime_hours"] += (outage_end - outage_start).total_seconds() / 3600
            boundaries = [outage_start, *[
                _utc(rate.updated_at)
                for rate in rate_history
                if outage_start < _utc(rate.updated_at) < outage_end
            ], outage_end]
            boundaries = sorted(set(boundaries))
            for segment_start, segment_end in zip(boundaries, boundaries[1:]):
                rate = next(
                    (
                        candidate for candidate in reversed(rate_history)
                        if _utc(candidate.updated_at) <= segment_start
                    ),
                    None,
                )
                segment_hours = (segment_end - segment_start).total_seconds() / 3600
                if rate is None:
                    item["unpriced_downtime_hours"] += segment_hours
                    continue
                amount = (
                    rate.hourly_rate * Decimal(str(segment_hours))
                ).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
                currency_totals = item["costs_by_currency"]
                currency_totals[rate.currency] = (
                    currency_totals.get(rate.currency, Decimal("0")) + amount
                )

    currency_totals: dict[str, Decimal] = {}
    result = []
    for item in totals.values():
        item["downtime_hours"] = round(item["downtime_hours"], 6)
        item["unpriced_downtime_hours"] = round(
            item["unpriced_downtime_hours"], 6
        )
        item["costs_by_currency"] = {
            currency: float(amount)
            for currency, amount in item["costs_by_currency"].items()
        }
        for currency, amount in item["costs_by_currency"].items():
            currency_totals[currency] = (
                currency_totals.get(currency, Decimal("0")) + Decimal(str(amount))
            )
        result.append(item)
    configured_downtime = sum(
        item["downtime_hours"] - item["unpriced_downtime_hours"]
        for item in result
    )
    return {
        "machines": result,
        "costs_by_currency": {
            currency: float(amount.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))
            for currency, amount in currency_totals.items()
        },
        "unpriced_downtime_hours": round(
            sum(item["unpriced_downtime_hours"] for item in result), 6
        ),
        "configured_downtime_hours": round(configured_downtime, 6),
    }


def _overview(
    db: Session,
    start: datetime,
    end: datetime,
    machine_id: str | None,
    acquisition_mode: str | None = None,
) -> dict:
    _validate_machine(db, machine_id)
    server_time = datetime.now(timezone.utc)
    stale_setting = db.get(SystemSettingRow, "director_telemetry_stale_seconds")
    try:
        stale_after_seconds = int(
            stale_setting.value if stale_setting is not None
            else DEFAULT_TELEMETRY_STALE_SECONDS
        )
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Le délai d’obsolescence de la télémétrie est invalide.",
        ) from exc
    if not 5 <= stale_after_seconds <= 3600:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Le délai d’obsolescence de la télémétrie est hors limites.",
        )

    machines = db.scalars(
        _machine_scope(
            select(MachineRow)
            .where(MachineRow.active.is_(True))
            .order_by(MachineRow.name),
            machine_id,
        )
    ).all()
    machine_ids = [machine.id for machine in machines]
    active_alerts = db.scalar(
        _acquisition_scope(
            _machine_scope(
                select(func.count(AlertRow.id))
                .join(MachineRow, MachineRow.id == AlertRow.machine_id)
                .where(
                    MachineRow.active.is_(True),
                    AlertRow.status.not_in(("closed", "false_positive")),
                ),
                machine_id,
            ),
            acquisition_mode,
        )
    ) or 0
    critical_statement = _machine_scope(
        select(func.count(MaintenanceFailureRow.id))
        .join(MachineRow, MachineRow.id == MaintenanceFailureRow.machine_id)
        .join(AlertRow, AlertRow.id == MaintenanceFailureRow.alert_id)
        .where(
            MachineRow.active.is_(True),
            MaintenanceFailureRow.detected_at >= start,
            MaintenanceFailureRow.detected_at < end,
        ),
        machine_id,
    )
    critical_events = db.scalar(
        _acquisition_scope(critical_statement, acquisition_mode)
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
        row.status: row.status_count for row in db.execute(intervention_statement)
    }

    events_by_machine: dict[str, list[MachineStatusEventRow]] = {
        identifier: [] for identifier in machine_ids
    }
    measurements_by_machine: dict[str, list[MeasurementRow]] = {
        identifier: [] for identifier in machine_ids
    }
    latest_by_machine: dict[str, MeasurementRow] = {}
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
                MachineStatusEventRow.occurred_at <= start,
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
                MachineStatusEventRow.occurred_at > start,
                MachineStatusEventRow.occurred_at <= end,
            )
            .order_by(MachineStatusEventRow.occurred_at, MachineStatusEventRow.id)
        ).all()
        for event in [*prior_events, *period_events]:
            events_by_machine[event.machine_id].append(event)

        measured_after = start - timedelta(seconds=stale_after_seconds)
        measurement_statement = select(MeasurementRow).where(
            MeasurementRow.machine_id.in_(machine_ids),
            MeasurementRow.recorded_at >= measured_after,
            MeasurementRow.recorded_at <= end,
        )
        latest_statement = select(
            MeasurementRow.id.label("measurement_id"),
            func.row_number().over(
                partition_by=MeasurementRow.machine_id,
                order_by=(desc(MeasurementRow.recorded_at), desc(MeasurementRow.id)),
            ).label("measurement_rank"),
        ).where(
            MeasurementRow.machine_id.in_(machine_ids),
            MeasurementRow.recorded_at <= end,
        )
        if acquisition_mode in ("hardware", "simulated"):
            measurement_statement = measurement_statement.where(
                MeasurementRow.acquisition_mode == acquisition_mode
            )
            latest_statement = latest_statement.where(
                MeasurementRow.acquisition_mode == acquisition_mode
            )
        elif acquisition_mode == "unknown":
            measurement_statement = measurement_statement.where(
                MeasurementRow.id.is_(None)
            )
            latest_statement = latest_statement.where(MeasurementRow.id.is_(None))

        for measurement in db.scalars(
            measurement_statement.order_by(
                MeasurementRow.machine_id,
                MeasurementRow.recorded_at,
                MeasurementRow.id,
            )
        ).all():
            measurements_by_machine[measurement.machine_id].append(measurement)
        latest_subquery = latest_statement.subquery()
        for measurement in db.scalars(
            select(MeasurementRow)
            .join(
                latest_subquery,
                latest_subquery.c.measurement_id == MeasurementRow.id,
            )
            .where(latest_subquery.c.measurement_rank == 1)
        ).all():
            latest_by_machine[measurement.machine_id] = measurement

    service = _service_metrics(
        machines,
        events_by_machine,
        measurements_by_machine,
        start,
        end,
        stale_after_seconds,
    )
    failures = db.scalars(
        select(ManagerFailureRow)
        .join(MachineRow, MachineRow.id == ManagerFailureRow.machine_id)
        .where(
            MachineRow.active.is_(True),
            ManagerFailureRow.detected_at < end,
            (
                ManagerFailureRow.resolved_at.is_(None)
                | (ManagerFailureRow.resolved_at > start)
            ),
        )
        .order_by(ManagerFailureRow.detected_at, ManagerFailureRow.id)
    ).all() if machine_ids else []
    period_failures = [
        row for row in failures if start <= _utc(row.detected_at) < end
    ]
    resolved_failures = [
        row for row in failures
        if row.resolved_at is not None and start <= _utc(row.resolved_at) < end
    ]
    rates_by_machine, latest_rates = _rate_history(db, machine_ids, end)
    costs = _cost_breakdown(machines, failures, rates_by_machine, start, end)
    interval_days = (end - start).total_seconds() / 86400
    uptime_hours = service["online_seconds"] / 3600
    mtbf_hours = (
        uptime_hours / len(period_failures)
        if period_failures and uptime_hours > 0 else None
    )
    mttr_hours = (
        sum(
            max(0.0, (_utc(row.resolved_at) - _utc(row.detected_at)).total_seconds())
            for row in resolved_failures
        )
        / len(resolved_failures)
        / 3600
        if resolved_failures else None
    )
    per_machine = {item["machine_id"]: item for item in costs["machines"]}
    machine_data = []
    for machine in machines:
        measurement = latest_by_machine.get(machine.id)
        age_seconds = (
            max(0, (server_time - _utc(measurement.recorded_at)).total_seconds())
            if measurement is not None else None
        )
        telemetry_state = (
            "missing" if measurement is None
            else "stale" if age_seconds > stale_after_seconds
            else "fresh"
        )
        rate = latest_rates.get(machine.id)
        if rate is None:
            rate_data = {
                "hourly_rate": None,
                "currency": None,
                "rate_updated_at": None,
                "rate_updated_by": None,
            }
        else:
            rate_data = {
                "hourly_rate": float(rate.hourly_rate),
                "currency": rate.currency,
                "rate_updated_at": rate.updated_at,
                "rate_updated_by": rate.updated_by_name or rate.updated_by_email,
            }
        machine_data.append({
            "id": machine.id,
            "name": machine.name,
            "status": machine.status,
            "last_seen": machine.last_seen,
            "last_measurement_mode": measurement.acquisition_mode if measurement else None,
            "measurement_recorded_at": measurement.recorded_at if measurement else None,
            "measurement_age_seconds": age_seconds,
            "has_measurement": measurement is not None,
            "telemetry_state": telemetry_state,
            **service["per_machine"][machine.id],
            **per_machine[machine.id],
            **rate_data,
        })

    return {
        "server_time": server_time,
        "period": {"start": start, "end": end},
        "machine_count": len(machines),
        "online_count": sum(machine.status == "online" for machine in machines),
        "offline_count": sum(machine.status == "offline" for machine in machines),
        "stale_telemetry_count": sum(
            item["telemetry_state"] == "stale" for item in machine_data
        ),
        "without_measurement_count": sum(
            item["telemetry_state"] == "missing" for item in machine_data
        ),
        "active_alert_count": active_alerts,
        "critical_event_count": critical_events,
        "intervention_counts": intervention_counts,
        "availability": {
            "value": round(service["availability_percentage"], 2),
            "coverage": round(service["coverage_percentage"], 2),
            "status": (
                "no_assets" if not machines
                else "low_coverage" if service["coverage_percentage"] < 95
                else "observed"
            ),
            "online_hours": round(uptime_hours, 4),
            "unavailable_hours": round(service["unavailable_seconds"] / 3600, 4),
            "unobserved_hours": round(service["unobserved_seconds"] / 3600, 4),
            "stale_after_seconds": stale_after_seconds,
            "basis": (
                "Disponibilité de supervision sur la période; les durées sans "
                "télémétrie sont comptées comme indisponibles."
            ),
        },
        "mtbf": {
            "value_hours": round(mtbf_hours, 4) if mtbf_hours is not None else None,
            "reason": (
                "Non calculable – aucune panne confirmée sur la période."
                if not period_failures
                else "Non calculable – aucune durée de fonctionnement observée."
                if uptime_hours <= 0 else None
            ),
        },
        "mttr": {
            "value_hours": round(mttr_hours, 4) if mttr_hours is not None else None,
            "reason": (
                "Non calculable – aucun rétablissement de panne enregistré."
                if not resolved_failures else None
            ),
        },
        "failure_metrics": {
            "confirmed_failure_count": len(period_failures),
            "frequency_per_30_days": (
                round(len(period_failures) / interval_days * 30, 4)
                if interval_days else 0.0
            ),
            "resolved_failure_count": len(resolved_failures),
            "confirmed_downtime_hours": round(
                sum(item["downtime_hours"] for item in costs["machines"]), 4
            ),
            "failures": [
                {
                    "id": row.id,
                    "machine_id": row.machine_id,
                    "machine_name": next(
                        (
                            machine.name for machine in machines
                            if machine.id == row.machine_id
                        ),
                        row.machine_id,
                    ),
                    "failure_type": row.failure_type,
                    "description": row.description,
                    "detected_at": row.detected_at,
                    "resolved_at": row.resolved_at,
                    "status": "resolved" if row.resolved_at else "open",
                }
                for row in period_failures[:MAX_REPORT_ROWS]
            ],
        },
        "downtime_cost": costs,
        "machines": machine_data,
    }


def _critical_events(
    db: Session,
    start: datetime,
    end: datetime,
    machine_id: str | None,
    limit: int,
    acquisition_mode: str | None = None,
) -> list[dict]:
    statement = _acquisition_scope(_failure_scope(
        select(
            MaintenanceFailureRow,
            MachineRow.name.label("machine_name"),
            AlertRow.severity.label("severity"),
            AlertRow.status.label("alert_status"),
            AlertRow.value.label("alert_value"),
            AlertRow.acquisition_mode.label("acquisition_mode"),
        )
        .join(MachineRow, MachineRow.id == MaintenanceFailureRow.machine_id)
        .join(AlertRow, AlertRow.id == MaintenanceFailureRow.alert_id)
        .where(
            MachineRow.active.is_(True),
            MaintenanceFailureRow.detected_at >= start,
            MaintenanceFailureRow.detected_at < end,
        )
        .order_by(desc(MaintenanceFailureRow.detected_at), desc(MaintenanceFailureRow.id))
        .limit(limit),
        machine_id,
    ), acquisition_mode)
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
            "acquisition_mode": event_mode,
            "detected_at": failure.detected_at,
            "resolved_at": failure.resolved_at,
        }
        for failure, machine_name, severity, alert_status, alert_value, event_mode
        in db.execute(statement)
    ]


@router.get("/overview")
def director_overview(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    acquisition_mode: Literal["hardware", "simulated", "unknown"] | None = Query(default=None),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    return _overview(db, period_start, period_end, machine_id, acquisition_mode)


@router.get("/events")
def director_events(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    acquisition_mode: Literal["hardware", "simulated", "unknown"] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=MAX_REPORT_ROWS),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    _validate_machine(db, machine_id)
    return _critical_events(db, period_start, period_end, machine_id, limit, acquisition_mode)


@router.get("/report")
def director_report(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    acquisition_mode: Literal["hardware", "simulated", "unknown"] | None = Query(default=None),
    db: Session = Depends(get_db),
    user: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    _validate_machine(db, machine_id)
    summary = _overview(db, period_start, period_end, machine_id, acquisition_mode)
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
            db, period_start, period_end, machine_id, MAX_REPORT_ROWS, acquisition_mode
        ),
        "interventions": interventions,
        "generated_for_user": user.full_name or user.email,
        "row_limit": MAX_REPORT_ROWS,
    }


@router.put("/machines/{machine_id}/cost-rate")
def set_machine_cost_rate(
    machine_id: str,
    data: DirectorCostRateInput,
    db: Session = Depends(get_db),
    director: UserRow = Depends(director_only),
):
    machine = db.get(MachineRow, machine_id)
    if machine is None or not machine.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine introuvable ou inactive.")
    row = DirectorMachineCostRateRow(
        machine_id=machine.id,
        hourly_rate=data.hourly_rate,
        currency=data.currency,
        updated_by_id=director.id,
        updated_by_name=director.full_name,
        updated_by_email=director.email,
        updated_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "machine_id": row.machine_id,
        "hourly_rate": float(row.hourly_rate),
        "currency": row.currency,
        "updated_at": row.updated_at,
        "updated_by": row.updated_by_name or row.updated_by_email,
    }


@router.get("/costs")
def director_costs(
    days: int = Query(default=30, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    period_start, period_end = _period(days, start, end)
    return _overview(db, period_start, period_end, machine_id)


@router.get("/cost-rates")
def director_cost_rates(
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    machines = db.scalars(
        select(MachineRow)
        .where(MachineRow.active.is_(True))
        .order_by(MachineRow.name)
    ).all()
    _, latest = _rate_history(
        db, [machine.id for machine in machines], datetime.now(timezone.utc)
    )
    return [
        {
            "machine_id": machine.id,
            "machine_name": machine.name,
            "hourly_rate": float(latest[machine.id].hourly_rate)
            if machine.id in latest else None,
            "currency": latest[machine.id].currency
            if machine.id in latest else None,
            "updated_at": latest[machine.id].updated_at
            if machine.id in latest else None,
            "updated_by": (
                latest[machine.id].updated_by_name
                or latest[machine.id].updated_by_email
            ) if machine.id in latest else None,
        }
        for machine in machines
    ]


@router.get("/cost-rates/history")
def director_cost_rate_history(
    machine_id: str | None = Query(default=None, min_length=2, max_length=80),
    limit: int = Query(default=100, ge=1, le=MAX_REPORT_ROWS),
    db: Session = Depends(get_db),
    _: UserRow = Depends(director_only),
):
    _validate_machine(db, machine_id)
    statement = (
        select(
            DirectorMachineCostRateRow,
            MachineRow.name.label("machine_name"),
        )
        .join(MachineRow, MachineRow.id == DirectorMachineCostRateRow.machine_id)
        .where(MachineRow.active.is_(True))
        .order_by(
            desc(DirectorMachineCostRateRow.updated_at),
            desc(DirectorMachineCostRateRow.id),
        )
        .limit(limit)
    )
    if machine_id is not None:
        statement = statement.where(DirectorMachineCostRateRow.machine_id == machine_id)
    return [
        {
            "id": row.id,
            "machine_id": row.machine_id,
            "machine_name": machine_name,
            "hourly_rate": float(row.hourly_rate),
            "currency": row.currency,
            "updated_at": row.updated_at,
            "updated_by": row.updated_by_name or row.updated_by_email,
        }
        for row, machine_name in db.execute(statement)
    ]
