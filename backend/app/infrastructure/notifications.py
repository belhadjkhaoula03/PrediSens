import smtplib
from email.message import EmailMessage

from app.settings import settings


def send_email(recipient: str, subject: str, body: str) -> tuple[str, str]:
    if not settings.smtp_host or not settings.smtp_from_email:
        return "in_app_only", ""

    email = EmailMessage()
    email["Subject"] = subject
    email["From"] = settings.smtp_from_email
    email["To"] = recipient
    email.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            if settings.smtp_use_tls:
                server.starttls()
            if settings.smtp_username:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(email)
    except (OSError, smtplib.SMTPException) as exc:
        return "failed", str(exc)[:500]
    return "sent", ""


def send_account_notification(recipient: str, message: str) -> tuple[str, str]:
    return send_email(
        recipient,
        "Mise à jour de votre compte PrediMaint",
        f"Bonjour,\n\n{message}\n\n"
        "Si vous n'êtes pas à l'origine de cette modification, contactez votre administrateur.\n"
        "— PrediMaint",
    )
