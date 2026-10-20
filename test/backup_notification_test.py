"""Failure alerts use fake transports only and never expose application data."""

from datetime import datetime, timezone
import email
import io
from pathlib import Path
import ssl
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stderr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
import backup_notification as notification


class BackupNotificationTests(unittest.TestCase):
    def setUp(self):
        self.config = {"mail": {"transport": "sendmail", "to": "owner@example.com", "from": "pi@example.com", "sendmail_path": "/usr/sbin/sendmail"}}
        self.when = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)

    def smtp_config(self, security="starttls", auth=True):
        self.config["mail"].update(transport="smtp", smtp_host="smtp.example.com", smtp_port=587 if security == "starttls" else 465, smtp_security=security)
        if auth:
            self.config["mail"].update(smtp_username="pi-account", smtp_password_file="/etc/pi-script-dashboard/backup-smtp-password")
        return self.config

    def test_sendmail_without_shell_and_bounded_timeout(self):
        runner = Mock()
        with patch.object(notification, "resolve_local_transport", return_value=["/usr/sbin/sendmail", "-t", "-oi"]):
            notification.send_failure_email(self.config, unit_name="pi-script-dashboard-backup.service", summary="destination-unavailable", now=self.when, runner=runner)
        args, kwargs = runner.call_args
        self.assertEqual(args[0], ["/usr/sbin/sendmail", "-t", "-oi"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["timeout"], 30)
        self.assertTrue(kwargs["check"])
        message = email.message_from_bytes(kwargs["input"])
        self.assertEqual(message["To"], "owner@example.com")
        self.assertIn("backup destination is unavailable", message.get_payload(decode=True).decode())
        self.assertIn("journalctl -u pi-script-dashboard-backup.service", message.get_payload(decode=True).decode())

    def test_unknown_summary_is_not_included_in_alert(self):
        message = notification.failure_message(self.config, unit_name="pi-script-dashboard-backup.service", summary="error: password=VERY_SECRET /sensitive/job.log", now=self.when)
        encoded = message.as_string()
        self.assertNotIn("VERY_SECRET", encoded)
        self.assertNotIn("sensitive/job.log", encoded)
        self.assertIn("did not complete successfully", encoded)

    def test_auto_prefers_sendmail_then_msmtp_without_changing_mail_setup(self):
        self.config["mail"].update(transport="auto", msmtp_path="/usr/bin/msmtp")
        del self.config["mail"]["from"]
        for available, expected in (({"/usr/sbin/sendmail", "/usr/bin/msmtp"}, "/usr/sbin/sendmail"), ({"/usr/bin/msmtp"}, "/usr/bin/msmtp")):
            runner = Mock()
            with patch.object(notification.os.path, "isfile", side_effect=lambda path: path in available), patch.object(notification.os, "access", return_value=True):
                notification.send_failure_email(self.config, unit_name="pi-script-dashboard-backup.service", runner=runner)
            self.assertEqual(runner.call_args.args[0][0], expected)
            if expected.endswith("msmtp"):
                self.assertEqual(runner.call_args.args[0], [expected, "-t"])
            self.assertNotIn(b"From:", runner.call_args.kwargs["input"])
        with patch.object(notification.os.path, "isfile", return_value=False):
            with self.assertRaisesRegex(notification.NotificationError, "No local sendmail or msmtp"):
                notification.send_failure_email(self.config, unit_name="pi-script-dashboard-backup.service", runner=Mock())

    def test_preflight_checks_executable_without_sending_or_connecting(self):
        with patch.object(notification.os.path, "isfile", return_value=True), patch.object(notification.os, "access", return_value=True), patch.object(notification.subprocess, "run") as runner, patch.object(notification.smtplib, "SMTP") as smtp:
            self.assertEqual(notification.resolve_local_transport(self.config["mail"]), ["/usr/sbin/sendmail", "-t", "-oi"])
            runner.assert_not_called()
            smtp.assert_not_called()
        with patch.object(notification.os.path, "isfile", return_value=False):
            with self.assertRaisesRegex(notification.NotificationError, "unavailable"):
                notification.resolve_local_transport(self.config["mail"])

    def test_unit_name_header_or_command_injection_is_rejected(self):
        for unit in ("test.service\nBcc: bad@example.com", "test.service;cat /etc/shadow", "../bad.service", "x"):
            with self.subTest(unit=unit), self.assertRaises(notification.NotificationError):
                notification.failure_message(self.config, unit_name=unit, summary="failed")

    def test_delivery_failures_never_echo_transport_errors(self):
        runner = Mock(side_effect=subprocess.CalledProcessError(1, ["sendmail"], stderr=b"password=VERY_SECRET"))
        with patch.object(notification, "resolve_local_transport", return_value=["/usr/sbin/sendmail", "-t", "-oi"]), self.assertRaises(notification.NotificationError) as raised:
            notification.send_failure_email(self.config, unit_name="pi-script-dashboard-backup.service", runner=runner)
        self.assertNotIn("VERY_SECRET", str(raised.exception))

    def test_starttls_verifies_certificates_and_authenticates_only_after_tls(self):
        config = self.smtp_config()
        with patch.object(notification.smtplib, "SMTP") as smtp, patch.object(notification, "read_private_file", return_value=b"VERY_SECRET\n") as private_file:
            client = smtp.return_value
            notification.send_failure_email(config, unit_name="pi-script-dashboard-backup.service")
            smtp.assert_called_once_with("smtp.example.com", 587, timeout=30)
            context = client.starttls.call_args.kwargs["context"]
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            methods = [call[0] for call in client.mock_calls]
            self.assertLess(methods.index("starttls"), methods.index("login"))
            self.assertEqual(client.ehlo.call_count, 2)
            client.login.assert_called_once_with("pi-account", "VERY_SECRET")
            private_file.assert_called_once_with("/etc/pi-script-dashboard/backup-smtp-password", maximum_bytes=4096)
            sent = client.send_message.call_args
            self.assertEqual(sent.kwargs["to_addrs"], ["owner@example.com"])
            self.assertNotIn("VERY_SECRET", sent.args[0].as_string())

    def test_implicit_tls_and_relay_without_authentication(self):
        config = self.smtp_config("tls", auth=False)
        with patch.object(notification.smtplib, "SMTP_SSL") as smtp, patch.object(notification.smtplib, "SMTP") as plain:
            notification.send_failure_email(config, unit_name="pi-script-dashboard-backup.service")
            plain.assert_not_called()
            client = smtp.return_value
            client.starttls.assert_not_called()
            client.login.assert_not_called()
            self.assertTrue(smtp.call_args.kwargs["context"].check_hostname)
            client.send_message.assert_called_once()

    def test_no_auth_or_email_after_starttls_failure(self):
        config = self.smtp_config()
        with patch.object(notification.smtplib, "SMTP") as smtp, patch.object(notification, "read_private_file", return_value=b"VERY_SECRET"):
            smtp.return_value.starttls.side_effect = RuntimeError("VERY_SECRET")
            with self.assertRaises(notification.NotificationError) as raised:
                notification.send_failure_email(config, unit_name="pi-script-dashboard-backup.service")
            self.assertNotIn("VERY_SECRET", str(raised.exception))
            smtp.return_value.login.assert_not_called()
            smtp.return_value.send_message.assert_not_called()

    def test_password_file_permissions_and_format_fail_before_connecting(self):
        config = self.smtp_config()
        for bad in (b"", b"a\nb", b"a\0b"):
            with self.subTest(value=bad), patch.object(notification, "read_private_file", return_value=bad), patch.object(notification.smtplib, "SMTP") as smtp:
                with self.assertRaises(notification.NotificationError):
                    notification.send_failure_email(config, unit_name="pi-script-dashboard-backup.service")
                smtp.assert_not_called()

    def test_cli_loads_notification_only_and_reports_sanitized_error(self):
        with patch.object(notification, "load_settings", return_value=self.config) as load, patch.object(notification, "send_failure_email") as send:
            self.assertEqual(notification.main(["--config", "/etc/pi-script-dashboard/backup.json"]), 0)
            load.assert_called_once_with("/etc/pi-script-dashboard/backup.json", notification_only=True)
            send.assert_called_once()
        output = io.StringIO()
        with patch.object(notification, "load_settings", side_effect=notification.SettingsError("Private configuration could not be read safely.")), redirect_stderr(output):
            self.assertEqual(notification.main([]), 1)
        self.assertNotIn("Traceback", output.getvalue())


if __name__ == "__main__":
    unittest.main()
