from datetime import datetime, timezone
from sqlalchemy import desc, select
from sqlalchemy.orm import Session
from app.application.services import MeasurementInput
from app.infrastructure.models import (
    AlertEventRow,
    AlertRow,
    MachineRow,
    MachineStatusEventRow,
    MachineTechnicianAccessRow,
    MaintenanceFailureRow,
    MeasurementRow,
    MeasurementSensorSourceRow,
    SensorRow,
    TechnicianNotificationRow,
    ThresholdRow,
)
from app.infrastructure.web_push import dispatch_web_push
from app.domain.models import Telemetry, Threshold, evaluate_thresholds


def record_machine_status(
    session: Session,
    machine: MachineRow,
    status: str,
    source: str,
    occurred_at: datetime,
) -> None:
    previous = session.scalar(
        select(MachineStatusEventRow)
        .where(MachineStatusEventRow.machine_id == machine.id)
        .order_by(desc(MachineStatusEventRow.occurred_at), desc(MachineStatusEventRow.id))
        .limit(1)
    )
    if previous is None or previous.status != status:
        session.add(
            MachineStatusEventRow(
                machine_id=machine.id,
                status=status,
                source=source,
                occurred_at=occurred_at,
            )
        )
    machine.status = status


class SqlMeasurementRepository:
    def __init__(self, session: Session):
        self.session = session

    def receive(self, machine_id: str, data: MeasurementInput) -> MeasurementRow:
        machine = self.session.get(MachineRow, machine_id)
        if machine is None:
            raise LookupError("Machine non déclarée")
        if not machine.active:
            raise ValueError("Machine archivée")
        received_at = datetime.now(timezone.utc)
        row = MeasurementRow(
            machine_id=machine_id,
            **data.model_dump(),
            recorded_at=received_at,
            received_at=received_at,
        )
        record_machine_status(self.session, machine, "online", "telemetry", row.recorded_at)
        machine.last_seen = row.recorded_at
        self.session.add(row)
        self.session.flush()
        if data.acquisition_mode == "hardware":
            sensors = self.session.scalars(
                select(SensorRow).where(
                    SensorRow.machine_id == machine_id,
                    SensorRow.enabled.is_(True),
                )
            ).all()
            sensors_by_metric = {sensor.metric: sensor.id for sensor in sensors}
            for metric in ("temperature", "humidity", "vibration_rate", "current_rms"):
                if metric == "current_rms" and (
                    data.current_rms is None or data.current_source != "hardware"
                ):
                    continue
                sensor_id = sensors_by_metric.get(metric)
                if sensor_id is not None:
                    self.session.add(
                        MeasurementSensorSourceRow(
                            measurement_id=row.id,
                            metric=metric,
                            sensor_id=sensor_id,
                        )
                    )
        thresholds = self.session.scalars(select(ThresholdRow).where(ThresholdRow.machine_id == machine_id, ThresholdRow.enabled.is_(True))).all()
        readings = Telemetry(data.temperature, data.humidity, data.vibration_rate, data.vibration_edges, data.current_rms, data.current_source)
        domain_thresholds = [Threshold(t.metric, t.warning, t.critical) for t in thresholds]
        notifications = []
        for threshold, (metric, decision) in zip(thresholds, evaluate_thresholds(readings, domain_thresholds)):
            if metric == "current_rms" and data.current_rms is None:
                continue
            value = decision.value
            severity = decision.severity.value if decision.severity else None
            current = self.session.scalar(
                select(AlertRow)
                .where(
                    AlertRow.machine_id == machine_id,
                    AlertRow.metric == threshold.metric,
                    AlertRow.acquisition_mode == data.acquisition_mode,
                    AlertRow.status.not_in(("closed", "false_positive")),
                )
                .order_by(desc(AlertRow.created_at), desc(AlertRow.id))
            )
            if severity:
                if current:
                    current.severity, current.value = severity, value
                else:
                    detected_at = datetime.now(timezone.utc)
                    current = AlertRow(
                        machine_id=machine_id,
                        metric=threshold.metric,
                        severity=severity,
                        value=value,
                        acquisition_mode=data.acquisition_mode,
                        status="new",
                        created_at=detected_at,
                    )
                    self.session.add(current)
                    self.session.flush()
                    processing_delay_ms = max(
                        0,
                        int((detected_at - received_at).total_seconds() * 1000),
                    )
                    self.session.add(
                        AlertEventRow(
                            alert_id=current.id,
                            action="created",
                            details=severity,
                            source_measurement_id=row.id,
                            processing_delay_ms=processing_delay_ms,
                            created_at=detected_at,
                        )
                    )
                    technician_ids = self.session.scalars(
                        select(MachineTechnicianAccessRow.technician_id).where(
                            MachineTechnicianAccessRow.machine_id == machine_id
                        )
                    ).all()
                    machine_name = self.session.get(MachineRow, machine_id).name
                    for technician_id in technician_ids:
                        notification = TechnicianNotificationRow(
                            user_id=technician_id,
                            notification_key=f"alert:{current.id}",
                            notification_type="alert",
                            message=f"Nouvelle alerte {severity} sur {machine_name} ({threshold.metric}).",
                            target_type="alert",
                            target_id=str(current.id),
                        )
                        self.session.add(notification)
                        notifications.append(notification)
                if severity == "critical" and current:
                    failure = self.session.scalar(
                        select(MaintenanceFailureRow).where(MaintenanceFailureRow.alert_id == current.id)
                    )
                    if failure is None:
                        self.session.add(
                            MaintenanceFailureRow(
                                alert_id=current.id,
                                machine_id=machine_id,
                                failure_type=threshold.metric,
                                description=(
                                    f"Dépassement critique du seuil pour {threshold.metric}; "
                                    "un diagnostic est requis."
                                ),
                                detected_at=datetime.now(timezone.utc),
                            )
                        )
            elif current:
                current.status, current.closed_at = "closed", datetime.now(timezone.utc)
                self.session.add(AlertEventRow(alert_id=current.id, action="auto_closed"))
                failure = self.session.scalar(
                    select(MaintenanceFailureRow).where(MaintenanceFailureRow.alert_id == current.id)
                )
                if failure is not None and failure.resolved_at is None:
                    failure.resolved_at = current.closed_at
                    if not failure.result:
                        failure.result = "Les mesures sont repassées sous le seuil d'avertissement."
        self.session.commit()
        dispatch_web_push(self.session, notifications)
        return row
