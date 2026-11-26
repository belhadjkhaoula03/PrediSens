from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
from types import SimpleNamespace
import app.main as main_module
from .conftest import TestingSession, auth
from jose import jwt
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.infrastructure.database import Base
from app.api import routes as api_routes
from app.infrastructure.models import (
    AlertRow,
    DatabaseBackupRow,
    DirectorMachineCostRateRow,
    InterventionRow,
    MaintenanceFailureRow,
    ManagerFailureRow,
    MachineRow,
    MachineStatusEventRow,
    MeasurementRow,
    MeasurementSensorSourceRow,
    PasswordResetTokenRow,
    PushSubscriptionRow,
    SensorReplacementRow,
    SensorRow,
    SystemSettingRow,
    TechnicianNotificationRow,
    ThresholdRow,
    UserRow,
)
from app.application.services import MeasurementInput
from app.infrastructure import mqtt_client as mqtt_api
from app.simulation import build_measurement

def sample(**overrides):
    data = {"seq": 1, "temperature": 25, "humidity": 55, "vibration_rate": 0, "vibration_edges": 0, "current_rms": 0, "current_source": "simulated", "acquisition_mode": "simulated"}
    return data | overrides

def test_web_shell_uses_versioned_assets_and_root_service_worker(client):
    page = client.get("/")
    assert page.status_code == 200
    assert page.headers["cache-control"] == "no-cache"
    assert '/static/styles.css?v=30' in page.text
    assert '/static/measurement-ui.js?v=30' in page.text
    assert '/static/profile.js?v=30' in page.text
    assert '/static/director.js?v=30' in page.text
    assert '/static/app.js?v=30' in page.text
    assert '/static/technician.js?v=30' in page.text
    assert 'data-admin-page="sensor-replacements"' in page.text
    assert 'data-admin-page="backups"' in page.text
    assert 'id="director-app"' in page.text
    assert 'id="manager-sidebar"' in page.text
    assert 'id="manager-main" class="manager-main"' in page.text
    assert 'data-manager-page="performance"' in page.text
    assert 'data-manager-page="comparison"' in page.text
    assert 'id="manager-performance-kpis"' in page.text
    worker = client.get("/service-worker.js?v=30")
    assert worker.status_code == 200
    assert worker.headers["service-worker-allowed"] == "/"
    assert worker.headers["cache-control"] == "no-cache"
    assert "/static/measurement-ui.js?v=30" in worker.text
    assert "/static/director.js?v=30" in worker.text
    assert "/static/technician.js?v=30" in worker.text

def test_login_and_machine_requires_auth(client):
    assert client.get("/api/machines").status_code == 401
    assert client.post("/api/auth/login", json={"email":"technician@test.local", "password":"wrong"}).status_code == 401
    machines = client.get("/api/machines", headers=auth(client, "technician"))
    assert machines.status_code == 200
    machine = next(item for item in machines.json() if item["id"] == "test-machine")
    assert machine["measurement_server_time"]
    assert machine["last_measurement_mode"] is None
    assert machine["measurement_age_seconds"] is None

def test_telemetry_persists_and_creates_threshold_alert(client):
    assert client.post("/api/telemetry/test-machine", json=sample(temperature=75)).status_code == 401
    response = client.post("/api/telemetry/test-machine", headers=auth(client, "manager"), json=sample(temperature=75))
    assert response.status_code == 202
    h = auth(client, "technician")
    latest = client.get("/api/machines/test-machine/telemetry", headers=h).json()[0]
    assert latest["temperature"] == 75
    assert latest["acquisition_mode"] == "simulated"
    alerts = client.get("/api/alerts", headers=h).json()
    assert alerts[0]["severity"] == "critical"


def test_measurement_input_requires_explicit_provenance_and_keeps_modes_distinct():
    hardware_with_simulated_current = MeasurementInput.model_validate(sample(
        acquisition_mode="hardware",
        current_source="simulated",
    ))
    simulated = MeasurementInput.model_validate(sample(
        acquisition_mode="simulated",
        current_source="simulated",
    ))
    assert hardware_with_simulated_current.acquisition_mode == "hardware"
    assert hardware_with_simulated_current.current_source == "simulated"
    assert simulated.acquisition_mode == "simulated"

    missing_mode = sample()
    del missing_mode["acquisition_mode"]
    missing_source = sample()
    del missing_source["current_source"]
    assert pytest.raises(ValidationError, MeasurementInput.model_validate, missing_mode)
    assert pytest.raises(ValidationError, MeasurementInput.model_validate, missing_source)
    assert pytest.raises(
        ValidationError,
        MeasurementInput.model_validate,
        sample(acquisition_mode="unknown"),
    )


def test_telemetry_filter_returns_only_requested_acquisition_mode(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    for mode, temperature in (("simulated", 28), ("hardware", 31)):
        response = client.post(
            "/api/telemetry/test-machine",
            headers=manager,
            json=sample(acquisition_mode=mode, temperature=temperature),
        )
        assert response.status_code == 202

    all_rows = client.get("/api/machines/test-machine/telemetry", headers=technician)
    hardware_rows = client.get(
        "/api/machines/test-machine/telemetry?acquisition_mode=hardware",
        headers=technician,
    )
    simulated_rows = client.get(
        "/api/machines/test-machine/telemetry?acquisition_mode=simulated",
        headers=technician,
    )
    assert {row["acquisition_mode"] for row in all_rows.json()} == {"hardware", "simulated"}
    assert [row["temperature"] for row in hardware_rows.json()] == [31]
    assert [row["temperature"] for row in simulated_rows.json()] == [28]
    latest = hardware_rows.json()[0]
    assert latest["server_time"]
    assert latest["age_seconds"] >= 0
    server_time = datetime.fromisoformat(latest["server_time"].replace("Z", "+00:00"))
    recorded_at = datetime.fromisoformat(latest["recorded_at"].replace("Z", "+00:00"))
    if recorded_at.tzinfo is None:
        recorded_at = recorded_at.replace(tzinfo=timezone.utc)
    assert abs(latest["age_seconds"] - (server_time - recorded_at).total_seconds()) < 1


def test_alert_unknown_filter_returns_only_legacy_alerts(client):
    db = TestingSession()
    try:
        db.add(AlertRow(
            machine_id="test-machine",
            metric="temperature",
            severity="warning",
            value=75,
            acquisition_mode=None,
        ))
        db.commit()
    finally:
        db.close()

    technician = auth(client, "technician")
    unknown = client.get("/api/alerts?acquisition_mode=unknown", headers=technician)
    hardware = client.get("/api/alerts?acquisition_mode=hardware", headers=technician)
    assert unknown.status_code == 200
    assert len(unknown.json()) == 1
    assert unknown.json()[0]["acquisition_mode"] is None
    assert hardware.json() == []


def test_dashboard_filters_latest_measurement_by_mode(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    for mode, temperature in (("hardware", 32), ("simulated", 28)):
        assert client.post(
            "/api/telemetry/test-machine",
            headers=manager,
            json=sample(acquisition_mode=mode, temperature=temperature),
        ).status_code == 202

    hardware = client.get(
        "/api/dashboard?acquisition_mode=hardware", headers=technician
    ).json()
    simulated = client.get(
        "/api/dashboard?acquisition_mode=simulated", headers=technician
    ).json()
    assert hardware["latest"]["acquisition_mode"] == "hardware"
    assert hardware["latest"]["temperature"] == 32
    assert simulated["latest"]["acquisition_mode"] == "simulated"
    assert simulated["latest"]["temperature"] == 28
    assert hardware["server_time"]
    technician_overview = client.get(
        "/api/technician/overview?acquisition_mode=hardware", headers=technician
    ).json()
    assert technician_overview["server_time"]
    assert technician_overview["latest"]["age_seconds"] >= 0


def test_unavailable_current_is_stored_as_null_and_does_not_trigger_alert(client):
    db = TestingSession()
    try:
        db.add(ThresholdRow(machine_id="test-machine", metric="current_rms", warning=0.1, critical=0.2))
        db.commit()
    finally:
        db.close()

    payload = sample(current_source="unavailable", acquisition_mode="hardware", current_rms=0)
    measurement = MeasurementInput.model_validate(payload)
    assert measurement.current_rms is None
    with pytest.raises(ValidationError):
        MeasurementInput.model_validate(
            sample(current_source="unavailable", acquisition_mode="hardware", current_rms=0.5)
        )

    response = client.post(
        "/api/telemetry/test-machine",
        headers=auth(client, "manager"),
        json=payload,
    )
    assert response.status_code == 202
    rows = client.get(
        "/api/machines/test-machine/telemetry?acquisition_mode=hardware",
        headers=auth(client, "technician"),
    ).json()
    assert rows[-1]["current_rms"] is None
    assert not [
        alert for alert in client.get("/api/alerts?acquisition_mode=hardware", headers=auth(client, "technician")).json()
        if alert["metric"] == "current_rms"
    ]


def test_alerts_are_isolated_by_acquisition_mode(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")

    def ingest(mode, temperature):
        response = client.post(
            "/api/telemetry/test-machine",
            headers=manager,
            json=sample(acquisition_mode=mode, temperature=temperature),
        )
        assert response.status_code == 202

    ingest("hardware", 75)
    ingest("simulated", 40)
    hardware_alerts = client.get("/api/alerts?acquisition_mode=hardware", headers=technician).json()
    assert len(hardware_alerts) == 1
    assert hardware_alerts[0]["status"] == "new"
    assert hardware_alerts[0]["acquisition_mode"] == "hardware"

    ingest("simulated", 75)
    ingest("hardware", 40)
    hardware_alerts = client.get("/api/alerts?acquisition_mode=hardware", headers=technician).json()
    simulated_alerts = client.get("/api/alerts?acquisition_mode=simulated", headers=technician).json()
    assert len(hardware_alerts) == 1
    assert hardware_alerts[0]["status"] == "closed"
    assert len(simulated_alerts) == 1
    assert simulated_alerts[0]["status"] == "new"
    assert simulated_alerts[0]["acquisition_mode"] == "simulated"


def test_mqtt_ingestor_subscribes_and_persists_validated_message(client, monkeypatch, caplog):
    class FakeMqttClient:
        def __init__(self):
            self.subscriptions = []

        def subscribe(self, topic, qos):
            self.subscriptions.append((topic, qos))
            return 0, len(self.subscriptions)

    fake_client = FakeMqttClient()
    ingestor = mqtt_api.MqttIngestor()
    ingestor.on_connect(fake_client, None, None, 0, None)
    assert fake_client.subscriptions == [
        ("predimaint/+/telemetry", 1),
        ("predimaint/+/status", 1),
    ]
    for message_id in (1, 2):
        ingestor.on_subscribe(
            fake_client,
            None,
            message_id,
            [SimpleNamespace(is_failure=False)],
            None,
        )

    monkeypatch.setattr(mqtt_api, "SessionLocal", TestingSession)
    payload = sample(
        seq=73,
        temperature=31.5,
        current_source="simulated",
        acquisition_mode="hardware",
    )
    ingestor.on_message(
        None,
        None,
        SimpleNamespace(
            topic="predimaint/test-machine/telemetry",
            payload=json.dumps(payload).encode(),
        ),
    )
    ingestor.on_message(
        None,
        None,
        SimpleNamespace(
            topic="predimaint/test-machine/telemetry",
            payload=json.dumps({key: value for key, value in payload.items() if key != "acquisition_mode"}).encode(),
        ),
    )

    db = TestingSession()
    try:
        rows = db.query(MeasurementRow).filter_by(machine_id="test-machine").all()
        assert len(rows) == 1
        assert rows[0].seq == 73
        assert rows[0].temperature == 31.5
        assert rows[0].current_source == "simulated"
        assert rows[0].acquisition_mode == "hardware"
    finally:
        db.close()
    assert "Abonnement MQTT confirmé (topic=predimaint/+/telemetry)" in caplog.text
    assert "Mesure MQTT validée (machine_id=test-machine, seq=73, acquisition_mode=hardware, current_source=simulated)" in caplog.text
    assert "Mesure enregistrée dans PostgreSQL" in caplog.text
    assert "Message MQTT rejeté (topic=predimaint/test-machine/telemetry, erreur=ValidationError, champs=acquisition_mode:missing)" in caplog.text


def test_director_cannot_acknowledge_alert(client):
    client.post("/api/telemetry/test-machine", headers=auth(client, "manager"), json=sample(temperature=80))
    h = auth(client, "director")
    alert_id = client.get("/api/alerts", headers=h).json()[0]["id"]
    assert client.post(f"/api/alerts/{alert_id}/acknowledge", headers=h).status_code == 403


def test_director_dashboard_reports_only_persisted_data_and_guards_role(client):
    assert client.get("/api/director/overview").status_code == 401
    assert client.get("/api/director/overview", headers=auth(client, "technician")).status_code == 403
    headers = auth(client, "director")
    now = datetime.now(timezone.utc)
    db = TestingSession()
    try:
        manager = db.query(UserRow).filter_by(role="manager").one()
        technician = db.query(UserRow).filter_by(role="technician").one()
        alert = AlertRow(
            machine_id="test-machine",
            metric="temperature",
            severity="critical",
            value=82,
            status="new",
            created_at=now,
        )
        db.add(alert)
        db.flush()
        db.add(MaintenanceFailureRow(
            alert_id=alert.id,
            machine_id="test-machine",
            failure_type="temperature",
            description="Dépassement du seuil critique",
            detected_at=now,
        ))
        db.add(InterventionRow(
            machine_id="test-machine",
            user_id=manager.id,
            assigned_to_id=technician.id,
            title="Contrôle du capteur",
            description="Vérification",
            status="assigned",
            duration_minutes=0,
            created_at=now,
        ))
        db.commit()
    finally:
        db.close()

    overview = client.get("/api/director/overview?days=7", headers=headers)
    assert overview.status_code == 200
    data = overview.json()
    assert data["machine_count"] == 1
    assert data["critical_event_count"] == 1
    assert data["availability"]["value"] == 0
    assert data["availability"]["coverage"] == 0
    assert data["mtbf"]["value_hours"] is None
    assert data["mtbf"]["reason"] == "Non calculable – aucune panne confirmée sur la période."
    assert data["mttr"]["value_hours"] is None

    events = client.get("/api/director/events?days=7&machine_id=test-machine", headers=headers)
    assert events.status_code == 200
    assert events.json()[0]["metric"] == "temperature"
    assert events.json()[0]["alert_status"] == "new"
    assert events.json()[0]["acquisition_mode"] is None
    unknown_events = client.get(
        "/api/director/events?days=7&machine_id=test-machine&acquisition_mode=unknown",
        headers=headers,
    )
    assert len(unknown_events.json()) == 1
    hardware_events = client.get(
        "/api/director/events?days=7&machine_id=test-machine&acquisition_mode=hardware",
        headers=headers,
    )
    assert hardware_events.json() == []

    report = client.get("/api/director/report?days=7", headers=headers)
    assert report.status_code == 200
    assert len(report.json()["interventions"]) == 1
    assert report.json()["intervention_counts"] == {"assigned": 1}
    assert report.json()["events"][0]["description"] == "Dépassement du seuil critique"

    assert client.get(
        "/api/director/overview?start=2025-01-02T00:00:00Z",
        headers=headers,
    ).status_code == 422
    assert client.get(
        "/api/director/overview?start=2025-01-02T00:00:00Z&end=2025-01-01T00:00:00Z",
        headers=headers,
    ).status_code == 422
    assert client.get("/api/director/overview?machine_id=missing", headers=headers).status_code == 404


def test_director_cost_rates_and_confirmed_downtime_are_audited_and_authorized(client):
    assert client.get("/api/director/cost-rates").status_code == 401
    assert client.get(
        "/api/director/cost-rates", headers=auth(client, "technician")
    ).status_code == 403
    director_headers = auth(client, "director")
    manager_headers = auth(client, "manager")
    now = datetime.now(timezone.utc)
    db = TestingSession()
    try:
        director = db.query(UserRow).filter_by(role="director").one()
        manager = db.query(UserRow).filter_by(role="manager").one()
        db.add(DirectorMachineCostRateRow(
            machine_id="test-machine",
            hourly_rate=Decimal("3.000"),
            currency="TND",
            updated_by_id=director.id,
            updated_by_name=director.full_name,
            updated_by_email=director.email,
            updated_at=now - timedelta(hours=3),
        ))
        db.add_all([
            ManagerFailureRow(
                machine_id="test-machine",
                failure_type="mechanical",
                description="Panne contrôlée A",
                detected_by_id=manager.id,
                detected_at=now - timedelta(hours=2),
                resolved_at=now - timedelta(hours=1),
            ),
            ManagerFailureRow(
                machine_id="test-machine",
                failure_type="electrical",
                description="Panne contrôlée B avec recouvrement",
                detected_by_id=manager.id,
                detected_at=now - timedelta(minutes=90),
                resolved_at=now - timedelta(minutes=30),
            ),
        ])
        db.commit()
    finally:
        db.close()

    rates = client.get("/api/director/cost-rates", headers=director_headers)
    assert rates.status_code == 200
    assert rates.json()[0]["hourly_rate"] == 3
    assert rates.json()[0]["currency"] == "TND"

    overview = client.get(
        "/api/director/overview?days=1", headers=director_headers
    ).json()
    assert overview["failure_metrics"]["confirmed_failure_count"] == 2
    assert overview["failure_metrics"]["confirmed_downtime_hours"] == pytest.approx(1.5)
    assert overview["downtime_cost"]["costs_by_currency"]["TND"] == pytest.approx(4.5)
    assert overview["downtime_cost"]["unpriced_downtime_hours"] == 0
    assert overview["mtbf"]["value_hours"] is None
    assert overview["mtbf"]["reason"] == (
        "Non calculable – aucune durée de fonctionnement observée."
    )

    saved = client.put(
        "/api/director/machines/test-machine/cost-rate",
        headers=director_headers,
        json={"hourly_rate": 5, "currency": "EUR"},
    )
    assert saved.status_code == 200
    assert saved.json()["updated_by"] == "Director"
    assert client.put(
        "/api/director/machines/test-machine/cost-rate",
        headers=manager_headers,
        json={"hourly_rate": 4, "currency": "TND"},
    ).status_code == 403
    assert client.put(
        "/api/director/machines/test-machine/cost-rate",
        headers=director_headers,
        json={"hourly_rate": -1, "currency": "TND"},
    ).status_code == 422
    history = client.get(
        "/api/director/cost-rates/history?machine_id=test-machine",
        headers=director_headers,
    )
    assert history.status_code == 200
    assert len(history.json()) == 2
    assert history.json()[0]["currency"] == "EUR"


def test_director_availability_counts_stale_and_offline_periods(client):
    director_headers = auth(client, "director")
    now = datetime.now(timezone.utc) - timedelta(seconds=2)
    db = TestingSession()
    try:
        machine = db.get(MachineRow, "test-machine")
        machine.created_at = now - timedelta(seconds=120)
        machine.status = "offline"
        db.add(MeasurementRow(
            machine_id=machine.id,
            seq=1,
            temperature=25,
            humidity=55,
            vibration_rate=0,
            vibration_edges=0,
            current_rms=0,
            current_source="simulated",
            acquisition_mode="hardware",
            recorded_at=now - timedelta(seconds=90),
        ))
        db.add(MachineStatusEventRow(
            machine_id=machine.id,
            status="offline",
            source="mqtt",
            occurred_at=now - timedelta(seconds=60),
        ))
        db.add(SystemSettingRow(
            key="director_telemetry_stale_seconds",
            value="30",
        ))
        db.commit()
    finally:
        db.close()

    response = client.get(
        "/api/director/overview?days=1", headers=director_headers
    )
    assert response.status_code == 200
    data = response.json()
    machine = data["machines"][0]
    assert machine["telemetry_state"] == "stale"
    assert 20 <= data["availability"]["online_hours"] * 3600 <= 40
    assert 85 <= data["availability"]["unavailable_hours"] * 3600 <= 105
    assert 25 <= data["availability"]["unobserved_hours"] * 3600 <= 40
    assert data["availability"]["coverage"] < 100


def test_only_manager_can_update_thresholds(client):
    tech = auth(client, "technician"); manager = auth(client, "manager")
    path = "/api/thresholds/test-machine/temperature"
    assert client.put(path, headers=tech, json={"warning":55,"critical":75}).status_code == 403
    assert client.put(path, headers=manager, json={"warning":55,"critical":75}).status_code == 200


def test_manager_performance_calculates_observed_availability_mtbf_mttr_and_sla(client):
    manager = auth(client, "manager")
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=10)
    downtime_start = now - timedelta(hours=2)
    db = TestingSession()
    try:
        machine = db.get(MachineRow, "test-machine")
        machine.created_at = start
        machine.status = "offline"
        manager_user = db.query(UserRow).filter_by(role="manager").one()
        db.add_all([
            MachineStatusEventRow(
                machine_id=machine.id, status="online", source="test", occurred_at=start,
            ),
            MachineStatusEventRow(
                machine_id=machine.id, status="offline", source="test", occurred_at=downtime_start,
            ),
            ManagerFailureRow(
                machine_id=machine.id,
                failure_type="mechanical",
                description="Panne de test contrôlée",
                detected_by_id=manager_user.id,
                detected_at=downtime_start,
                resolved_at=now,
                diagnosis="Défaut confirmé",
                work_done="Pièce contrôlée",
                result="Machine rétablie",
            ),
        ])
        db.commit()
    finally:
        db.close()

    params = {"start": start.isoformat(), "end": now.isoformat()}
    response = client.get("/api/manager/performance", params=params, headers=manager)
    assert response.status_code == 200
    data = response.json()
    assert data["availability"]["online_hours"] == pytest.approx(8, abs=0.01)
    assert data["availability"]["offline_hours"] == pytest.approx(2, abs=0.01)
    assert data["availability"]["value"] == pytest.approx(80, abs=0.01)
    assert data["availability"]["coverage_percentage"] == pytest.approx(100, abs=0.01)
    assert data["confirmed_failure_count"] == 1
    assert data["mtbf"]["value_hours"] == pytest.approx(8, abs=0.01)
    assert data["mttr"]["value_hours"] == pytest.approx(2, abs=0.01)

    assert client.put(
        "/api/manager/performance/sla",
        headers=manager,
        json={"target_percentage": 99.9},
    ).status_code == 200
    sla = client.get(
        "/api/manager/performance",
        params=params,
        headers=manager,
    ).json()["sla"]
    assert sla["target_percentage"] == pytest.approx(99.9)
    assert sla["tolerated_offline_hours"] == pytest.approx(0.01, abs=0.0001)
    assert sla["status"] == "missed"
    assert client.get("/api/manager/performance").status_code == 401
    assert client.get(
        "/api/manager/performance", headers=auth(client, "technician")
    ).status_code == 403


def test_manager_performance_sla_tolerance_for_720_hours(client):
    manager = auth(client, "manager")
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=720)
    downtime_start = now - timedelta(hours=0.72)
    db = TestingSession()
    try:
        machine = db.get(MachineRow, "test-machine")
        machine.created_at = start
        machine.status = "offline"
        db.add_all([
            MachineStatusEventRow(
                machine_id=machine.id, status="online", source="test", occurred_at=start,
            ),
            MachineStatusEventRow(
                machine_id=machine.id, status="offline", source="test", occurred_at=downtime_start,
            ),
        ])
        db.commit()
    finally:
        db.close()
    params = {"start": start.isoformat(), "end": now.isoformat()}
    assert client.put(
        "/api/manager/performance/sla",
        headers=manager,
        json={"target_percentage": 99.9},
    ).status_code == 200
    result = client.get(
        "/api/manager/performance", params=params, headers=manager
    ).json()
    assert result["sla"]["tolerated_offline_hours"] == pytest.approx(0.72, abs=0.001)
    assert result["sla"]["status"] == "met"


def test_manager_performance_aggregates_machine_hours_not_percentages(client):
    manager = auth(client, "manager")
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=10)
    short_start = now - timedelta(hours=1)
    db = TestingSession()
    try:
        first = db.get(MachineRow, "test-machine")
        first.created_at = start
        second = MachineRow(
            id="short-observation-machine",
            name="Short observation",
            created_at=short_start,
        )
        db.add(second)
        db.flush()
        db.add_all([
            MachineStatusEventRow(
                machine_id=first.id, status="online", source="test", occurred_at=start,
            ),
            MachineStatusEventRow(
                machine_id=first.id,
                status="offline",
                source="test",
                occurred_at=start + timedelta(hours=8),
            ),
            MachineStatusEventRow(
                machine_id=second.id, status="online", source="test", occurred_at=short_start,
            ),
            MachineStatusEventRow(
                machine_id=second.id,
                status="offline",
                source="test",
                occurred_at=short_start + timedelta(minutes=30),
            ),
        ])
        db.commit()
    finally:
        db.close()
    result = client.get(
        "/api/manager/performance",
        params={"start": start.isoformat(), "end": now.isoformat()},
        headers=manager,
    ).json()
    assert result["availability"]["online_hours"] == pytest.approx(8.5, abs=0.01)
    assert result["availability"]["offline_hours"] == pytest.approx(2.5, abs=0.01)
    assert result["availability"]["value"] == pytest.approx(77.27, abs=0.02)
    assert result["mtbf"]["value_hours"] is None
    assert result["mttr"]["value_hours"] is None


def test_manager_manual_failure_creation_recovery_and_role_restrictions(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    payload = {
        "machine_id": "test-machine",
        "failure_type": "electrical",
        "description": "Panne de test manuelle",
    }
    assert client.post("/api/manager/failures", json=payload).status_code == 401
    assert client.post(
        "/api/manager/failures", headers=technician, json=payload
    ).status_code == 403
    created = client.post("/api/manager/failures", headers=manager, json=payload)
    assert created.status_code == 201
    failure = created.json()
    assert failure["status"] == "open"
    assert failure["detected_by"] == "Manager"
    assert client.get(
        "/api/manager/failures", headers=manager
    ).json()[0]["id"] == failure["id"]
    technician_id = client.get("/api/technicians", headers=manager).json()[0]["id"]
    assignment = client.post(
        "/api/interventions",
        headers=manager,
        json={
            "machine_id": "test-machine",
            "assigned_to_id": technician_id,
            "title": "Réparation panne de test",
            "description": "Diagnostiquer et rétablir l'équipement.",
            "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
            "failure_id": failure["id"],
        },
    )
    assert assignment.status_code == 201
    linked_failure = client.get(
        "/api/manager/failures", headers=manager
    ).json()[0]
    assert linked_failure["intervention_id"] == assignment.json()["id"]

    resolved = client.patch(
        f"/api/manager/failures/{failure['id']}/resolve",
        headers=manager,
        json={
            "diagnosis": "Câble endommagé",
            "work_done": "Câble remplacé",
            "result": "Mesure stable après essai",
        },
    )
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved"
    assert resolved.json()["resolved_at"]
    assert resolved.json()["duration_seconds"] >= 0
    assert client.patch(
        f"/api/manager/failures/{failure['id']}/resolve",
        headers=manager,
        json={
            "diagnosis": "Autre diagnostic",
            "work_done": "Autre travail",
            "result": "Autre résultat",
        },
    ).status_code == 409


def test_manager_marks_false_alert_and_history_excludes_it_from_active_count(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    created = client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(temperature=80),
    )
    assert created.status_code == 202
    alert = client.get("/api/alerts", headers=manager).json()[0]
    path = f"/api/manager/alerts/{alert['id']}/false-positive"
    assert client.post(path, headers=technician).status_code == 403
    marked = client.post(path, headers=manager)
    assert marked.status_code == 200
    assert marked.json()["status"] == "false_positive"
    assert client.get(
        "/api/alerts?status=false_positive", headers=manager
    ).json()[0]["status"] == "false_positive"
    history = client.get(
        f"/api/alerts/{alert['id']}/history", headers=manager
    ).json()
    assert history[-1]["action"] == "false_positive"
    assert client.get(
        "/api/manager/performance", headers=manager
    ).json()["anomaly_count"] == 0


def test_mqtt_status_transitions_are_recorded_once_for_repeated_status(client, monkeypatch):
    manager = auth(client, "manager")
    monkeypatch.setattr(mqtt_api, "SessionLocal", TestingSession)
    ingestor = mqtt_api.MqttIngestor()
    for state in (b"offline", b"online", b"online"):
        ingestor.on_message(
            None,
            None,
            SimpleNamespace(
                topic="predimaint/test-machine/status",
                payload=state,
            ),
        )
    db = TestingSession()
    try:
        events = (
            db.query(MachineStatusEventRow)
            .filter_by(machine_id="test-machine")
            .order_by(MachineStatusEventRow.id)
            .all()
        )
        assert [event.status for event in events] == ["offline", "online"]
        assert all(event.source == "mqtt_status" for event in events)
        assert db.get(MachineRow, "test-machine").status == "online"
    finally:
        db.close()
    assert client.get("/api/manager/performance", headers=manager).status_code == 200


def test_invalid_reading_rejected(client):
    response = client.post("/api/telemetry/test-machine", headers=auth(client, "manager"), json=sample(humidity=140))
    assert response.status_code == 422

def test_normal_reading_closes_active_alert(client):
    manager = auth(client, "manager")
    client.post("/api/telemetry/test-machine", headers=manager, json=sample(temperature=75))
    client.post("/api/telemetry/test-machine", headers=manager, json=sample(seq=2, temperature=40))
    alerts = client.get("/api/alerts", headers=auth(client, "technician")).json()
    assert alerts[0]["status"] == "closed"

def test_manager_can_register_machine_and_sensor(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    machine = {"id": "pump-02", "name": "Pompe 02", "description": "Pompe de test"}
    assert client.post("/api/machines", headers=technician, json=machine).status_code == 403
    assert client.post("/api/machines", headers=manager, json=machine).status_code == 201
    assert client.post("/api/machines", headers=manager, json=machine).status_code == 409
    sensor = {"metric": "temperature", "sensor_type": "DHT22", "gpio": 27, "unit": "°C"}
    created = client.post("/api/machines/pump-02/sensors", headers=manager, json=sensor)
    assert created.status_code == 201
    assert created.json()["machine_id"] == "pump-02"
    assert client.get("/api/machines/pump-02/sensors", headers=auth(client, "director")).json()[0]["metric"] == "temperature"

def test_manager_can_update_and_toggle_sensor(client):
    manager = auth(client, "manager")
    created = client.post(
        "/api/machines/test-machine/sensors",
        headers=manager,
        json={"metric": "temperature", "sensor_type": "DHT22", "gpio": 27, "unit": "°C"},
    )
    assert created.status_code == 201
    sensor_id = created.json()["id"]
    assert client.patch(
        f"/api/sensors/{sensor_id}", headers=manager,
        json={"sensor_type": "DHT22-AM2302", "enabled": False},
    ).json()["enabled"] is False
    assert client.patch(
        f"/api/sensors/{sensor_id}", headers=manager,
        json={"enabled": True},
    ).json()["enabled"] is True
    assert client.patch(
        f"/api/sensors/{sensor_id}", headers=auth(client, "technician"),
        json={"enabled": False},
    ).status_code == 403


def test_admin_sensor_replacement_preserves_old_measurement_sources_and_history(client):
    manager = auth(client, "manager")
    administrator = auth(client, "admin")
    created = client.post(
        "/api/machines/test-machine/sensors",
        headers=manager,
        json={"metric": "temperature", "sensor_type": "DHT22", "gpio": 27, "unit": "°C"},
    )
    assert created.status_code == 201
    old_sensor_id = created.json()["id"]

    first_measurement = client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(
            seq=1,
            acquisition_mode="hardware",
            current_source="hardware",
            current_rms=0.044,
        ),
    )
    assert first_measurement.status_code == 202
    assert client.post(
        f"/api/admin/machines/test-machine/sensors/{old_sensor_id}/replace",
        headers=manager,
        json={"sensor_type": "DHT22-AM2302", "gpio": 26, "unit": "°C", "reason": "Valeurs instables"},
    ).status_code == 403

    replacement_response = client.post(
        f"/api/admin/machines/test-machine/sensors/{old_sensor_id}/replace",
        headers=administrator,
        json={"sensor_type": "DHT22-AM2302", "gpio": 26, "unit": "°C", "reason": "Valeurs instables"},
    )
    assert replacement_response.status_code == 201
    replacement = replacement_response.json()
    new_sensor_id = replacement["new_sensor"]["id"]
    assert replacement["old_sensor"] == {
        "id": old_sensor_id,
        "sensor_type": "DHT22",
        "enabled": False,
    }
    assert replacement["new_sensor"]["enabled"] is True
    assert replacement["new_sensor"]["id"] != old_sensor_id

    assert client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(
            seq=2,
            acquisition_mode="hardware",
            current_source="hardware",
            current_rms=0.045,
        ),
    ).status_code == 202
    measurements = client.get(
        "/api/machines/test-machine/telemetry",
        headers=manager,
    ).json()
    assert measurements[0]["sensor_ids"]["temperature"] == old_sensor_id
    assert measurements[1]["sensor_ids"]["temperature"] == new_sensor_id

    sensors = client.get("/api/admin/sensors", headers=administrator).json()
    assert [(item["id"], item["enabled"]) for item in sensors] == [
        (old_sensor_id, False),
        (new_sensor_id, True),
    ]
    history = client.get("/api/admin/sensor-replacements", headers=administrator)
    assert history.status_code == 200
    assert history.json()[0]["reason"] == "Valeurs instables"
    assert history.json()[0]["administrator_email"] == "admin@test.local"
    assert client.get("/api/admin/sensor-replacements", headers=manager).status_code == 403

    duplicate = client.post(
        "/api/machines/test-machine/sensors",
        headers=manager,
        json={"metric": "temperature", "sensor_type": "DHT22", "gpio": 27, "unit": "°C"},
    )
    assert duplicate.status_code == 409
    assert client.patch(
        f"/api/sensors/{old_sensor_id}",
        headers=manager,
        json={"enabled": True},
    ).status_code == 409
    second_replacement = client.post(
        f"/api/admin/machines/test-machine/sensors/{new_sensor_id}/replace",
        headers=administrator,
        json={"sensor_type": "DHT22-2", "gpio": 25, "unit": "°C", "reason": "Nouvelle panne"},
    )
    assert second_replacement.status_code == 201
    assert second_replacement.json()["old_sensor"]["enabled"] is False
    assert len(client.get("/api/admin/sensor-replacements", headers=administrator).json()) == 2

    db = TestingSession()
    try:
        assert db.query(MeasurementRow).filter_by(machine_id="test-machine").count() == 2
        assert db.query(MeasurementSensorSourceRow).filter_by(
            measurement_id=measurements[0]["id"],
            sensor_id=old_sensor_id,
        ).count() == 1
        assert db.query(SensorReplacementRow).count() == 2
        assert db.query(SensorRow).filter_by(machine_id="test-machine", enabled=True).count() == 1
        assert db.query(SensorRow).filter_by(machine_id="test-machine", enabled=False).count() == 2
        assert db.get(SensorRow, old_sensor_id).enabled is False
    finally:
        db.close()

def test_sensor_metadata_rejects_unknown_fields(client):
    manager = auth(client, "manager")
    created = client.post(
        "/api/machines/test-machine/sensors",
        headers=manager,
        json={"metric": "humidity", "sensor_type": "DHT22", "gpio": 27, "unit": "%"},
    )
    response = client.patch(
        f"/api/sensors/{created.json()['id']}", headers=manager,
        json={"machine_id": "other-machine"},
    )
    assert response.status_code == 422

def test_manager_can_archive_without_deleting_history(client):
    manager = auth(client, "manager")
    response = client.delete("/api/machines/test-machine", headers=manager)
    assert response.status_code == 200
    assert response.json()["active"] is False
    assert client.get("/api/machines", headers=auth(client, "technician")).json() == []

def test_manager_threshold_requires_critical_above_warning(client):
    manager = auth(client, "manager")
    response = client.put("/api/thresholds/test-machine/temperature", headers=manager, json={"warning": 80, "critical": 70})
    assert response.status_code == 422

def test_unregistered_machine_cannot_ingest_measurements(client):
    response = client.post("/api/telemetry/unknown", headers=auth(client, "manager"), json=sample())
    assert response.status_code == 404

def test_admin_can_manage_users_and_user_receives_change_notification(client):
    admin = auth(client, "admin")
    manager = auth(client, "manager")
    assert client.get("/api/admin/users", headers=manager).status_code == 403

    created = client.post("/api/admin/users", headers=admin, json={
        "full_name": "Nouveau technicien",
        "email": "new-tech@test.local",
        "phone": "+216 20 000 000",
        "role": "technician",
        "password": "secure-initial-pass",
        "active": True,
    })
    assert created.status_code == 201
    user_id = created.json()["id"]
    assert created.json()["notification_status"] == "in_app_only"

    changed = client.patch(f"/api/admin/users/{user_id}", headers=admin, json={
        "full_name": "Technicien modifié",
        "active": False,
    })
    assert changed.status_code == 200
    assert changed.json()["notification_status"] == "in_app_only"
    assert client.post("/api/auth/login", json={
        "email": "new-tech@test.local",
        "password": "secure-initial-pass",
    }).status_code == 401

    assert client.patch(f"/api/admin/users/{user_id}", headers=admin, json={"active": True}).status_code == 200
    new_user = client.post(
        "/api/auth/login",
        json={"email": "new-tech@test.local", "password": "secure-initial-pass"},
    )
    assert new_user.status_code == 200
    notice_headers = {"Authorization": f"Bearer {new_user.json()['access_token']}"}
    notifications = client.get("/api/admin/notifications/me", headers=notice_headers)
    assert notifications.status_code == 200
    assert any("mises à jour" in item["message"] for item in notifications.json())


def test_admin_can_create_list_and_download_database_backup(client, tmp_path, monkeypatch):
    from app.infrastructure import database_backups

    monkeypatch.setattr(database_backups, "BACKUP_DIRECTORY", tmp_path / "backups")
    monkeypatch.setattr(
        database_backups.settings,
        "database_url",
        "postgresql+psycopg://backup-user:private-test-password@postgres:5432/predimaint",
    )

    def fake_run(arguments, **kwargs):
        assert "private-test-password" not in arguments
        if arguments[0] == "pg_dump":
            Path(arguments[arguments.index("--file") + 1]).write_bytes(b"custom archive")
            assert kwargs["env"]["PGPASSWORD"] == "private-test-password"
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(database_backups.subprocess, "run", fake_run)
    assert client.get("/api/admin/backups").status_code == 401
    assert client.get("/api/admin/backups", headers=auth(client, "manager")).status_code == 403
    assert client.post("/api/admin/backups", headers=auth(client, "manager")).status_code == 403

    admin = auth(client, "admin")
    created = client.post("/api/admin/backups", headers=admin)
    assert created.status_code == 201
    backup = created.json()
    assert backup["status"] == "succeeded"
    assert backup["size_bytes"] == len(b"custom archive")
    assert backup["filename"].endswith(".dump")
    assert client.get("/api/admin/backups", headers=admin).json()["last_backup"]["id"] == backup["id"]

    assert client.get(
        f"/api/admin/backups/{backup['id']}/download",
        headers=auth(client, "technician"),
    ).status_code == 403
    downloaded = client.get(f"/api/admin/backups/{backup['id']}/download", headers=admin)
    assert downloaded.status_code == 200
    assert downloaded.content == b"custom archive"
    assert backup["filename"] in downloaded.headers["content-disposition"]
    assert (tmp_path / "backups" / backup["filename"]).is_file()


def test_admin_can_configure_persistent_backup_frequency(client):
    admin = auth(client, "admin")
    assert client.get("/api/admin/backups/config", headers=auth(client, "manager")).status_code == 403
    saved = client.put(
        "/api/admin/backups/config",
        headers=admin,
        json={"enabled": True, "interval_minutes": 1440},
    )
    assert saved.status_code == 200
    assert saved.json()["enabled"] is True
    assert saved.json()["interval_minutes"] == 1440
    assert saved.json()["next_run_at"]
    assert client.get("/api/admin/backups/config", headers=admin).json()["interval_minutes"] == 1440

    disabled = client.put(
        "/api/admin/backups/config",
        headers=admin,
        json={"enabled": False, "interval_minutes": 1},
    )
    assert disabled.status_code == 200
    assert disabled.json()["next_run_at"] is None
    assert client.put(
        "/api/admin/backups/config",
        headers=admin,
        json={"enabled": True, "interval_minutes": 0},
    ).status_code == 422


def test_failed_database_backup_is_recorded_without_leaving_partial_file(client, tmp_path, monkeypatch):
    from app.infrastructure import database_backups

    monkeypatch.setattr(database_backups, "BACKUP_DIRECTORY", tmp_path / "backups")
    monkeypatch.setattr(
        database_backups,
        "_pg_dump_arguments",
        lambda path: (["pg_dump"], {"PATH": ""}),
    )
    monkeypatch.setattr(
        database_backups.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="", stderr=""),
    )

    response = client.post("/api/admin/backups", headers=auth(client, "admin"))
    assert response.status_code == 502
    history = client.get("/api/admin/backups", headers=auth(client, "admin")).json()
    assert history["last_attempt"]["status"] == "failed"
    assert history["last_attempt"]["size_bytes"] is None
    assert list((tmp_path / "backups").glob("*.dump")) == []


def test_interrupted_database_backup_reconciliation_verifies_archive(tmp_path, monkeypatch):
    from app.infrastructure import database_backups

    monkeypatch.setattr(database_backups, "BACKUP_DIRECTORY", tmp_path)
    valid_path = tmp_path / "valid.dump"
    valid_path.write_bytes(b"valid archive")
    invalid_path = tmp_path / "invalid.dump"
    invalid_path.write_bytes(b"partial archive")
    db = TestingSession()
    valid = DatabaseBackupRow(
        filename=valid_path.name,
        created_at=datetime.now(timezone.utc),
        status="running",
        trigger="manual",
    )
    invalid = DatabaseBackupRow(
        filename=invalid_path.name,
        created_at=datetime.now(timezone.utc),
        status="running",
        trigger="automatic",
    )
    db.add_all([valid, invalid])
    DatabaseBackupRow.__table__.create(db.get_bind(), checkfirst=True)
    db.commit()
    monkeypatch.setattr(
        database_backups.subprocess,
        "run",
        lambda args, **kwargs: SimpleNamespace(
            returncode=0 if args[-1] == str(valid_path) else 1,
            stdout="",
            stderr="",
        ),
    )

    database_backups.reconcile_interrupted_backups(db)
    db.refresh(valid)
    db.refresh(invalid)
    assert valid.status == "succeeded"
    assert valid.size_bytes == len(b"valid archive")
    assert invalid.status == "failed"
    assert invalid.size_bytes is None
    assert valid_path.is_file()
    assert not invalid_path.exists()
    db.close()


def test_admin_cannot_disable_last_administrator(client):
    admin = auth(client, "admin")
    profile = client.get("/api/auth/me", headers=admin).json()
    response = client.patch(
        f"/api/admin/users/{profile['id']}",
        headers=admin,
        json={"active": False},
    )
    assert response.status_code == 409

def test_admin_session_setting_controls_new_tokens(client):
    admin = auth(client, "admin")
    saved = client.put(
        "/api/admin/settings",
        headers=admin,
        json={"email_notifications": True, "language": "fr", "session_minutes": 15},
    )
    assert saved.status_code == 200
    login = client.post(
        "/api/auth/login",
        json={"email": "manager@test.local", "password": "secret-pass"},
    )
    assert login.status_code == 200
    claims = jwt.decode(login.json()["access_token"], "test-secret-for-release-one-only-1234567890", algorithms=["HS256"])
    remaining = datetime.fromtimestamp(claims["exp"], timezone.utc) - datetime.now(timezone.utc)
    assert 14 * 60 < remaining.total_seconds() <= 15 * 60

def test_admin_records_failed_login_attempts(client):
    admin = auth(client, "admin")
    assert client.post(
        "/api/auth/login",
        json={"email": "missing@test.local", "password": "wrong"},
    ).status_code == 401
    history = client.get("/api/admin/login-history", headers=admin)
    assert history.status_code == 200
    assert any(row["email"] == "missing@test.local" and row["success"] is False for row in history.json())

def test_admin_notifications_include_active_machine_alerts(client):
    manager = auth(client, "manager")
    admin = auth(client, "admin")
    assert client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(temperature=75),
    ).status_code == 202
    response = client.get("/api/admin/notifications", headers=admin)
    assert response.status_code == 200
    assert any(
        row["type"] == "system_alert" and row["email_to"] == "test-machine"
        for row in response.json()
    )
    overview = client.get("/api/admin/overview", headers=admin)
    assert overview.status_code == 200
    assert overview.json()["acquisition_mode"] == "simulated"
    assert overview.json()["measurement_server_time"]
    assert overview.json()["measurement_age_seconds"] >= 0
    assert overview.json()["measurement_current_rms"] == 0


def test_director_overview_reports_latest_measurement_mode_and_age(client):
    manager = auth(client, "manager")
    director = auth(client, "director")
    assert client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(acquisition_mode="hardware"),
    ).status_code == 202

    response = client.get(
        "/api/director/overview?acquisition_mode=hardware", headers=director
    )
    assert response.status_code == 200
    machine = next(item for item in response.json()["machines"] if item["id"] == "test-machine")
    assert machine["last_measurement_mode"] == "hardware"
    assert machine["measurement_recorded_at"]
    assert machine["measurement_age_seconds"] >= 0
    assert response.json()["server_time"]

def test_existing_users_table_is_migrated_without_losing_accounts(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE users ("
            "id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, "
            "password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL, "
            "active BOOLEAN NOT NULL DEFAULT 1)"
        ))
        connection.execute(text(
            "INSERT INTO users (id, email, password_hash, role, active) "
            "VALUES (1, 'existing@test.local', 'existing-hash', 'technician', 1)"
        ))
        connection.execute(text(
            "INSERT INTO users (id, email, password_hash, role, active) "
            "VALUES (2, 'existing-admin@test.local', 'existing-admin-hash', 'admin', 1)"
        ))
        connection.execute(text(
            "CREATE TABLE measurements ("
            "id INTEGER PRIMARY KEY, machine_id VARCHAR(80) NOT NULL, seq INTEGER NOT NULL, "
            "temperature FLOAT NOT NULL, humidity FLOAT NOT NULL, vibration_rate FLOAT NOT NULL, "
            "vibration_edges INTEGER NOT NULL, current_rms FLOAT NOT NULL, "
            "current_source VARCHAR(20) NOT NULL, recorded_at DATETIME NOT NULL)"
        ))
        connection.execute(text(
            "INSERT INTO measurements "
            "(id, machine_id, seq, temperature, humidity, vibration_rate, vibration_edges, "
            "current_rms, current_source, recorded_at) "
            "VALUES (1, 'legacy-machine', 1, 25, 55, 0, 0, 0, 'simulated', CURRENT_TIMESTAMP)"
        ))
    monkeypatch.setattr(main_module, "engine", engine)
    monkeypatch.setattr(main_module, "SessionLocal", sessionmaker(bind=engine, expire_on_commit=False))

    main_module.initialize_data()

    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    measurement_columns = {column["name"] for column in inspect(engine).get_columns("measurements")}
    assert {"full_name", "phone", "created_at", "last_login"} <= columns
    assert "acquisition_mode" in measurement_columns
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT acquisition_mode FROM measurements WHERE id = 1")) == "hardware"
    session = main_module.SessionLocal()
    try:
        user = session.get(UserRow, 1)
        assert user.email == "existing@test.local"
        assert user.full_name == ""
        administrators = session.query(UserRow).filter_by(role="admin").all()
        assert len(administrators) == 1
        assert administrators[0].email == "existing-admin@test.local"
    finally:
        session.close()
        engine.dispose()

def test_telemetry_simulator_generates_normal_warning_and_critical_all_sensor_data():
    fields = {
        "temperature",
        "humidity",
        "vibration_rate",
        "vibration_edges",
        "current_rms",
        "current_source",
        "acquisition_mode",
    }
    normal = build_measurement("normal", 1)
    warning = build_measurement("cycle", 2)
    critical = build_measurement("critical", 1)
    recovery = build_measurement("cycle", 4)

    assert fields <= normal.keys()
    assert normal["acquisition_mode"] == "simulated"
    assert normal["temperature"] < 60
    assert warning["temperature"] == 66
    assert critical["temperature"] >= 75
    assert critical["humidity"] > 95
    assert critical["vibration_rate"] > 30
    assert critical["current_rms"] > 5
    assert recovery["temperature"] < 60


def test_technician_can_only_read_authorized_machine_data(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    assert client.post(
        "/api/machines",
        headers=manager,
        json={"id": "restricted-pump", "name": "Pompe restreinte", "description": ""},
    ).status_code == 201
    assert client.post(
        "/api/telemetry/restricted-pump",
        headers=manager,
        json=sample(temperature=80),
    ).status_code == 202
    assert all(item["id"] != "restricted-pump" for item in client.get("/api/machines", headers=technician).json())
    assert client.get("/api/machines/restricted-pump/telemetry", headers=technician).status_code == 404
    assert all(item["machine_id"] != "restricted-pump" for item in client.get("/api/alerts", headers=technician).json())
    assert client.get("/api/thresholds/restricted-pump", headers=technician).status_code == 404


def test_manager_assigns_and_technician_updates_intervention_with_revision(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]
    assigned = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Contrôle de la pompe",
        "description": "Vérifier le roulement et la température.",
        "priority": "high",
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    })
    assert assigned.status_code == 201
    intervention = assigned.json()
    assert intervention["status"] == "assigned"
    assert intervention["assigned_to_id"] == technician_id
    assert any(item["id"] == "test-machine" for item in client.get("/api/machines", headers=technician).json())

    updated = client.patch(
        f"/api/interventions/{intervention['id']}",
        headers=technician,
        json={
            "status": "accepted",
            "diagnosis": "Jeu anormal détecté.",
            "work_done": "Inspection visuelle effectuée.",
            "expected_revision": 1,
            "client_action_id": "offline-action-001",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert updated.json()["status"] == "accepted"
    assert updated.json()["accepted_at"] is not None
    assert updated.json()["completed_at"] is None
    repeated = client.patch(
        f"/api/interventions/{intervention['id']}",
        headers=technician,
        json={
            "work_done": "Inspection visuelle effectuée.",
            "expected_revision": 1,
            "client_action_id": "offline-action-001",
        },
    )
    assert repeated.status_code == 200
    assert repeated.json()["revision"] == 2
    stale = client.patch(
        f"/api/interventions/{intervention['id']}",
        headers=technician,
        json={"result": "Terminé", "expected_revision": 1},
    )
    assert stale.status_code == 409
    assert client.get("/api/interventions", headers=technician).json()[0]["id"] == intervention["id"]


def test_intervention_rejects_past_deadlines_and_records_acceptance_completion_times(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]

    missing_deadline = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Sans échéance",
        "description": "Cette intervention ne doit pas être créée sans échéance.",
    })
    assert missing_deadline.status_code == 422

    past = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
    rejected = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Échéance invalide",
        "description": "Cette date est dans le passé.",
        "due_at": past,
    })
    assert rejected.status_code == 422
    assert "futures" in rejected.json()["detail"]

    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assigned = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Inspection du moteur",
        "description": "Contrôler le moteur et les roulements.",
        "due_at": future,
    })
    assert assigned.status_code == 201
    item = assigned.json()
    intervention_id = item["id"]
    assert item["accepted_at"] is None
    assert item["completed_at"] is None

    invalid_start = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "in_progress",
        "expected_revision": 1,
    })
    assert invalid_start.status_code == 409

    accepted = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "accepted",
        "expected_revision": 1,
    })
    assert accepted.status_code == 200
    accepted_at = accepted.json()["accepted_at"]
    assert accepted_at is not None

    started = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "in_progress",
        "expected_revision": 2,
    })
    assert started.status_code == 200
    assert started.json()["accepted_at"] == accepted_at

    completed = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "completed",
        "work_done": "Roulement contrôlé et nettoyé.",
        "expected_revision": 3,
    })
    assert completed.status_code == 200
    final_item = completed.json()
    assert final_item["completed_at"] is not None
    assert final_item["resolved_at"] is not None
    accepted_dt = datetime.fromisoformat(accepted_at.replace("Z", "+00:00"))
    completed_dt = datetime.fromisoformat(final_item["completed_at"].replace("Z", "+00:00"))
    assert final_item["duration_minutes"] == max(0, int((completed_dt - accepted_dt).total_seconds() // 60))

    past_update = client.patch(f"/api/interventions/{intervention_id}", headers=manager, json={
        "due_at": past,
        "expected_revision": 4,
    })
    assert past_update.status_code == 422
    cleared_deadline = client.patch(f"/api/interventions/{intervention_id}", headers=manager, json={
        "due_at": None,
    })
    assert cleared_deadline.status_code == 422


def test_overdue_interventions_are_blocked_until_manager_sets_a_new_future_deadline(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]

    created = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Intervention à échéance dépassée",
        "description": "Vérifier le blocage des interventions en retard.",
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    })
    assert created.status_code == 201
    intervention_id = created.json()["id"]

    # Simulate an already-existing task whose deadline has elapsed.
    db = TestingSession()
    try:
        row = db.get(InterventionRow, intervention_id)
        row.due_at = datetime.now(timezone.utc) - timedelta(minutes=2)
        db.commit()
    finally:
        db.close()

    accept = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "accepted",
    })
    assert accept.status_code == 409
    assert "échéance est dépassée" in accept.json()["detail"]

    update_work = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "work_done": "Tentative de travail après l’échéance.",
    })
    assert update_work.status_code == 409

    # The manager can explicitly reschedule the task into the future.
    rescheduled = client.patch(f"/api/interventions/{intervention_id}", headers=manager, json={
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat(),
    })
    assert rescheduled.status_code == 200

    accepted = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "accepted",
    })
    assert accepted.status_code == 200
    assert accepted.json()["accepted_at"] is not None

    started = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "in_progress",
    })
    assert started.status_code == 200

    # If the deadline passes while the task is in progress, completion is blocked
    # until the manager gives it another future deadline.
    db = TestingSession()
    try:
        row = db.get(InterventionRow, intervention_id)
        row.due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    finally:
        db.close()

    completed = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "completed",
        "work_done": "Travail terminé.",
    })
    assert completed.status_code == 409

    renewed = client.patch(f"/api/interventions/{intervention_id}", headers=manager, json={
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    })
    assert renewed.status_code == 200
    completed = client.patch(f"/api/interventions/{intervention_id}", headers=technician, json={
        "status": "completed",
        "work_done": "Travail terminé après report de l’échéance.",
    })
    assert completed.status_code == 200
    assert completed.json()["completed_at"] is not None

def test_alert_acknowledgement_is_audited_and_critical_creates_failure(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]
    assert client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(temperature=80),
    ).status_code == 202
    alert = client.get("/api/alerts", headers=technician).json()[0]
    acknowledged = client.post(
        f"/api/alerts/{alert['id']}/acknowledge",
        headers=technician,
    )
    assert acknowledged.status_code == 200
    assert acknowledged.json()["acknowledged_by_id"] == technician_id
    assert acknowledged.json()["acknowledged_at"]
    failures = client.get("/api/failures", headers=technician).json()
    assert failures[0]["alert_id"] == alert["id"]
    assert failures[0]["failure_type"] == "temperature"
    saved = client.patch(
        f"/api/failures/{failures[0]['id']}",
        headers=technician,
        json={"diagnosis": "Cause identifiée", "intervention": "Contrôle réalisé", "result": "Fonctionnement rétabli"},
    )
    assert saved.status_code == 200
    assert saved.json()["diagnosis"] == "Cause identifiée"


def test_technician_can_record_calibration_and_notifications(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    sensor = client.post(
        "/api/machines/test-machine/sensors",
        headers=manager,
        json={"metric": "temperature", "sensor_type": "DHT22", "gpio": 27, "unit": "°C"},
    ).json()
    created = client.post("/api/calibrations", headers=technician, json={
        "machine_id": "test-machine",
        "sensor_id": sensor["id"],
        "reference_value": 20,
        "measured_value": 20.5,
        "observations": "Vérification de référence.",
    })
    assert created.status_code == 201
    assert client.get("/api/calibrations", headers=technician).json()[0]["sensor_id"] == sensor["id"]
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]
    assignment = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Révision",
        "description": "Contrôler le capteur.",
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    })
    assert assignment.status_code == 201
    notifications = client.get("/api/notifications", headers=technician).json()
    target = next(item for item in notifications if item["target_type"] == "intervention")
    assert target["read"] is False
    marked = client.post(f"/api/notifications/{target['id']}/read", headers=technician)
    assert marked.status_code == 200
    assert next(item for item in client.get("/api/notifications", headers=technician).json() if item["id"] == target["id"])["read"]


def test_manager_is_notified_when_technician_completes_intervention(client):
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    technician_id = client.get("/api/auth/me", headers=technician).json()["id"]
    created = client.post("/api/interventions", headers=manager, json={
        "machine_id": "test-machine",
        "assigned_to_id": technician_id,
        "title": "Notification responsable",
        "description": "Le responsable doit être prévenu de la fin.",
        "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    }).json()
    accepted = client.patch(f"/api/interventions/{created['id']}", headers=technician, json={"status": "accepted"})
    assert accepted.status_code == 200
    done = client.patch(f"/api/interventions/{created['id']}", headers=technician, json={
        "status": "completed",
        "work_done": "Travail terminé.",
    })
    assert done.status_code == 200
    manager_notifications = client.get("/api/notifications", headers=manager).json()
    progress = [item for item in manager_notifications if item["type"] == "intervention_progress"]
    assert any("a terminé" in item["message"] for item in progress)
    assert all(item["target_type"] == "intervention" and item["target_id"] == str(created["id"]) for item in progress)
    # Le technicien n'est pas notifié de sa propre action.
    technician_notifications = client.get("/api/notifications", headers=technician).json()
    assert not any(item["type"] == "intervention_updated" for item in technician_notifications)
    # Le directeur ne reçoit pas de notification : il consulte les dates dans son tableau.
    director_notifications = client.get("/api/notifications", headers=auth(client, "director")).json()
    assert not any(item["type"] == "intervention_completed" for item in director_notifications)
    assert done.json()["completed_at"] is not None


def test_password_reset_is_generic_hashed_single_use_and_revokes_sessions(client, monkeypatch):
    import app.api.routes as routes_module

    sent = []
    monkeypatch.setattr(
        routes_module,
        "send_email",
        lambda recipient, subject, body: (sent.append((recipient, subject, body)) or ("sent", "")),
    )
    headers = auth(client, "technician")
    known = client.post("/api/auth/password-reset/request", json={"email": "technician@test.local"})
    unknown = client.post("/api/auth/password-reset/request", json={"email": "missing@test.local"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert len(sent) == 1
    raw_token = sent[0][2].split("#reset_token=")[1].split()[0]
    db = TestingSession()
    try:
        stored = db.query(PasswordResetTokenRow).one()
        assert stored.token_hash != raw_token
    finally:
        db.close()
    completed = client.post("/api/auth/password-reset/complete", json={
        "token": raw_token,
        "new_password": "NewSecurePass123!",
        "confirm_password": "NewSecurePass123!",
    })
    assert completed.status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.post("/api/auth/password-reset/complete", json={
        "token": raw_token,
        "new_password": "AnotherSecurePass123!",
        "confirm_password": "AnotherSecurePass123!",
    }).status_code == 400
    assert client.post("/api/auth/login", json={
        "email": "technician@test.local",
        "password": "NewSecurePass123!",
    }).status_code == 200


def test_manager_can_update_own_profile_and_password_without_admin_access(client):
    headers = auth(client, "manager")
    profile = client.get("/api/profile", headers=headers)
    assert profile.status_code == 200
    assert profile.json()["role"] == "manager"

    updated = client.patch("/api/profile", headers=headers, json={
        "full_name": "Responsable Test",
        "email": "manager-updated@test.local",
        "phone": "+33123456789",
    })
    assert updated.status_code == 200
    assert updated.json()["full_name"] == "Responsable Test"
    assert updated.json()["email"] == "manager-updated@test.local"
    assert client.get("/api/admin/profile", headers=headers).status_code == 403

    changed = client.post("/api/profile/password", headers=headers, json={
        "current_password": "secret-pass",
        "new_password": "NewManagerPass123!",
    })
    assert changed.status_code == 200
    assert changed.json()["sessions_revoked"] is True
    assert client.get("/api/profile", headers=headers).status_code == 401
    assert client.post("/api/auth/login", json={
        "email": "manager-updated@test.local",
        "password": "NewManagerPass123!",
    }).status_code == 200


def test_technician_machine_details_include_latest_values_and_enforce_access(client):
    technician = auth(client, "technician")
    manager = auth(client, "manager")
    db = TestingSession()
    try:
        db.add(SensorRow(
            machine_id="test-machine",
            metric="temperature",
            sensor_type="DHT22",
            unit="°C",
            enabled=True,
        ))
        db.add(MachineRow(id="unassigned-machine", name="Non attribuée"))
        db.commit()
        sensor_id = db.query(SensorRow).filter_by(machine_id="test-machine").one().id
    finally:
        db.close()

    accepted = client.post(
        "/api/telemetry/test-machine",
        headers=manager,
        json=sample(
            temperature=75,
            acquisition_mode="hardware",
            current_source="hardware",
            current_rms=1,
        ),
    )
    assert accepted.status_code == 202
    details = client.get("/api/machines/test-machine/details", headers=technician)
    assert details.status_code == 200
    body = details.json()
    assert body["latest_measurement"]["temperature"] == 75
    assert body["latest_measurement"]["received_at"]
    assert body["latest_measurement"]["sensor_ids"]["temperature"] == sensor_id
    assert body["sensors"][0]["sensor_type"] == "DHT22"
    assert body["active_alerts"][0]["processing_delay_ms"] >= 0
    assert body["active_alerts"][0]["source_measurement_id"] == body["latest_measurement"]["id"]
    assert client.get("/api/machines/unassigned-machine/details", headers=technician).status_code == 404


def test_technician_intervention_history_includes_more_than_300_rows_and_statuses(client):
    technician = auth(client, "technician")
    db = TestingSession()
    try:
        technician_id = db.query(UserRow).filter_by(role="technician").one().id
        db.add_all([
            InterventionRow(
                machine_id="test-machine",
                user_id=technician_id,
                assigned_to_id=technician_id,
                title=f"Intervention {index}",
                description="Historique de test",
                status=("completed", "cancelled", "in_progress", "assigned", "accepted")[index % 5],
                work_done="Remplacement de pièce" if index == 0 else "",
                result="Machine remise en service" if index == 0 else "",
            )
            for index in range(305)
        ])
        db.commit()
    finally:
        db.close()

    history = client.get("/api/interventions", headers=technician)
    assert history.status_code == 200
    assert len(history.json()) == 305
    assert {item["status"] for item in history.json()} == {
        "assigned", "accepted", "in_progress", "completed", "cancelled",
    }
    completed = client.get("/api/interventions?status=completed", headers=technician)
    assert completed.status_code == 200
    completed_item = next(item for item in completed.json() if item["title"] == "Intervention 0")
    assert completed_item["work_done"] == "Remplacement de pièce"
    assert completed_item["result"] == "Machine remise en service"


def test_intervention_photos_are_persistent_validated_and_authorized(client, tmp_path, monkeypatch):
    monkeypatch.setattr(api_routes.settings, "intervention_photo_directory", str(tmp_path))
    manager = auth(client, "manager")
    technician = auth(client, "technician")
    db = TestingSession()
    try:
        technician_id = db.query(UserRow).filter_by(role="technician").one().id
    finally:
        db.close()
    created = client.post(
        "/api/interventions",
        headers=manager,
        json={
            "machine_id": "test-machine",
            "assigned_to_id": technician_id,
            "title": "Inspection photo",
            "description": "Ajouter une preuve visuelle",
            "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
        },
    )
    assert created.status_code == 201
    intervention_id = created.json()["id"]
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
    uploaded = client.post(
        f"/api/interventions/{intervention_id}/photos",
        headers=technician,
        files={"photo": ("..\\inspection.png", png, "application/octet-stream")},
    )
    assert uploaded.status_code == 201
    listed = client.get(f"/api/interventions/{intervention_id}/photos", headers=technician)
    assert listed.status_code == 200
    assert listed.json()[0]["original_name"] == "inspection.png"
    assert listed.json()[0]["size_bytes"] == len(png)
    path = tmp_path / next(tmp_path.glob("*.png")).name
    assert path.is_file() and path.stat().st_size == len(png)
    downloaded = client.get(
        f"/api/interventions/{intervention_id}/photos/{listed.json()[0]['id']}",
        headers=technician,
    )
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"] == "image/png"
    assert downloaded.content == png

    # The manager must see the same photo uploaded by the assigned technician.
    manager_listed = client.get(
        f"/api/interventions/{intervention_id}/photos",
        headers=auth(client, "manager"),
    )
    assert manager_listed.status_code == 200
    assert len(manager_listed.json()) == 1
    assert manager_listed.json()[0]["id"] == listed.json()[0]["id"]
    manager_downloaded = client.get(
        f"/api/interventions/{intervention_id}/photos/{manager_listed.json()[0]['id']}",
        headers=auth(client, "manager"),
    )
    assert manager_downloaded.status_code == 200
    assert manager_downloaded.headers["content-type"] == "image/png"
    assert manager_downloaded.content == png

    assert client.get(
        f"/api/interventions/{intervention_id}/photos",
        headers=auth(client, "director"),
    ).status_code == 403
    db = TestingSession()
    try:
        db.add(UserRow(
            email="another-technician@test.local",
            password_hash="unused",
            role="technician",
            full_name="Autre technicien",
        ))
        db.commit()
        other_technician_id = db.query(UserRow).filter_by(email="another-technician@test.local").one().id
    finally:
        db.close()
    other_intervention = client.post(
        "/api/interventions",
        headers=manager,
        json={
            "machine_id": "test-machine",
            "assigned_to_id": other_technician_id,
            "title": "Privée pour un autre compte",
            "description": "Ne pas divulguer les photos",
            "due_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
        },
    )
    assert other_intervention.status_code == 201
    assert client.get(
        f"/api/interventions/{other_intervention.json()['id']}/photos",
        headers=technician,
    ).status_code == 404
    rejected = client.post(
        f"/api/interventions/{intervention_id}/photos",
        headers=technician,
        files={"photo": ("invalid.png", b"not an image", "image/png")},
    )
    assert rejected.status_code == 422
    oversized = client.post(
        f"/api/interventions/{intervention_id}/photos",
        headers=technician,
        files={
            "photo": (
                "oversized.png",
                b"\x89PNG\r\n\x1a\n" + b"x" * api_routes.MAX_INTERVENTION_PHOTO_BYTES,
                "image/png",
            )
        },
    )
    assert oversized.status_code == 413


def test_push_subscription_and_notification_receipt_are_account_scoped(client, monkeypatch):
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_public_key", "")
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_private_key", "")
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_subject", "")
    technician = auth(client, "technician")
    assert client.get("/api/notifications/push/vapid-key", headers=technician).json() == {
        "enabled": False,
        "public_key": None,
    }
    assert client.get("/api/notifications/push/vapid-key", headers=auth(client, "admin")).status_code == 403
    disabled = client.post(
        "/api/notifications/push/subscriptions",
        headers=technician,
        json={"endpoint": "https://fcm.googleapis.com/sub", "p256dh": "a" * 32, "auth": "b" * 16},
    )
    assert disabled.status_code == 503
    assert client.post(
        "/api/notifications/push/subscriptions",
        headers=technician,
        json={"endpoint": "http://push.example.test/sub", "p256dh": "a" * 32, "auth": "b" * 16},
    ).status_code == 422
    assert client.post(
        "/api/notifications/push/subscriptions",
        headers=technician,
        json={"endpoint": "https://attacker.example.test/sub", "p256dh": "a" * 32, "auth": "b" * 16},
    ).status_code == 422

    db = TestingSession()
    try:
        technician_id = db.query(UserRow).filter_by(role="technician").one().id
        notification = TechnicianNotificationRow(
            user_id=technician_id,
            notification_key="receipt-test",
            notification_type="alert",
            message="Nouvelle alerte de test",
            target_type="alert",
            target_id="1",
        )
        db.add(notification)
        db.commit()
        notification_id = notification.id
    finally:
        db.close()
    notifications = client.get("/api/notifications", headers=technician).json()
    assert f"technician-{notification_id}" in [item["id"] for item in notifications]
    received = client.post(
        "/api/notifications/received",
        headers=technician,
        json={"notification_ids": [notification_id]},
    )
    assert received.status_code == 200
    assert received.json()["recorded"] == 1
    refreshed = client.get("/api/notifications", headers=technician).json()
    item = next(item for item in refreshed if item["id"] == f"technician-{notification_id}")
    assert item["received_at"]
    assert item["delivery_delay_ms"] >= 0


def test_configured_push_subscription_is_stored_without_returning_secrets(client, monkeypatch):
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_public_key", "public-key")
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_private_key", "private-key")
    monkeypatch.setattr(api_routes.settings, "web_push_vapid_subject", "mailto:test@example.test")
    technician = auth(client, "technician")
    response = client.post(
        "/api/notifications/push/subscriptions",
        headers=technician,
        json={
            "endpoint": "https://fcm.googleapis.com/user/endpoint",
            "p256dh": "p" * 48,
            "auth": "a" * 24,
        },
    )
    assert response.status_code == 201
    assert response.json() == {"subscribed": True}
    assert client.get("/api/notifications/push/vapid-key", headers=technician).json() == {
        "enabled": True,
        "public_key": "public-key",
    }
    db = TestingSession()
    try:
        subscription = db.query(PushSubscriptionRow).one()
        assert subscription.user_id
        assert subscription.endpoint == "https://fcm.googleapis.com/user/endpoint"
    finally:
        db.close()


def test_web_push_dispatch_marks_service_acceptance_without_external_network(client, monkeypatch):
    import base64
    from py_vapid import Vapid
    from app.infrastructure import web_push

    monkeypatch.setattr(web_push, "web_push_is_configured", lambda: True)
    vapid_key = Vapid()
    vapid_key.generate_keys()
    monkeypatch.setattr(
        web_push.settings,
        "web_push_vapid_private_key",
        "base64:" + base64.b64encode(vapid_key.private_pem()).decode("ascii"),
    )
    sent = []

    def fake_webpush(**kwargs):
        sent.append(kwargs)
        return None

    monkeypatch.setattr("pywebpush.webpush", fake_webpush)
    db = TestingSession()
    try:
        technician_id = db.query(UserRow).filter_by(role="technician").one().id
        notification = TechnicianNotificationRow(
            user_id=technician_id,
            notification_key="push-dispatch-test",
            notification_type="alert",
            message="Alerte simulée",
            target_type="alert",
            target_id="8",
        )
        db.add(notification)
        db.flush()
        db.add(PushSubscriptionRow(
            user_id=technician_id,
            endpoint="https://fcm.googleapis.com/device",
            p256dh="p" * 48,
            auth="a" * 24,
        ))
        db.commit()
        web_push.dispatch_web_push(db, [notification])
        db.refresh(notification)
        assert len(sent) == 1
        assert '"url": "/#tech-alerts"' in sent[0]["data"]
        assert sent[0]["vapid_private_key"].startswith("-----BEGIN PRIVATE KEY-----")
        assert notification.push_sent_at is not None
    finally:
        db.close()
