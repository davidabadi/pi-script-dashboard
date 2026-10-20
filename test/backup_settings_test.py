"""Configuration checks for the independent root backup helpers."""

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
import backup_settings as settings

TEST_ROOT = Path(__file__).resolve().parents[1] / ".runtime" / "backup-settings-tests"
TEST_ROOT.mkdir(parents=True, exist_ok=True)


class BackupSettingsTests(unittest.TestCase):
    def setUp(self):
        self.value = {
            "backup_directory": "/var/lib/pi-script-dashboard/backups/pi-dashboard",
            "mail": {"to": "owner@example.com", "from": "pi@example.com"},
        }

    def load(self, value=None, **kwargs):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as folder:
            config = Path(folder) / "backup.json"
            config.write_text(json.dumps(self.value if value is None else value), encoding="utf-8")
            return settings.load_settings(config, require_root=False, **kwargs)

    def test_defaults_and_custom_runtime(self):
        value = self.load()
        self.assertEqual(value["keep"], 7)
        self.assertEqual(value["backup_directory"], "/var/lib/pi-script-dashboard/backups/pi-dashboard")
        self.assertEqual(value["drain_timeout_seconds"], 3600)
        self.assertEqual(value["db_file"], "/var/lib/pi-script-dashboard/dashboard.sqlite")
        self.assertEqual(value["mail"]["sendmail_path"], "/usr/sbin/sendmail")
        self.value["runtime_root"] = "/srv/dashboard"
        self.assertEqual(self.load()["script_root"], "/srv/dashboard/scripts")

    def test_all_required_backup_paths_must_be_absolute_linux_paths(self):
        for key in ("backup_directory", "runtime_root", "script_root", "config_root", "log_root", "db_file", "repo_root"):
            for bad in ("relative", "/", "//server/share", "/mnt/../etc", "C:\\backup", "/mnt/usb\nnext"):
                with self.subTest(key=key, path=bad):
                    value = copy.deepcopy(self.value)
                    value[key] = bad
                    with self.assertRaises(settings.SettingsError):
                        self.load(value)

    def test_local_mail_may_use_preconfigured_sender(self):
        del self.value["mail"]["from"]
        self.assertNotIn("from", self.load()["mail"])
        self.assertEqual(self.load()["mail"]["transport"], "auto")

    def test_no_header_injection_or_multiple_addresses(self):
        for field in ("to", "from"):
            for bad in ("a@example.com\r\nBcc: attacker@example.com", "two@example.com,three@example.com", "Name <owner@example.com>", "a@example.com\x00", ""):
                with self.subTest(field=field, value=bad):
                    value = copy.deepcopy(self.value)
                    value["mail"][field] = bad
                    with self.assertRaises(settings.SettingsError):
                        self.load(value)

    def test_notification_works_with_invalid_or_absent_backup_settings(self):
        value = {"backup_directory": "not-safe", "keep": -1, "mail": self.value["mail"]}
        self.assertEqual(self.load(value, notification_only=True)["mail"]["to"], "owner@example.com")
        with self.assertRaises(settings.SettingsError):
            self.load(value)

    def test_keep_timeout_service_and_extra_validation(self):
        for key, bad in (("keep", 0), ("keep", True), ("keep", "7"), ("drain_timeout_seconds", -1), ("service_user", "root;id"), ("extra_paths", ["/etc", "relative"])):
            with self.subTest(key=key, value=bad):
                value = copy.deepcopy(self.value)
                value[key] = bad
                with self.assertRaises(settings.SettingsError):
                    self.load(value)
        self.value["extra_paths"] = ["/etc/cloudflared", "/etc/cloudflared"]
        self.assertEqual(self.load()["extra_paths"], ["/etc/cloudflared"])

    def test_smtp_tls_defaults_and_credentials_must_come_together(self):
        self.value["mail"].update(transport="smtp", smtp_host="smtp.example.com")
        mail = self.load()["mail"]
        self.assertEqual((mail["smtp_security"], mail["smtp_port"]), ("starttls", 587))
        self.value["mail"]["smtp_security"] = "tls"
        self.assertEqual(self.load()["mail"]["smtp_port"], 465)
        self.value["mail"]["smtp_security"] = "none"
        with self.assertRaises(settings.SettingsError):
            self.load()
        self.value["mail"]["smtp_security"] = "starttls"
        self.value["mail"]["smtp_username"] = "user"
        with self.assertRaises(settings.SettingsError):
            self.load()
        self.value["mail"]["smtp_password_file"] = "/etc/pi-script-dashboard/backup-smtp-password"
        self.assertEqual(self.load()["mail"]["smtp_username"], "user")

    def test_malformed_json_and_oversized_config_errors_do_not_echo_content(self):
        for data in (b'{"secret": password}', b"\xff", b"x" * 65537):
            with self.subTest(length=len(data)), tempfile.TemporaryDirectory(dir=TEST_ROOT) as folder:
                config = Path(folder) / "backup.json"
                config.write_bytes(data)
                with self.assertRaises(settings.SettingsError) as raised:
                    settings.load_settings(config, require_root=False)
                self.assertNotIn("password", str(raised.exception))

    def test_configuration_does_not_accept_symlinks(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as folder:
            original = Path(folder) / "private.json"
            link = Path(folder) / "backup.json"
            original.write_text("{}", encoding="utf-8")
            try:
                link.symlink_to(original)
            except (OSError, NotImplementedError):
                self.skipTest("Symlink creation unavailable")
            with self.assertRaises(settings.SettingsError):
                settings.load_settings(link, require_root=False)

    def test_root_ownership_and_mode_are_enforced(self):
        fake_stat = type("Info", (), {"st_uid": 1000, "st_mode": 0o100600, "st_dev": 1, "st_ino": 1})()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as folder:
            file_path = Path(folder) / "private.json"
            file_path.write_text("{}", encoding="utf-8")
            with patch.object(settings.Path, "parents", new_callable=lambda: property(lambda item: ())):
                with patch.object(settings.os, "fstat", return_value=fake_stat), patch.object(settings.Path, "lstat", return_value=fake_stat):
                    with self.assertRaisesRegex(settings.SettingsError, "owned by root"):
                        settings.read_private_file(file_path)
                    fake_stat.st_uid = 0
                    fake_stat.st_mode = 0o100644
                    with self.assertRaisesRegex(settings.SettingsError, "mode 0600"):
                        settings.read_private_file(file_path)


if __name__ == "__main__":
    unittest.main()
