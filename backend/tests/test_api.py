from datetime import datetime, timezone
import app.main as main_module
from .conftest import TestingSession, auth
from jose import jwt
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.infrastructure.database import Base
from app.infrastructure.models import (
    AlertRow,
    InterventionRow,
    MaintenanceFailureRow,
    PasswordResetTokenRow,
    UserRow,
)
from app.simulation import build_measurement

def sample(**overrides):
    data = {"seq": 1, "temperature": 25, "humidity": 55, "vibration_rate": 0, "vibration_edges": 0, "current_rms": 0, "current_source": "simulated", "acquisition_mode": "simulated"}
    return data | overrides

def test_web_shell_uses_versioned_assets_and_root_service_worker(client):
    page = client.get("/")
    assert page.status_code == 200
    assert page.headers["cache-control"] == "no-cache"
    assert '/static/styles.css?v=9' in page.text
    assert '/static/profile.js?v=9' in page.text
    assert '/static/director.js?v=9' in page.text
    assert '/static/app.js?v=9' in page.text
    assert 'id="director-app"' in page.text
    assert 'id="manager-sidebar"' in page.text
    assert 'id="manager-main" class="manager-main"' in page.text
    assert 'data-manager-page="performance"' in page.text
    worker = client.get("/service-worker.js?v=9")
    assert worker.status_code == 200
    assert worker.headers["service-worker-allowed"] == "/"
    assert worker.headers["cache-control"] == "no-cache"
    assert "/static/director.js?v=9" in worker.text

def test_login_and_machine_requires_auth(client):
    assert client.get("/api/machines").status_code == 401
    assert client.post("/api/auth/login", json={"email":"technician@test.local", "password":"wrong"}).status_code == 401
    assert client.get("/api/machines", headers=auth(client, "technician")).status_code == 200

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
    assert data["availability"]["value"] is None
    assert data["mtbf"]["value"] is None
    assert data["mttr"]["value"] is None

    events = client.get("/api/director/events?days=7&machine_id=test-machine", headers=headers)
    assert events.status_code == 200
    assert events.json()[0]["metric"] == "temperature"
    assert events.json()[0]["alert_status"] == "new"

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

def test_only_manager_can_update_thresholds(client):
    tech = auth(client, "technician"); manager = auth(client, "manager")
    path = "/api/thresholds/test-machine/temperature"
    assert client.put(path, headers=tech, json={"warning":55,"critical":75}).status_code == 403
    assert client.put(path, headers=manager, json={"warning":55,"critical":75}).status_code == 200

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
            "status": "in_progress",
            "diagnosis": "Jeu anormal détecté.",
            "work_done": "Inspection visuelle effectuée.",
            "expected_revision": 1,
            "client_action_id": "offline-action-001",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert updated.json()["status"] == "in_progress"
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
    })
    assert assignment.status_code == 201
    notifications = client.get("/api/notifications", headers=technician).json()
    target = next(item for item in notifications if item["target_type"] == "intervention")
    assert target["read"] is False
    marked = client.post(f"/api/notifications/{target['id']}/read", headers=technician)
    assert marked.status_code == 200
    assert next(item for item in client.get("/api/notifications", headers=technician).json() if item["id"] == target["id"])["read"]


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
