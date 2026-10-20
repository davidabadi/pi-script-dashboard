"""Full application archive safety, contents, consistency and retention checks."""

from datetime import datetime, timezone, timedelta
from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "backup_archive", Path(__file__).resolve().parents[1] / "deploy" / "backup_archive.py"
)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
LINUX_CAPTURE = os.name == "posix" and Path("/proc/self/fd").is_dir() and Path("/usr/bin/tar").is_file()


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.config = {
            key: str(self.root / key) for key in (
                "backup_directory", "runtime_root", "script_root", "config_root", "log_root",
                "db_file", "repo_root", "session_dir", "lock_root",
            )
        }

    def test_defaults_keep_seven_and_use_unprivileged_account(self):
        config = backup.validate_backup_config(self.config)
        self.assertEqual(config["keep"], 7)
        self.assertEqual(config["service_user"], "pi-dashboard")
        self.assertEqual(config["extra_paths"], [])

    def test_relative_root_and_parent_paths_are_rejected(self):
        for value in ("relative", str(self.root.anchor), str(self.root / ".." / "elsewhere")):
            with self.subTest(value=value), self.assertRaises(backup.BackupError):
                backup.validate_backup_config({**self.config, "backup_directory": value})

    def test_invalid_retention_values_are_rejected(self):
        for value in (True, 0, -1, "7", 1001):
            with self.subTest(value=value), self.assertRaises(backup.BackupError):
                backup.validate_backup_config({**self.config, "keep": value})

    def test_source_inside_destination_is_rejected(self):
        with self.assertRaises(backup.BackupError):
            backup.validate_backup_config({**self.config, "repo_root": str(self.root / "backup_directory" / "repo")})

    def test_root_and_option_like_service_accounts_are_rejected(self):
        for value in ("root", "--help", "user name", "user\nname"):
            with self.subTest(value=value), self.assertRaises(backup.BackupError):
                backup.validate_backup_config({**self.config, "service_user": value})

    def test_explicit_extra_paths_require_absolute_paths(self):
        for value in ("/etc/config", ["relative"]):
            with self.subTest(value=value), self.assertRaises(backup.BackupError):
                backup.validate_backup_config({**self.config, "extra_paths": value})

    def test_command_errors_do_not_disclose_captured_secret_output(self):
        from unittest.mock import patch
        with patch.object(backup.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["tar"], stderr="secret-token")):
            with self.assertRaises(backup.BackupError) as failure:
                backup.run_command(["/usr/bin/tar"])
        self.assertNotIn("secret-token", str(failure.exception))


class ArchiveVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.archive = Path(self.temporary.name) / "backup.tar.gz"

    def write_archive(self, members):
        with tarfile.open(self.archive, "w:gz") as archive:
            for filename in members:
                content = b"metadata"
                entry = tarfile.TarInfo(filename)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))

    def test_recovery_metadata_is_required(self):
        self.write_archive(["backup-metadata/manifest.json"])
        with self.assertRaisesRegex(backup.BackupError, "missing recovery metadata"):
            backup._verify_archive(self.archive)

    def test_unsafe_archive_members_are_rejected(self):
        self.write_archive(["../outside"])
        with self.assertRaisesRegex(backup.BackupError, "unsafe member"):
            backup._verify_archive(self.archive)

    def test_corrupt_compressed_archive_is_rejected(self):
        self.archive.write_bytes(b"not a gzip archive")
        with self.assertRaisesRegex(backup.BackupError, "verification failed"):
            backup._verify_archive(self.archive)

    def test_complete_archive_is_verified(self):
        self.write_archive(["backup-metadata/manifest.json", "backup-metadata/dashboard.sqlite", "backup-metadata/service-user.crontab"])
        backup._verify_archive(self.archive)


@unittest.skipUnless(LINUX_CAPTURE, "Requires Linux SQLite helper and account lookup")
class DatabaseSnapshotTests(unittest.TestCase):
    def setUp(self):
        import pwd
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.account = pwd.getpwnam("nobody") if os.geteuid() == 0 else pwd.getpwuid(os.geteuid())
        if os.geteuid() == 0:
            os.chown(self.root, self.account.pw_uid, self.account.pw_gid)
        self.source = self.root / "live.sqlite"
        self.connection = sqlite3.connect(self.source)
        self.addCleanup(self.connection.close)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE jobs (name TEXT)")
        self.connection.execute("CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)")
        self.connection.execute("INSERT INTO jobs VALUES ('Committed in WAL')")
        self.connection.execute("INSERT INTO settings VALUES ('content_recovery','null')")
        self.connection.commit()
        if os.geteuid() == 0:
            for source in self.root.iterdir():
                os.chown(source, self.account.pw_uid, self.account.pw_gid)
        self.config = {"service_user": self.account.pw_name, "db_file": str(self.source)}

    def test_real_isolated_helper_copies_committed_wal_and_preserves_source_ownership(self):
        original = {file.name: file.stat().st_uid for file in self.root.iterdir()}
        destination = self.root / "snapshot.sqlite"
        backup.snapshot_database(self.config, destination)
        with closing(sqlite3.connect(destination.as_uri() + "?immutable=1", uri=True)) as result:
            self.assertEqual(result.execute("SELECT name FROM jobs").fetchone()[0], "Committed in WAL")
            self.assertEqual(result.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        for name, owner in original.items():
            self.assertEqual((self.root / name).stat().st_uid, owner)

    def test_uncertain_file_edit_prevents_a_normal_database_snapshot(self):
        self.connection.execute("UPDATE settings SET value='\"unresolved-journal\"' WHERE key='content_recovery'")
        self.connection.commit()
        with self.assertRaisesRegex(backup.BackupError, "Recover the interrupted"):
            backup.snapshot_database(self.config, self.root / "snapshot.sqlite")


@unittest.skipUnless(LINUX_CAPTURE, "Requires Linux directory FDs and GNU tar")
class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.repo = self.root / "repo"
        self.logs = self.root / "logs"
        for folder in (self.runtime / "scripts", self.runtime / "configs", self.runtime / "sessions", self.runtime / "backups",
                       self.runtime / "locks", self.repo / "node_modules", self.repo / ".git", self.logs):
            folder.mkdir(parents=True, exist_ok=True)
        self.db = self.runtime / "dashboard.sqlite"
        self.connection = sqlite3.connect(self.db)
        self.addCleanup(self.connection.close)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT)")
        self.connection.execute("INSERT INTO jobs VALUES ('permanent-id', 'Committed in WAL')")
        self.connection.commit()
        (self.runtime / "scripts" / "job.py").write_text("print('job')\n")
        (self.runtime / "configs" / "job.env").write_text("TOKEN=private-token\n")
        (self.runtime / "sessions" / "login.json").write_text("session-secret")
        (self.runtime / "locks" / "job.lock").write_text("locked")
        (self.runtime / "backups" / "prior-backup.tar.gz").write_text("do not recurse")
        (self.runtime / "update.request").touch()
        (self.repo / "server.js").write_text("// exact deployed source\n")
        (self.repo / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
        (self.repo / "node_modules" / "dependency.js").touch()
        (self.repo / ".git" / "config").touch()
        (self.logs / "run.log").write_text("completed run\n")
        self.extra = self.root / "private-config"
        self.extra.mkdir()
        (self.extra / "environment").write_text("SESSION_SECRET=private-session-secret\n")
        self.config = {
            "backup_directory": str(self.runtime / "backups" / "pi-dashboard"),
            "runtime_root": str(self.runtime), "script_root": str(self.runtime / "scripts"),
            "config_root": str(self.runtime / "configs"), "log_root": str(self.logs),
            "db_file": str(self.db), "repo_root": str(self.repo),
            "session_dir": str(self.runtime / "sessions"), "lock_root": str(self.runtime / "locks"),
            "extra_paths": [str(self.extra)], "system_paths": [], "service_user": "pi-dashboard", "keep": 7,
        }
        self.now = datetime(2026, 10, 20, 5, tzinfo=timezone.utc)

    def snapshot(self, config, output, **kwargs):
        # The live WAL connection remains open throughout the actual backup.
        with closing(sqlite3.connect(output)) as target:
            self.connection.backup(target)
        os.chmod(output, 0o600)

    def runner(self, args, **kwargs):
        if args[0] == "/usr/bin/crontab":
            return subprocess.CompletedProcess(args, 0, "0 1 * * * enqueue permanent-id\n", "")
        return backup.run_command(args, **kwargs)

    def capture(self, **kwargs):
        return backup.capture_application(self.config, command_runner=self.runner, now=kwargs.pop("now", self.now),
                                          database_snapshot=self.snapshot, **kwargs)

    def test_full_capture_contains_sources_private_config_logs_cron_and_consistent_database(self):
        archive_path = self.capture()
        self.assertEqual(stat.S_IMODE(archive_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(archive_path.parent.stat().st_mode), 0o700)
        self.assertEqual(archive_path.with_name(archive_path.name + ".sha256").read_text(), f"{backup._sha256(archive_path)}  {archive_path.name}\n")
        with tarfile.open(archive_path, "r:gz") as archive:
            names = archive.getnames()
            for source in (self.runtime / "scripts" / "job.py", self.runtime / "configs" / "job.env",
                           self.repo / "server.js", self.logs / "run.log", self.extra / "environment"):
                self.assertIn(str(source).lstrip("/"), names)
            for forbidden in (str(self.db).lstrip("/"), "node_modules", ".git", "sessions", "locks", "prior-backup.tar.gz", "update.request", "-wal", "-shm"):
                self.assertFalse(any(forbidden in name for name in names), forbidden)
            manifest = json.load(archive.extractfile("backup-metadata/manifest.json"))
            self.assertEqual(manifest["database_original_path"], str(self.db))
            self.assertEqual(archive.extractfile("backup-metadata/service-user.crontab").read(), b"0 1 * * * enqueue permanent-id\n")
            restored = self.root / "restored.sqlite"
            restored.write_bytes(archive.extractfile("backup-metadata/dashboard.sqlite").read())
        with closing(sqlite3.connect(restored)) as connection:
            self.assertEqual(connection.execute("SELECT name FROM jobs").fetchone()[0], "Committed in WAL")
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_failed_archive_preserves_previous_backups_and_removes_own_partials(self):
        original = self.capture()
        original_hash = backup._sha256(original)
        def fail_tar(args, **kwargs):
            if args[0] == "/usr/bin/tar":
                raise backup.BackupError("Disk full")
            return self.runner(args, **kwargs)
        with self.assertRaisesRegex(backup.BackupError, "Disk full"):
            backup.capture_application(self.config, command_runner=fail_tar, now=self.now, database_snapshot=self.snapshot)
        self.assertEqual(backup._sha256(original), original_hash)
        self.assertEqual(list(original.parent.glob(".partial-*")), [])

    def test_retention_keeps_last_seven_and_preserves_unrelated_and_unverified_files(self):
        results = [self.capture(now=self.now + timedelta(weeks=index)) for index in range(7)]
        directory = results[0].parent
        unrelated = directory / "family-photo.tar.gz"
        unrelated.write_text("unrelated")
        invalid = directory / "pi-script-dashboard-20200101T000000Z-0123456789ab.tar.gz"
        invalid.write_text("not a verified backup")
        last = self.capture(now=self.now + timedelta(weeks=7))
        self.assertFalse(results[0].exists())
        self.assertFalse(results[0].with_name(results[0].name + ".sha256").exists())
        self.assertTrue(all(path.exists() for path in results[1:]))
        self.assertTrue(last.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue(invalid.exists())

    def test_symlink_destination_is_rejected_without_writing_to_target(self):
        target = self.root / "target"
        target.mkdir(mode=0o700)
        destination = Path(self.config["backup_directory"])
        destination.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            self.capture()
        self.assertEqual(list(target.iterdir()), [])

    def test_symlink_ancestor_is_rejected(self):
        target = self.root / "target"
        target.mkdir(mode=0o700)
        link = self.root / "link"
        link.symlink_to(target, target_is_directory=True)
        self.config["backup_directory"] = str(link / "destination")
        with self.assertRaises(OSError):
            self.capture()
        self.assertEqual(list(target.iterdir()), [])

    def test_nonprivate_destination_is_rejected(self):
        destination = Path(self.config["backup_directory"])
        destination.mkdir(mode=0o755)
        os.chmod(destination, 0o755)
        with self.assertRaisesRegex(backup.BackupError, "mode 0700"):
            self.capture()

    def test_explicit_missing_sources_fail_before_creating_archive(self):
        self.config["extra_paths"] = [str(self.root / "missing-credential")]
        with self.assertRaisesRegex(backup.BackupError, "Explicit backup source"):
            self.capture()
        self.assertFalse(Path(self.config["backup_directory"]).exists())

    def test_existing_script_symlinks_are_preserved_without_dereferencing(self):
        secret = self.root / "never-follow"
        secret.write_text("not archived as link content")
        link = self.runtime / "scripts" / "outside-link"
        link.symlink_to(secret)
        path = self.capture()
        with tarfile.open(path, "r:gz") as archive:
            member = archive.getmember(str(link).lstrip("/"))
            self.assertTrue(member.issym())
            self.assertNotIn(str(secret).lstrip("/"), archive.getnames())

    def test_pruning_does_not_follow_symlink_archive_or_checksum(self):
        first = self.capture()
        directory = first.parent
        target = self.root / "unrelated-important-data"
        target.write_text("untouched")
        link_name = "pi-script-dashboard-20200101T000000Z-0123456789ab.tar.gz"
        (directory / link_name).symlink_to(target)
        (directory / (link_name + ".sha256")).write_text(f"{backup._sha256(target)}  {link_name}\n")
        checksum_link_name = "pi-script-dashboard-20200101T000000Z-abcdef012345.tar.gz"
        other = directory / checksum_link_name
        other.write_text("unverified archive")
        (directory / (checksum_link_name + ".sha256")).symlink_to(target)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            backup.prune_verified_archives(fd, 1)
        finally:
            os.close(fd)
        self.assertEqual(target.read_text(), "untouched")
        self.assertTrue((directory / link_name).is_symlink())
        self.assertTrue(other.exists())

    def test_crontab_failure_prevents_publication(self):
        def failed_cron(args, **kwargs):
            if args[0] == "/usr/bin/crontab":
                return subprocess.CompletedProcess(args, 1, "", "permission denied")
            return self.runner(args, **kwargs)
        with self.assertRaisesRegex(backup.BackupError, "Cannot read"):
            backup.capture_application(self.config, command_runner=failed_cron, now=self.now, database_snapshot=self.snapshot)
        self.assertEqual(list(Path(self.config["backup_directory"]).iterdir()), [])

    def test_no_crontab_is_a_valid_empty_snapshot(self):
        def no_cron(args, **kwargs):
            if args[0] == "/usr/bin/crontab":
                return subprocess.CompletedProcess(args, 1, "", "no crontab for pi-dashboard\n")
            return self.runner(args, **kwargs)
        path = backup.capture_application(self.config, command_runner=no_cron, now=self.now, database_snapshot=self.snapshot)
        with tarfile.open(path, "r:gz") as archive:
            self.assertEqual(archive.extractfile("backup-metadata/service-user.crontab").read(), b"")


if __name__ == "__main__":
    unittest.main()
