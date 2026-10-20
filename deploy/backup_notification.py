#!/usr/bin/env python3
"""Send a bounded backup-failure alert without opening backup files or the DB."""

import argparse
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
import re
import os
from pathlib import Path
import smtplib
import socket
import ssl
import subprocess
import sys

# The systemd alert runs in isolated Python mode, independently of the archive
# engine. Only the installed root-owned support directory supplies its imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backup_settings import SettingsError, load_settings, read_private_file


class NotificationError(RuntimeError):
    """Delivery failed; the exception deliberately excludes transport details."""


SUMMARY_MESSAGES = {
    "failed": "The full application backup did not complete successfully.",
    "destination-unavailable": "The configured backup destination is unavailable or did not pass verification.",
    "drain-timeout": "The application did not finish its active work within the backup drain timeout.",
    "archive-failed": "The full application archive could not be completed and verified.",
    "restore-services-failed": "One or more application services could not be restored after the backup attempt.",
}


def failure_message(config, *, unit_name, summary, now=None):
    if not isinstance(unit_name, str) or not re.fullmatch(r"[A-Za-z0-9_.@:-]{1,160}\.service", unit_name):
        raise NotificationError("Invalid backup service name.")
    host = re.sub(r"[^A-Za-z0-9_.-]", "_", socket.gethostname())[:253] or "unknown-host"
    when = now or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    message = EmailMessage()
    message["To"] = config["mail"]["to"]
    if "from" in config["mail"]:
        message["From"] = config["mail"]["from"]
    message["Subject"] = f"[{host}] Pi dashboard backup failed"
    message["Date"] = format_datetime(when)
    message["Message-ID"] = make_msgid(domain=host)
    message.set_content(
        f"{SUMMARY_MESSAGES.get(summary, SUMMARY_MESSAGES['failed'])}\n\n"
        f"Host: {host}\nService: {unit_name}\nTime: {when.isoformat()}\n\n"
        "Inspect the backup service locally for details:\n"
        f"  sudo systemctl status {unit_name}\n"
        f"  sudo journalctl -u {unit_name} --since '8 days ago'\n\n"
        "This alert does not contain application logs, configuration files, or credentials.\n"
        "A failed backup must be investigated before relying on the weekly backup schedule.\n"
    )
    return message


def resolve_local_transport(mail):
    """Check local mail executables without sending; return argv, or None for SMTP."""
    if mail["transport"] == "smtp":
        return None
    if mail["transport"] == "auto":
        command_key = next((key for key in ("sendmail_path", "msmtp_path") if os.path.isfile(mail[key]) and os.access(mail[key], os.X_OK)), None)
        if command_key is None:
            raise NotificationError("No local sendmail or msmtp executable was found for backup failure email.")
    else:
        command_key = "sendmail_path" if mail["transport"] == "sendmail" else "msmtp_path"
        if not os.path.isfile(mail[command_key]) or not os.access(mail[command_key], os.X_OK):
            raise NotificationError("The configured local mail executable is unavailable for backup failure email.")
    command = [mail[command_key], "-t"]
    if command_key == "sendmail_path":
        command.append("-oi")
    return command


def send_failure_email(config, *, unit_name, summary="failed", now=None, runner=subprocess.run):
    """Deliver one alert using a local MTA or certificate-verified SMTP over TLS."""
    message = failure_message(config, unit_name=unit_name, summary=summary, now=now)
    mail = config["mail"]
    command = resolve_local_transport(mail)
    if command is not None:
        try:
            runner(command, input=message.as_bytes(), check=True, timeout=30, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            raise NotificationError("Backup failure email could not be delivered by the configured local mail transport.") from None
        return
    try:
        password = None
        if "smtp_username" in mail:
            password = read_private_file(mail["smtp_password_file"], maximum_bytes=4096).decode("utf-8").rstrip("\r\n")
            if not password or "\x00" in password or "\r" in password or "\n" in password:
                raise SettingsError("SMTP password file must contain one nonempty line.")
        context = ssl.create_default_context()
        if mail["smtp_security"] == "tls":
            connection = smtplib.SMTP_SSL(mail["smtp_host"], mail["smtp_port"], timeout=30, context=context)
        else:
            connection = smtplib.SMTP(mail["smtp_host"], mail["smtp_port"], timeout=30)
        with connection:
            connection.ehlo()
            if mail["smtp_security"] == "starttls":
                connection.starttls(context=context)
                connection.ehlo()
            if password is not None:
                connection.login(mail["smtp_username"], password)
            connection.send_message(message, from_addr=mail["from"], to_addrs=[mail["to"]])
    except Exception:
        raise NotificationError("Backup failure email could not be delivered by SMTP; check mail settings and connectivity locally.") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/pi-script-dashboard/backup.json")
    parser.add_argument("--unit", default="pi-script-dashboard-backup.service")
    parser.add_argument("--summary", default="failed", choices=tuple(SUMMARY_MESSAGES))
    args = parser.parse_args(argv)
    try:
        config = load_settings(args.config, notification_only=True)
        send_failure_email(config, unit_name=args.unit, summary=args.summary)
        print("Backup failure email submitted.")
        return 0
    except (SettingsError, NotificationError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
