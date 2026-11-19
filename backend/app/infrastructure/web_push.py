import base64
import binascii
import json
import logging
from datetime import datetime, timezone

from requests.exceptions import RequestException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from pywebpush import WebPushException

from app.infrastructure.models import PushSubscriptionRow, TechnicianNotificationRow
from app.settings import settings

logger = logging.getLogger(__name__)


def web_push_is_configured() -> bool:
    return bool(
        settings.web_push_vapid_public_key
        and settings.web_push_vapid_private_key
        and settings.web_push_vapid_subject
    )


def dispatch_web_push(
    db: Session,
    notifications: list[TechnicianNotificationRow],
) -> None:
    if not notifications or not web_push_is_configured():
        return

    from pywebpush import webpush

    private_key = settings.web_push_vapid_private_key
    if private_key.startswith("base64:"):
        try:
            private_key = base64.b64decode(private_key.removeprefix("base64:"), validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            logger.error("Clé privée VAPID illisible; envoi Push ignoré")
            return

    notification_ids = [item.id for item in notifications if item.id is not None]
    if not notification_ids:
        return
    rows = db.scalars(
        select(TechnicianNotificationRow).where(
            TechnicianNotificationRow.id.in_(notification_ids)
        )
    ).all()
    changed = False
    for row in rows:
        subscriptions = db.scalars(
            select(PushSubscriptionRow).where(PushSubscriptionRow.user_id == row.user_id)
        ).all()
        destination = (
            "/#tech-alerts"
            if row.target_type == "alert"
            else "/#tech-interventions"
            if row.target_type == "intervention"
            else "/#tech-notifications"
        )
        payload = json.dumps(
            {
                "title": "PrediMaint",
                "body": row.message,
                "url": destination,
                "tag": f"predimaint-{row.id}",
            },
            ensure_ascii=False,
        )
        for subscription in subscriptions:
            try:
                webpush(
                    subscription_info={
                        "endpoint": subscription.endpoint,
                        "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                    },
                    data=payload,
                    vapid_private_key=private_key,
                    vapid_claims={"sub": settings.web_push_vapid_subject},
                    ttl=60,
                    timeout=5,
                )
                row.push_sent_at = datetime.now(timezone.utc)
                changed = True
            except WebPushException as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                logger.warning(
                    "Envoi Web Push refusé (notification_id=%s, http_status=%s)",
                    row.id,
                    status_code or "inconnu",
                )
                if status_code in (404, 410):
                    db.delete(subscription)
                    changed = True
            except RequestException as exc:
                logger.warning(
                    "Échec réseau Web Push (notification_id=%s, erreur=%s)",
                    row.id,
                    type(exc).__name__,
                )
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "Configuration ou abonnement Web Push invalide (notification_id=%s, erreur=%s)",
                    row.id,
                    type(exc).__name__,
                )
    if changed:
        try:
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            logger.exception("Impossible d'enregistrer l'état d'envoi Web Push")
