import logging
import os
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.infrastructure.database import SessionLocal
from app.infrastructure.models import DatabaseBackupRow, SystemSettingRow
from app.settings import settings

logger = logging.getLogger(__name__)
DEFAULT_INTERVAL_MINUTES = 1440
BACKUP_TIMEOUT_SECONDS = 3600
BACKUP_DIRECTORY = Path(settings.backup_directory)
_backup_lock = threading.Lock()


class BackupError(RuntimeError):
    pass


def _setting(db: Session, key: str, default: str) -> str:
    row = db.get(SystemSettingRow, key)
    return row.value if row else default


def _set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(SystemSettingRow, key)
    if row is None:
        db.add(SystemSettingRow(key=key, value=value))
    else:
        row.value = value


def backup_configuration(db: Session) -> dict:
    enabled = _setting(db, "backup_enabled", "true") == "true"
    interval_minutes = int(_setting(db, "backup_interval_minutes", str(DEFAULT_INTERVAL_MINUTES)))
    next_run_value = _setting(db, "backup_next_run_at", "")
    next_run_at = datetime.fromisoformat(next_run_value) if next_run_value else None
    if next_run_at is not None and next_run_at.tzinfo is None:
        next_run_at = next_run_at.replace(tzinfo=timezone.utc)
    return {
        "enabled": enabled,
        "interval_minutes": interval_minutes,
        "next_run_at": next_run_at,
    }


def set_backup_schedule(db: Session, enabled: bool, interval_minutes: int) -> datetime | None:
    next_run_at = (
        datetime.now(timezone.utc) + timedelta(minutes=interval_minutes)
        if enabled else None
    )
    _set_setting(db, "backup_enabled", str(enabled).lower())
    _set_setting(db, "backup_interval_minutes", str(interval_minutes))
    _set_setting(
        db,
        "backup_next_run_at",
        next_run_at.isoformat() if next_run_at is not None else "",
    )
    return next_run_at


def backup_file_path(filename: str) -> Path:
    if Path(filename).name != filename or not filename.endswith(".dump"):
        raise BackupError("Nom de sauvegarde invalide.")
    directory = BACKUP_DIRECTORY.resolve()
    path = (directory / filename).resolve()
    if path.parent != directory:
        raise BackupError("Chemin de sauvegarde invalide.")
    return path


def _pg_dump_arguments(path: Path) -> tuple[list[str], dict[str, str]]:
    database_url = make_url(settings.database_url)
    if database_url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise BackupError("La sauvegarde nécessite une base PostgreSQL.")
    if not database_url.database or not database_url.username:
        raise BackupError("La configuration PostgreSQL est incomplète.")

    environment = {}
    if database_url.password is not None:
        environment["PGPASSWORD"] = database_url.password
    sslmode = database_url.query.get("sslmode")
    if sslmode:
        environment["PGSSLMODE"] = str(sslmode)

    arguments = [
        "pg_dump",
        "--no-password",
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--host", database_url.host or "localhost",
        "--port", str(database_url.port or 5432),
        "--username", database_url.username,
        "--dbname", database_url.database,
        "--file", str(path),
    ]
    return arguments, environment


def _mark_failed(db: Session, row: DatabaseBackupRow, path: Path, message: str) -> None:
    if path.exists():
        try:
            path.unlink()
        except OSError:
            logger.exception("Impossible de supprimer le fichier partiel de sauvegarde (backup_id=%s)", row.id)
    row.status = "failed"
    row.size_bytes = None
    row.error_message = message
    db.commit()
    logger.error("Échec sauvegarde PostgreSQL (backup_id=%s, cause=%s)", row.id, message)


def reconcile_interrupted_backups(db: Session) -> None:
    rows = db.query(DatabaseBackupRow).filter(DatabaseBackupRow.status == "running").all()
    for row in rows:
        try:
            path = backup_file_path(row.filename)
            if path.is_file() and path.stat().st_size > 0:
                result = subprocess.run(
                    ["pg_restore", "--list", str(path)],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if result.returncode == 0:
                    row.status = "succeeded"
                    row.size_bytes = path.stat().st_size
                    row.error_message = ""
                    continue
            if path.exists():
                path.unlink()
        except (BackupError, OSError, subprocess.TimeoutExpired):
            logger.warning("Fichier de sauvegarde interrompue indisponible (backup_id=%s)", row.id)
        row.status = "failed"
        row.size_bytes = None
        row.error_message = "La sauvegarde a été interrompue avant sa validation."
    db.commit()


def create_backup(db: Session, trigger: str = "manual") -> DatabaseBackupRow:
    if not _backup_lock.acquire(blocking=False):
        raise BackupError("Une sauvegarde est déjà en cours.")
    try:
        created_at = datetime.now(timezone.utc)
        filename = f"predimaint-{created_at:%Y%m%d-%H%M%S}-{uuid4().hex[:8]}.dump"
        row = DatabaseBackupRow(
            filename=filename,
            created_at=created_at,
            size_bytes=None,
            status="running",
            trigger=trigger,
        )
        db.add(row)
        db.commit()
        db.refresh(row)

        path = backup_file_path(filename)
        try:
            BACKUP_DIRECTORY.mkdir(parents=True, exist_ok=True, mode=0o700)
            BACKUP_DIRECTORY.chmod(0o700)
            arguments, database_environment = _pg_dump_arguments(path)
            environment = {"PATH": os.environ.get("PATH", "")}
            environment.update(database_environment)
            dump_result = subprocess.run(
                arguments,
                check=False,
                capture_output=True,
                text=True,
                timeout=BACKUP_TIMEOUT_SECONDS,
                env=environment,
            )
            if dump_result.returncode != 0:
                _mark_failed(db, row, path, f"pg_dump a terminé avec le code {dump_result.returncode}.")
                raise BackupError("La sauvegarde a échoué pendant l’export PostgreSQL.")
            if not path.is_file() or path.stat().st_size <= 0:
                _mark_failed(db, row, path, "Le fichier créé est absent ou vide.")
                raise BackupError("pg_dump n’a pas produit un fichier de sauvegarde valide.")
            path.chmod(0o600)
            verify_result = subprocess.run(
                ["pg_restore", "--list", str(path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if verify_result.returncode != 0:
                _mark_failed(db, row, path, "pg_restore n’a pas reconnu le fichier.")
                raise BackupError("Le fichier produit n’a pas passé la vérification d’intégrité.")

            row.status = "succeeded"
            row.size_bytes = path.stat().st_size
            row.error_message = ""
            db.commit()
            db.refresh(row)
            logger.info(
                "Sauvegarde PostgreSQL réussie (backup_id=%s, taille_octets=%s)",
                row.id,
                row.size_bytes,
            )
            return row
        except BackupError:
            if row.status == "running":
                _mark_failed(db, row, path, "La création ou la vérification du fichier a échoué.")
            raise
        except subprocess.TimeoutExpired:
            _mark_failed(db, row, path, "La commande de sauvegarde a dépassé sa durée limite.")
            raise BackupError("La sauvegarde a dépassé sa durée limite.") from None
        except OSError:
            _mark_failed(db, row, path, "Outil pg_dump ou stockage de sauvegarde indisponible.")
            raise BackupError("Outil de sauvegarde ou stockage indisponible.") from None
        except Exception as exc:
            db.rollback()
            logger.exception(
                "Erreur inattendue pendant la sauvegarde PostgreSQL (backup_id=%s, type=%s)",
                row.id,
                type(exc).__name__,
            )
            try:
                _mark_failed(db, row, path, "Erreur interne pendant la création de la sauvegarde.")
            except Exception:
                db.rollback()
                logger.exception("Impossible de conserver le statut d'échec (backup_id=%s)", row.id)
            raise BackupError("Erreur interne pendant la création de la sauvegarde.") from None
    finally:
        _backup_lock.release()


def run_backup_scheduler(stop_event: threading.Event) -> None:
    logger.info("Planificateur de sauvegardes PostgreSQL démarré")
    while not stop_event.is_set():
        db = SessionLocal()
        try:
            configuration = backup_configuration(db)
            if not configuration["enabled"]:
                wait_seconds = 30
            else:
                next_run_at = configuration["next_run_at"]
                if next_run_at is None:
                    next_run_at = set_backup_schedule(
                        db,
                        True,
                        configuration["interval_minutes"],
                    )
                    db.commit()
                wait_seconds = max(
                    0,
                    (next_run_at - datetime.now(timezone.utc)).total_seconds(),
                )
        except Exception:
            logger.exception("Impossible de lire la configuration de sauvegarde automatique")
            wait_seconds = 30
        finally:
            db.close()

        if wait_seconds > 0:
            stop_event.wait(min(wait_seconds, 30))
            continue

        db = SessionLocal()
        try:
            create_backup(db, trigger="automatic")
        except BackupError as exc:
            logger.warning("Sauvegarde automatique non effectuée: %s", exc)
        except Exception:
            logger.exception("Erreur inattendue de la sauvegarde automatique")
        finally:
            db.close()

        db = SessionLocal()
        try:
            configuration = backup_configuration(db)
            if configuration["enabled"]:
                set_backup_schedule(db, True, configuration["interval_minutes"])
            else:
                set_backup_schedule(db, False, configuration["interval_minutes"])
            db.commit()
        except Exception:
            logger.exception("Impossible de planifier la prochaine sauvegarde")
        finally:
            db.close()
