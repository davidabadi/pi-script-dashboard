#!/usr/bin/env python3
"""Read the root-owned full-backup configuration without importing app code."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import stat


class SettingsError(ValueError):
    """A backup setting is missing, unsafe, or malformed."""


def read_private_file(path, *, require_root=True, maximum_bytes=65536):
    """Read a regular, private file through a non-writable, non-symlink chain."""
    file_path = Path(path).absolute()
    try:
        for parent in reversed(file_path.parents):
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise SettingsError("Private configuration parent must be a real directory.")
            if require_root and (info.st_uid != 0 or info.st_mode & 0o022):
                raise SettingsError("Private configuration parents must be root-owned and not writable by other users.")
        original = file_path.lstat()
        if not stat.S_ISREG(original.st_mode):
            raise SettingsError("Private configuration must be a regular file without symlinks.")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(file_path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (original.st_dev, original.st_ino):
                raise SettingsError("Private configuration changed while opening.")
            if require_root and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
                raise SettingsError("Private configuration must be owned by root with mode 0600.")
            value = stream.read(maximum_bytes + 1)
            if len(value) > maximum_bytes:
                raise SettingsError("Private configuration is too large.")
            return value
    except OSError:
        raise SettingsError("Private configuration could not be read safely.") from None


def _text(value, label, *, maximum=4096):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SettingsError(f"Invalid {label}.")
    return value


def _absolute(value, label):
    value = _text(value, label)
    parts = PurePosixPath(value).parts
    if not value.startswith("/") or value.startswith("//") or ".." in parts or "\\" in value:
        raise SettingsError(f"{label} must be an absolute Linux path without parent traversal.")
    normalized = str(PurePosixPath(value))
    if normalized == "/":
        raise SettingsError(f"{label} cannot be the filesystem root.")
    return normalized


def _integer(value, label, *, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise SettingsError(f"Invalid {label}.")
    return value


def _address(value, label):
    value = _text(value, label, maximum=254)
    # A single addr-spec keeps SMTP envelope addresses and message headers equal.
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
        raise SettingsError(f"{label} must contain one email address.")
    local, domain = value.rsplit("@", 1)
    if local.startswith(".") or local.endswith(".") or ".." in local or ".." in domain:
        raise SettingsError(f"Invalid {label}.")
    return value


def _mail_settings(raw):
    if not isinstance(raw, dict):
        raise SettingsError("A mail configuration with sender and recipient is required.")
    transport = raw.get("transport", "auto")
    if transport not in ("auto", "sendmail", "msmtp", "smtp"):
        raise SettingsError("mail.transport must be auto, sendmail, msmtp, or smtp.")
    result = {
        "transport": transport,
        "to": _address(raw.get("to"), "mail.to"),
    }
    if raw.get("from") is not None:
        result["from"] = _address(raw["from"], "mail.from")
    if transport in ("auto", "sendmail", "msmtp"):
        result["sendmail_path"] = _absolute(raw.get("sendmail_path", "/usr/sbin/sendmail"), "mail.sendmail_path")
        result["msmtp_path"] = _absolute(raw.get("msmtp_path", "/usr/bin/msmtp"), "mail.msmtp_path")
    else:
        if "from" not in result:
            raise SettingsError("mail.from is required for the SMTP transport.")
        host = _text(raw.get("smtp_host"), "mail.smtp_host", maximum=253)
        if any(char.isspace() for char in host) or "/" in host or "\\" in host:
            raise SettingsError("Invalid mail.smtp_host.")
        security = raw.get("smtp_security", "starttls")
        if security not in ("starttls", "tls"):
            raise SettingsError("mail.smtp_security must be starttls or tls.")
        result.update(smtp_host=host, smtp_security=security, smtp_port=_integer(raw.get("smtp_port", 465 if security == "tls" else 587), "mail.smtp_port", maximum=65535))
        username = raw.get("smtp_username")
        password_file = raw.get("smtp_password_file")
        if username is not None or password_file is not None:
            result["smtp_username"] = _text(username, "mail.smtp_username", maximum=320)
            result["smtp_password_file"] = _absolute(password_file, "mail.smtp_password_file")
    return result


def load_settings(path, *, notification_only=False, require_root=True):
    """Return normalized settings; notification mode ignores the backup destination."""
    try:
        raw = json.loads(read_private_file(path, require_root=require_root).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise SettingsError("Backup configuration must contain valid UTF-8 JSON.") from None
    if not isinstance(raw, dict):
        raise SettingsError("Backup configuration must be a JSON object.")
    mail = _mail_settings(raw.get("mail"))
    if notification_only:
        return {"mail": mail}
    runtime = _absolute(raw.get("runtime_root", "/var/lib/pi-script-dashboard"), "runtime_root")
    result = {
        "backup_directory": _absolute(raw.get("backup_directory"), "backup_directory"),
        "keep": _integer(raw.get("keep", 7), "keep", maximum=10000),
        "runtime_root": runtime,
        "script_root": _absolute(raw.get("script_root", runtime + "/scripts"), "script_root"),
        "config_root": _absolute(raw.get("config_root", runtime + "/configs"), "config_root"),
        "log_root": _absolute(raw.get("log_root", "/var/log/pi-script-dashboard"), "log_root"),
        "db_file": _absolute(raw.get("db_file", runtime + "/dashboard.sqlite"), "db_file"),
        "session_dir": _absolute(raw.get("session_dir", runtime + "/sessions"), "session_dir"),
        "lock_root": _absolute(raw.get("lock_root", "/run/pi-script-dashboard"), "lock_root"),
        "repo_root": _absolute(raw.get("repo_root", "/opt/pi-script-dashboard"), "repo_root"),
        "service_user": _text(raw.get("service_user", "pi-dashboard"), "service_user", maximum=128),
        "drain_timeout_seconds": _integer(raw.get("drain_timeout_seconds", 3600), "drain_timeout_seconds", maximum=604800),
        "mail": mail,
    }
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", result["service_user"]):
        raise SettingsError("Invalid service_user.")
    extras = raw.get("extra_paths", [])
    if not isinstance(extras, list) or len(extras) > 100:
        raise SettingsError("extra_paths must be an array of absolute Linux paths.")
    result["extra_paths"] = list(dict.fromkeys(_absolute(value, "extra_paths entry") for value in extras))
    return result
