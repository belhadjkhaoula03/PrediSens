import json
import logging
import threading
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from app.application.services import MeasurementInput
from app.infrastructure.database import SessionLocal
from app.infrastructure.models import MachineRow
from app.infrastructure.repository import SqlMeasurementRepository, record_machine_status
from app.settings import settings

logger = logging.getLogger(__name__)
TELEMETRY_TOPIC = "predimaint/+/telemetry"
STATUS_TOPIC = "predimaint/+/status"


class MqttIngestor:
    def __init__(self):
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="predimaint-backend")
        if settings.mqtt_username:
            self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self.client.on_connect = self.on_connect
        self.client.on_subscribe = self.on_subscribe
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.thread = None
        self._subscriptions = {}

    def on_connect(self, client, userdata, flags, reason_code, properties):
        if getattr(reason_code, "value", reason_code) != 0:
            logger.error("Connexion au broker MQTT refusée (code=%s)", reason_code)
            return

        logger.info("Connexion au broker MQTT établie (%s:%s)", settings.mqtt_host, settings.mqtt_port)
        for topic in (TELEMETRY_TOPIC, STATUS_TOPIC):
            result, message_id = client.subscribe(topic, qos=1)
            if result != mqtt.MQTT_ERR_SUCCESS:
                logger.error("Demande d'abonnement MQTT refusée (topic=%s, code=%s)", topic, result)
                continue
            self._subscriptions[message_id] = topic
            logger.info("Demande d'abonnement MQTT envoyée (topic=%s, qos=1)", topic)

    def on_subscribe(self, client, userdata, message_id, reason_code_list, properties):
        topic = self._subscriptions.pop(message_id, "topic inconnu")
        failed_codes = [
            code for code in reason_code_list
            if getattr(code, "is_failure", False)
        ]
        if failed_codes:
            logger.error(
                "Abonnement MQTT refusé par le broker (topic=%s, codes=%s)",
                topic,
                ",".join(str(code) for code in failed_codes),
            )
        else:
            logger.info("Abonnement MQTT confirmé (topic=%s)", topic)

    def on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        if getattr(reason_code, "value", reason_code) == 0:
            logger.info("Déconnexion MQTT normale")
        else:
            logger.warning("Connexion MQTT interrompue (code=%s); reconnexion automatique active", reason_code)

    def on_message(self, client, userdata, message):
        parts = message.topic.split("/")
        if len(parts) != 3 or parts[0] != "predimaint" or not parts[1]:
            logger.warning("Message MQTT ignoré (topic invalide)")
            return
        machine_id, kind = parts[1], parts[2]
        if kind == "status" and machine_id == "predimaint_backend":
            return
        if kind not in {"telemetry", "status"}:
            logger.warning("Message MQTT ignoré (type de topic inconnu: %s)", kind)
            return
        logger.info("Message MQTT reçu (topic=%s, machine_id=%s, type=%s)", message.topic, machine_id, kind)
        db = SessionLocal()
        try:
            if kind == "status":
                machine = db.get(MachineRow, machine_id)
                if machine is None:
                    logger.warning("Statut MQTT ignoré (machine non déclarée: %s)", machine_id)
                    return
                state = message.payload.decode("utf-8").strip()
                if state not in {"online", "offline"}:
                    logger.warning("Statut MQTT invalide (machine_id=%s)", machine_id)
                    return
                status_received_at = datetime.now(timezone.utc)
                record_machine_status(db, machine, state, "mqtt_status", status_received_at)
                machine.last_seen = status_received_at
                db.commit()
                logger.info("Statut MQTT enregistré (machine_id=%s, status=%s)", machine_id, state)
                return
            data = MeasurementInput.model_validate(json.loads(message.payload))
            logger.info(
                "Mesure MQTT validée (machine_id=%s, seq=%s, acquisition_mode=%s, current_source=%s)",
                machine_id,
                data.seq,
                data.acquisition_mode,
                data.current_source,
            )
            row = SqlMeasurementRepository(db).receive(machine_id, data)
            logger.info(
                "Mesure enregistrée dans PostgreSQL (machine_id=%s, measurement_id=%s, seq=%s, acquisition_mode=%s, current_source=%s)",
                machine_id,
                row.id,
                row.seq,
                row.acquisition_mode,
                row.current_source,
            )
        except ValidationError as exc:
            field_errors = ",".join(
                f"{'.'.join(str(part) for part in error['loc']) or 'payload'}:{error['type']}"
                for error in exc.errors(include_input=False, include_context=False)
            )
            logger.warning(
                "Message MQTT rejeté (topic=%s, erreur=ValidationError, champs=%s)",
                message.topic,
                field_errors,
            )
            db.rollback()
        except (ValueError, LookupError, json.JSONDecodeError) as exc:
            logger.warning(
                "Message MQTT rejeté (topic=%s, erreur=%s)",
                message.topic,
                type(exc).__name__,
            )
            db.rollback()
        except SQLAlchemyError as exc:
            logger.exception(
                "Échec de base de données pendant l'ingestion MQTT (topic=%s, erreur=%s)",
                message.topic,
                type(exc).__name__,
            )
            db.rollback()
        except Exception as exc:
            logger.exception(
                "Erreur inattendue de traitement MQTT (topic=%s, erreur=%s)",
                message.topic,
                type(exc).__name__,
            )
            db.rollback()
        finally:
            db.close()

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        try:
            self.client.connect_async(settings.mqtt_host, settings.mqtt_port, keepalive=30)
            self.client.loop_forever()
        except Exception:
            logger.exception("Arrêt inattendu de la boucle cliente MQTT")

    def stop(self):
        self.client.disconnect()
        if self.thread is not None and self.thread.is_alive():
            self.thread.join(timeout=5)
