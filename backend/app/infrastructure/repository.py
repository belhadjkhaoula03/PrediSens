from datetime import datetime, timezone
from sqlalchemy import desc, select
from sqlalchemy.orm import Session
from app.application.services import MeasurementInput
from app.infrastructure.models import (
    AlertEventRow,
    AlertRow,
    MachineRow,
    MachineTechnicianAccessRow,
    MaintenanceFailureRow,
    MeasurementRow,
    TechnicianNotificationRow,
    ThresholdRow,
)
from app.domain.models import Telemetry, Threshold, evaluate_thresholds


class SqlMeasurementRepository:
    def __init__(self, session: Session):
        self.session = session

    def receive(self, machine_id: str, data: MeasurementInput) -> MeasurementRow:
        machine = self.session.get(MachineRow, machine_id)
        if machine is None:
            raise LookupError("Machine non déclarée")
        if not machine.active:
            raise ValueError("Machine archivée")
        row = MeasurementRow(machine_id=machine_id, **data.model_dump(), recorded_at=datetime.now(timezone.utc))
        machine.status, machine.last_seen = "online", row.recorded_at
        self.session.add(row)
        self.session.flush()
        thresholds = self.session.scalars(select(ThresholdRow).where(ThresholdRow.machine_id == machine_id, ThresholdRow.enabled.is_(True))).all()
        readings = Telemetry(data.temperature, data.humidity, data.vibration_rate, data.vibration_edges, data.current_rms, data.current_source)
        domain_thresholds = [Threshold(t.metric, t.warning, t.critical) for t in thresholds]
        for threshold, (metric, decision) in zip(thresholds, evaluate_thresholds(readings, domain_thresholds)):
            value = decision.value
            severity = decision.severity.value if decision.severity else None
            current = self.session.scalar(select(AlertRow).where(AlertRow.machine_id == machine_id, AlertRow.metric == threshold.metric, AlertRow.status != "closed").order_by(desc(AlertRow.created_at)))
            if severity:
                if current:
                    current.severity, current.value = severity, value
                else:
                    current = AlertRow(
                        machine_id=machine_id,
                        metric=threshold.metric,
                        severity=severity,
                        value=value,
                        status="new",
                    )
                    self.session.add(current)
                    self.session.flush()
                    self.session.add(AlertEventRow(alert_id=current.id, action="created", details=severity))
                    technician_ids = self.session.scalars(
                        select(MachineTechnicianAccessRow.technician_id).where(
                            MachineTechnicianAccessRow.machine_id == machine_id
                        )
                    ).all()
                    machine_name = self.session.get(MachineRow, machine_id).name
                    for technician_id in technician_ids:
                        self.session.add(
                            TechnicianNotificationRow(
                                user_id=technician_id,
                                notification_key=f"alert:{current.id}",
                                notification_type="alert",
                                message=f"Nouvelle alerte {severity} sur {machine_name} ({threshold.metric}).",
                                target_type="alert",
                                target_id=str(current.id),
                            )
                        )
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
        return row
