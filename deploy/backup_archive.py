"""Root-owned, application-independent full-backup capture and verification.

Install beside the root-owned backup orchestrator, never import this module from
the application checkout as root. Sources are archived without dereferencing
symlinks. The live SQLite file is replaced by an online snapshot in metadata.
"""

from __future__ import annotations

from datetime import datetime, timezone
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import uuid


class BackupError(RuntimeError):
    """A full backup could not be completed safely."""


ARCHIVE_RE = re.compile(r"pi-script-dashboard-\d{8}T\d{6}Z-[0-9a-f]{12}\.tar\.gz\Z")
DEFAULT_SYSTEM_PATHS = (
    "/etc/pi-script-dashboard",
    "/etc/cloudflared",
    "/etc/systemd/system/cloudflared.service",
    "/etc/systemd/system/cloudflared.service.d",
    "/etc/msmtprc",
    "/etc/msmtp",
    "/etc/postfix",
    "/etc/exim4",
    "/etc/ssmtp",
    "/etc/aliases",
    "/root/.msmtprc",
    "/etc/pam.d/pi-script-dashboard",
    "/etc/tmpfiles.d/pi-script-dashboard.conf",
    "/etc/logrotate.d/pi-script-dashboard",
    "/usr/local/libexec/pi-script-dashboard-update",
    "/usr/local/libexec/pi-script-dashboard-backup",
    "/usr/local/libexec/pi-script-dashboard-backup-support",
)
_SNAPSHOT_CODE = r"""
from contextlib import closing
import pathlib, sqlite3, sys
source = pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro'
with closing(sqlite3.connect(source, uri=True, timeout=30)) as source_db:
    with closing(sqlite3.connect(sys.argv[2], timeout=30)) as target_db:
        source_db.backup(target_db, pages=256, sleep=0.05)
        result = target_db.execute('PRAGMA integrity_check').fetchall()
        if result != [('ok',)]:
            raise RuntimeError('SQLite snapshot integrity check failed')
"""


def run_command(args, **kwargs):
    """Run trusted argv without a shell; never echo captured secrets on error."""
    options = {"check": True, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
               "text": True, "timeout": 1800,
               "env": {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "LANG": "C.UTF-8"}}
    options.update(kwargs)
    try:
        return subprocess.run(args, **options)
    except (OSError, subprocess.SubprocessError) as error:
        # Captured stderr can contain private paths/configuration. The journal
        # gets a useful command name and failure class, never command output.
        raise BackupError(f"{Path(args[0]).name} failed ({type(error).__name__}).") from error


def _absolute_path(value, label):
    if not isinstance(value, str) or not value or "\0" in value:
        raise BackupError(f"{label} must be an absolute path.")
    result = Path(value)
    if not result.is_absolute() or str(result) == result.anchor or ".." in result.parts:
        raise BackupError(f"{label} must name an absolute non-root path without '..'.")
    return result


def validate_backup_config(config):
    """Validate trusted configuration and return a normalized copy."""
    if not isinstance(config, dict):
        raise BackupError("Backup configuration must be a JSON object.")
    values = dict(config)
    defaults = {
        "backup_directory": "/var/lib/pi-script-dashboard/backups/servers/pi-dashboard", "keep": 7,
        "runtime_root": "/var/lib/pi-script-dashboard",
        "script_root": "/var/lib/pi-script-dashboard/scripts",
        "config_root": "/var/lib/pi-script-dashboard/configs",
        "log_root": "/var/log/pi-script-dashboard",
        "db_file": "/var/lib/pi-script-dashboard/dashboard.sqlite",
        "repo_root": "/opt/pi-script-dashboard", "service_user": "pi-dashboard",
        "session_dir": "/var/lib/pi-script-dashboard/sessions",
        "lock_root": "/run/pi-script-dashboard", "extra_paths": [],
    }
    for key, value in defaults.items():
        values.setdefault(key, value)
    for key in ("backup_directory", "runtime_root", "script_root", "config_root", "log_root",
                "db_file", "repo_root", "session_dir", "lock_root"):
        values[key] = str(_absolute_path(values.get(key), key))
    if isinstance(values["keep"], bool) or not isinstance(values["keep"], int) or not 1 <= values["keep"] <= 1000:
        raise BackupError("keep must be an integer between 1 and 1000.")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", str(values["service_user"])) or values["service_user"] == "root":
        raise BackupError("service_user must name the unprivileged dashboard account.")
    for key in ("extra_paths", "system_paths"):
        if key not in values:
            continue
        if not isinstance(values[key], list):
            raise BackupError(f"{key} must be an array of absolute paths.")
        values[key] = [str(_absolute_path(value, key)) for value in values[key]]
    output = Path(values["backup_directory"])
    for key in ("runtime_root", "script_root", "config_root", "log_root", "repo_root", "db_file"):
        source = Path(values[key])
        if source == output or source.is_relative_to(output):
            raise BackupError(f"{key} cannot be inside the backup destination.")
    return values


def check_capture_prerequisites(config):
    """Check source availability and required commands without taking a backup."""
    values = validate_backup_config(config)
    _source_paths(values)
    for executable in ("/usr/bin/tar", "/usr/bin/python3", "/usr/bin/crontab", "/usr/sbin/runuser", "/usr/bin/git"):
        if not os.path.isfile(executable) or not os.access(executable, os.X_OK):
            raise BackupError(f"Required backup command is unavailable: {executable}")
    return values


def _private_directory(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise BackupError("Backup directory must be owned by the backup account with mode 0700.")


def _open_destination(path):
    """Create/open an absolute tree using directory FDs, following no symlinks."""
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(path).parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            except FileNotFoundError:
                os.mkdir(part, mode=0o700, dir_fd=current)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        _private_directory(current)
        result = current
        current = None
        return result
    finally:
        if current is not None:
            os.close(current)


def _source_paths(config):
    required = [Path(config[key]) for key in ("runtime_root", "script_root", "config_root", "log_root", "repo_root")]
    for source in required:
        if not source.is_dir() or source.resolve() != source:
            raise BackupError(f"Required source directory is missing or symbolic: {source}")
    db = Path(config["db_file"])
    if not db.is_file() or db.resolve() != db:
        raise BackupError("The configured SQLite database is missing or symbolic.")
    sources = required[:]
    for source in config.get("extra_paths", []):
        path = Path(source)
        if not path.exists() or path.resolve() != path:
            raise BackupError(f"Explicit backup source is missing or symbolic: {path}")
        sources.append(path)
    system_paths = config.get("system_paths", DEFAULT_SYSTEM_PATHS)
    sources.extend(Path(source) for source in system_paths if Path(source).exists())
    if "system_paths" not in config:
        for directory in (Path("/etc/systemd/system"), Path("/usr/lib/systemd/system"), Path("/lib/systemd/system")):
            sources.extend(directory.glob("pi-script-dashboard*"))
    # Include each physical source tree once. Symlinks within trees remain
    # symlinks in tar; no privileged dereference of application-controlled data.
    selected = []
    for source in sorted(set(sources), key=lambda item: (len(item.parts), str(item))):
        if not any(source == parent or source.is_relative_to(parent) for parent in selected):
            selected.append(source)
    return selected


def _exclusions(config):
    runtime = Path(config["runtime_root"])
    exact = [Path(config["db_file"]), Path(config["db_file"] + "-wal"), Path(config["db_file"] + "-shm"),
             Path(config["session_dir"]), Path(config["lock_root"]), runtime / "backups",
             runtime / "update.request", Path(config["backup_directory"])]
    patterns = [str(path).lstrip("/") for path in exact]
    patterns.extend(["*/node_modules", "*/.git", "*/__pycache__", "*/.cache", "*/.pytest_cache",
                     "*.pyc", "*.pyo", "*/backups", "*/.partial-*", "*.sqlite-wal", "*.sqlite-shm"])
    return patterns


def snapshot_database(config, output, *, command_runner=run_command):
    """Read the live database only as its service user, then seal a root copy."""
    import pwd

    account = pwd.getpwnam(config["service_user"])
    if account.pw_uid == 0:
        raise BackupError("The dashboard account must be unprivileged.")
    output = Path(output)
    with tempfile.TemporaryDirectory(prefix="pi-script-dashboard-snapshot-") as temporary:
        stage = Path(temporary)
        if os.geteuid() == 0:
            os.chown(stage, 0, account.pw_gid)
            os.chmod(stage, 0o710)
        elif os.geteuid() != account.pw_uid:
            raise BackupError("Backup must run as root or the dashboard service account.")
        work = stage / "database"
        work.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(work, account.pw_uid, account.pw_gid)
        temporary_db = work / "dashboard.sqlite"
        args = ["/usr/bin/python3", "-I", "-c", _SNAPSHOT_CODE, config["db_file"], str(temporary_db)]
        if os.geteuid() == 0:
            args = ["/usr/sbin/runuser", "-u", account.pw_name, "--", *args]
        command_runner(args, timeout=1800)
        source_fd = os.open(temporary_db, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(source_fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != account.pw_uid or info.st_nlink != 1:
                raise BackupError("SQLite snapshot is not a private regular file.")
            with output.open("xb") as target:
                os.chmod(output, 0o600)
                shutil.copyfileobj(source, target, 1024 * 1024)
                target.flush()
                os.fsync(target.fileno())
    # This is a sealed snapshot, so immutable is correct here and prevents
    # verification creating sidecars. It must never be used for the live DB.
    with closing(sqlite3.connect(output.as_uri() + "?immutable=1", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise BackupError("Copied SQLite snapshot failed its integrity check.")
        if connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").fetchone():
            recovery = connection.execute("SELECT value FROM settings WHERE key='content_recovery'").fetchone()
            if recovery and json.loads(recovery[0]):
                raise BackupError("Recover the interrupted script/config edit before taking a full backup.")


def _write_private(path, content):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        os.chmod(path, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verify_archive(path):
    """Read the entire compressed archive and require recovery metadata."""
    required = {"backup-metadata/manifest.json", "backup-metadata/dashboard.sqlite", "backup-metadata/service-user.crontab"}
    found = set()
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                parts = Path(member.name).parts
                if member.name.startswith("/") or ".." in parts:
                    raise BackupError("Archive contains an unsafe member path.")
                if member.name in required:
                    if not member.isfile():
                        raise BackupError("Archive recovery metadata is not a regular file.")
                    found.add(member.name)
                # Reading through every member ensures corruption after an
                # early tar end block is not mistaken for a good backup.
                if member.isfile():
                    source = archive.extractfile(member)
                    if source is not None:
                        with source:
                            while source.read(1024 * 1024):
                                pass
        # tarfile may stop at tar end-of-archive before the gzip trailer. gzip
        # reading to EOF verifies the compressed stream and its CRC as well.
        import gzip
        with gzip.open(path, "rb") as compressed:
            while compressed.read(1024 * 1024):
                pass
    except (OSError, EOFError, tarfile.TarError) as error:
        raise BackupError("Full archive verification failed.") from error
    if found != required:
        raise BackupError("Full archive is missing recovery metadata.")


def prune_verified_archives(directory_fd, keep):
    """Prune only our completed, checksum-verified regular archive pairs."""
    directory = Path(f"/proc/self/fd/{directory_fd}")
    verified = []
    for filename in os.listdir(directory_fd):
        if not ARCHIVE_RE.fullmatch(filename):
            continue
        archive = directory / filename
        checksum = directory / (filename + ".sha256")
        try:
            archive_info = archive.lstat()
            checksum_info = checksum.lstat()
            if not stat.S_ISREG(archive_info.st_mode) or not stat.S_ISREG(checksum_info.st_mode):
                continue
            if archive_info.st_uid != os.geteuid() or checksum_info.st_uid != os.geteuid():
                continue
            if archive_info.st_nlink != 1 or checksum_info.st_nlink != 1:
                continue
            expected = checksum.read_text(encoding="ascii")
            if expected != f"{_sha256(archive)}  {filename}\n":
                continue
            verified.append(filename)
        except (OSError, UnicodeError):
            continue
    for filename in sorted(verified, reverse=True)[keep:]:
        # The directory is private and pinned. Names were lstat-checked above;
        # unlink never follows a symlink even if a root operator replaces one.
        os.unlink(filename, dir_fd=directory_fd)
        os.unlink(filename + ".sha256", dir_fd=directory_fd)
    os.fsync(directory_fd)


def capture_application(config, *, command_runner=run_command, now=None,
                        database_snapshot=snapshot_database):
    """Create, verify and publish a full backup; then retain the newest N.

    The caller must quiesce application services for a coherent filesystem
    snapshot. SQLite itself is backed up consistently even if cron enqueues.
    Snapshot injection is intended for isolated filesystem tests.
    """
    values = validate_backup_config(config)
    sources = _source_paths(values)
    output_directory = Path(values["backup_directory"])
    directory_fd = None
    partial_names = []
    try:
        directory_fd = _open_destination(output_directory)
        initial_directory = os.fstat(directory_fd)
        # A held FD keeps output directed at the validated private directory.
        destination = Path(f"/proc/self/fd/{directory_fd}")
        created = now or datetime.now(timezone.utc)
        if created.tzinfo is None:
            raise BackupError("Backup timestamp must have an explicit timezone.")
        created = created.astimezone(timezone.utc)
        filename = f"pi-script-dashboard-{created:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:12]}.tar.gz"
        partial = f".partial-{filename}"
        partial_checksum = partial + ".sha256"
        partial_names.extend((partial, partial_checksum))
        with tempfile.TemporaryDirectory(prefix="pi-script-dashboard-backup-") as temporary:
            stage = Path(temporary)
            metadata = stage / "backup-metadata"
            metadata.mkdir(mode=0o700)
            database_snapshot(values, metadata / "dashboard.sqlite", command_runner=command_runner)
            cron = command_runner(["/usr/bin/crontab", "-u", values["service_user"], "-l"], check=False)
            if cron.returncode == 1 and re.fullmatch(r"no crontab for [^\r\n]+\s*", cron.stderr.strip()):
                crontab = ""
            elif cron.returncode != 0:
                raise BackupError("Cannot read the dashboard service-user crontab.")
            else:
                crontab = cron.stdout
            _write_private(metadata / "service-user.crontab", crontab)
            version = command_runner(["/usr/sbin/runuser", "-u", values["service_user"], "--", "/usr/bin/git", "-C", values["repo_root"], "rev-parse", "--verify", "HEAD"], check=False)
            git_commit = version.stdout.strip() if version.returncode == 0 else ""
            if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", git_commit):
                git_commit = None
            manifest = {
                "format_version": 1, "application": "pi-script-dashboard", "created_at_utc": created.isoformat(),
                "archive_name": filename, "service_user": values["service_user"],
                "database_original_path": values["db_file"], "database_snapshot": "backup-metadata/dashboard.sqlite",
                "git_commit": git_commit,
                "sources": [str(source) for source in sources], "exclusions": _exclusions(values),
                "archive_layout": "Original absolute paths without leading slash; recovery metadata in backup-metadata/.",
            }
            _write_private(metadata / "manifest.json", json.dumps(manifest, indent=2) + "\n")
            archive_fd = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=directory_fd)
            os.close(archive_fd)
            arguments = ["/usr/bin/tar", "--create", "--gzip", "--acls", "--xattrs", "--numeric-owner",
                         "--file", str(destination / partial)]
            for exclusion in _exclusions(values):
                arguments.append("--exclude=" + exclusion)
            arguments.extend(["--directory", "/", "--verbatim-files-from", "--null", "--files-from", "-"])
            # Source names enter as NUL-separated data, never tar options.
            source_list = "\0".join(str(source).lstrip("/") for source in sources) + "\0"
            arguments.extend(["--directory", str(stage), "backup-metadata"])
            command_runner(arguments, input=source_list, pass_fds=(directory_fd,))
            archive_path = destination / partial
            _verify_archive(archive_path)
            digest = _sha256(archive_path)
            _write_private(destination / partial_checksum, f"{digest}  {filename}\n")
            with archive_path.open("rb") as stream:
                os.fsync(stream.fileno())
            final_directory = output_directory.stat()
            if final_directory.st_dev != initial_directory.st_dev or final_directory.st_ino != initial_directory.st_ino:
                raise BackupError("Backup directory changed while the backup was being captured.")
            os.rename(partial, filename, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            os.rename(partial_checksum, filename + ".sha256", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            os.fsync(directory_fd)
            prune_verified_archives(directory_fd, values["keep"])
        return output_directory / filename
    finally:
        if directory_fd is not None:
            for partial in partial_names:
                try:
                    os.unlink(partial, dir_fd=directory_fd)
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
            os.close(directory_fd)
