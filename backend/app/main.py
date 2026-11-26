import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, select, text
from pwdlib import PasswordHash
from app.api.admin import router as admin_router
from app.api.director import router as director_router
from app.api.manager import router as manager_router
from app.api.routes import router
from app.infrastructure.database import Base, SessionLocal, engine
from app.infrastructure.database_backups import reconcile_interrupted_backups, run_backup_scheduler
from app.infrastructure.models import (
    MachineRow,
    MachineTechnicianAccessRow,
    SensorRow,
    ThresholdRow,
    UserRow,
)
from app.infrastructure.mqtt_client import MqttIngestor
from app.settings import settings

logging.basicConfig(level=logging.INFO)
passwords = PasswordHash.recommended()


def initialize_data():
    Base.metadata.create_all(bind=engine)
    user_columns = {column["name"] for column in inspect(engine).get_columns("users")}
    timestamp_type = "TIMESTAMP WITH TIME ZONE" if engine.dialect.name == "postgresql" else "TIMESTAMP"
    migrations = {
        "full_name": "VARCHAR(160) NOT NULL DEFAULT ''",
        "phone": "VARCHAR(40) NOT NULL DEFAULT ''",
        "token_version": "INTEGER NOT NULL DEFAULT 0",
        "created_at": timestamp_type,
        "last_login": timestamp_type,
    }
    with engine.begin() as connection:
        for column, definition in migrations.items():
            if column not in user_columns:
                connection.execute(text(f"ALTER TABLE users ADD COLUMN {column} {definition}"))
        connection.execute(text("UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"))
    measurement_columns = {column["name"] for column in inspect(engine).get_columns("measurements")}
    if "acquisition_mode" not in measurement_columns:
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE measurements ADD COLUMN acquisition_mode VARCHAR(20) NOT NULL DEFAULT 'hardware'")
            )
    if engine.dialect.name == "postgresql":
        current_rms_column = next(
            column for column in inspect(engine).get_columns("measurements")
            if column["name"] == "current_rms"
        )
        if not current_rms_column["nullable"]:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE measurements ALTER COLUMN current_rms DROP NOT NULL")
                )
    table_migrations = {
        "user_notifications": {
            "read_at": timestamp_type,
        },
        "technician_notifications": {
            "push_sent_at": timestamp_type,
            "received_at": timestamp_type,
        },
        "alerts": {
            "acknowledged_by_id": "INTEGER",
            "acknowledged_at": timestamp_type,
            "acquisition_mode": "VARCHAR(20)",
        },
        "measurements": {
            "received_at": timestamp_type,
        },
        "alert_events": {
            "source_measurement_id": "INTEGER REFERENCES measurements(id) ON DELETE SET NULL",
            "processing_delay_ms": "INTEGER",
        },
        "interventions": {
            "assigned_to_id": "INTEGER",
            "title": "VARCHAR(200) NOT NULL DEFAULT ''",
            "priority": "VARCHAR(20) NOT NULL DEFAULT 'normal'",
            "status": "VARCHAR(20) NOT NULL DEFAULT 'completed'",
            "due_at": timestamp_type,
            "diagnosis": "TEXT NOT NULL DEFAULT ''",
            "work_done": "TEXT NOT NULL DEFAULT ''",
            "result": "TEXT NOT NULL DEFAULT ''",
            "updated_at": timestamp_type,
            "accepted_at": timestamp_type,
            "completed_at": timestamp_type,
            "resolved_at": timestamp_type,
            "revision": "INTEGER NOT NULL DEFAULT 1",
        },
        "manager_confirmed_failures": {
            "intervention_id": "INTEGER REFERENCES interventions(id) ON DELETE SET NULL",
        },
    }
    existing_tables = set(inspect(engine).get_table_names())
    with engine.begin() as connection:
        for table, columns in table_migrations.items():
            if table not in existing_tables:
                continue
            existing_columns = {column["name"] for column in inspect(engine).get_columns(table)}
            for column, definition in columns.items():
                if column not in existing_columns:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
        if "interventions" in existing_tables:
            connection.execute(
                text("UPDATE interventions SET updated_at = created_at WHERE updated_at IS NULL")
            )
    # create_all creates new tables but does not add columns to an existing volume.
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE machines ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_measurements_machine_recorded_at ON measurements (machine_id, recorded_at)"))
            for constraint in inspect(engine).get_unique_constraints("sensors"):
                if set(constraint.get("column_names") or ()) == {"machine_id", "metric"}:
                    constraint_name = (constraint.get("name") or "").replace('"', '""')
                    if constraint_name:
                        connection.execute(
                            text(f'ALTER TABLE sensors DROP CONSTRAINT IF EXISTS "{constraint_name}"')
                        )
            connection.execute(
                text("CREATE INDEX IF NOT EXISTS ix_alert_events_source_measurement_id ON alert_events (source_measurement_id)")
            )
            backup_size_column = next(
                column
                for column in inspect(engine).get_columns("database_backups")
                if column["name"] == "size_bytes"
            )
            if "BIGINT" not in str(backup_size_column["type"]).upper():
                connection.execute(
                    text("ALTER TABLE database_backups ALTER COLUMN size_bytes TYPE BIGINT")
                )
    if "interventions" in existing_tables:
        with engine.begin() as connection:
            connection.execute(
                text("CREATE INDEX IF NOT EXISTS ix_interventions_assigned_status ON interventions (assigned_to_id, status)")
            )
    db = SessionLocal()
    try:
        if db.get(MachineRow, "demo-machine") is None:
            db.add(MachineRow(id="demo-machine", name="Machine principale", description="Banc ESP32 PrediMaint"))
            db.flush()
        else:
            machine = db.get(MachineRow, "demo-machine")
            if machine.name == "Machine de démonstration":
                machine.name = "Machine principale"
        seed_users = [
            ("tech@predimaint.local", settings.demo_tech_password, "technician", "Samir Trabelsi"),
            ("manager@predimaint.local", settings.demo_manager_password, "manager", "Leila Ben Ahmed"),
            ("director@predimaint.local", settings.demo_director_password, "director", "Mohamed Ali"),
            (settings.demo_admin_email.lower(), settings.demo_admin_password, "admin", "Administrateur système"),
        ]
        for email, password, role, full_name in seed_users:
            if role == "admin":
                user = db.scalar(select(UserRow).where(UserRow.role == "admin").order_by(UserRow.id).limit(1))
                if user is None and db.scalar(select(UserRow).where(UserRow.email == email)):
                    raise RuntimeError(
                        f"DEMO_ADMIN_EMAIL ({email}) is already assigned to a non-administrator account"
                    )
            else:
                user = db.scalar(select(UserRow).where(UserRow.email == email))
            if user is None:
                user = UserRow(
                    email=email,
                    password_hash=passwords.hash(password),
                    role=role,
                    full_name=full_name,
                )
                db.add(user)
            elif not user.full_name:
                user.full_name = full_name
        defaults = [("temperature", 60, 75), ("humidity", 85, 95), ("vibration_rate", 10, 30), ("current_rms", 3, 5)]
        for metric, warning, critical in defaults:
            if not db.scalar(select(ThresholdRow).where(ThresholdRow.machine_id == "demo-machine", ThresholdRow.metric == metric)):
                db.add(ThresholdRow(machine_id="demo-machine", metric=metric, warning=warning, critical=critical))
        default_sensors = [
            ("temperature", "DHT22", 27, "°C"),
            ("humidity", "DHT22", 27, "%"),
            ("vibration_rate", "HW-072 numérique", 16, "événements/s"),
            ("current_rms", "ACS712 (courant simulé par défaut)", 34, "A"),
        ]
        for metric, sensor_type, gpio, unit in default_sensors:
            if not db.scalar(select(SensorRow).where(SensorRow.machine_id == "demo-machine", SensorRow.metric == metric)):
                db.add(SensorRow(machine_id="demo-machine", metric=metric, sensor_type=sensor_type, gpio=gpio, unit=unit))
        default_technician = db.scalar(
            select(UserRow).where(
                UserRow.email == "tech@predimaint.local",
                UserRow.role == "technician",
            )
        )
        if default_technician is not None and db.scalar(
            select(MachineTechnicianAccessRow).where(
                MachineTechnicianAccessRow.machine_id == "demo-machine",
                MachineTechnicianAccessRow.technician_id == default_technician.id,
            )
        ) is None:
            db.add(
                MachineTechnicianAccessRow(
                    machine_id="demo-machine",
                    technician_id=default_technician.id,
                )
            )
        db.commit()
        reconcile_interrupted_backups(db)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_data()
    ingestor = None
    backup_stop_event = threading.Event()
    backup_scheduler = threading.Thread(
        target=run_backup_scheduler,
        args=(backup_stop_event,),
        name="database-backup-scheduler",
        daemon=True,
    )
    backup_scheduler.start()
    if settings.mqtt_enabled:
        ingestor = MqttIngestor()
        ingestor.start()
        app.state.mqtt_ingestor = ingestor
    try:
        yield
    finally:
        backup_stop_event.set()
        backup_scheduler.join(timeout=5)
        if ingestor is not None:
            ingestor.stop()


app = FastAPI(title="PrediMaint API", version="0.1.0", lifespan=lifespan)
app.include_router(router)
app.include_router(admin_router)
app.include_router(manager_router)
app.include_router(director_router)
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(static_dir / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/service-worker.js", include_in_schema=False)
def service_worker():
    return FileResponse(
        static_dir / "service-worker.js",
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
        },
    )
