"""Service quiescence and recovery for full application backups, without email."""

from contextlib import nullcontext, redirect_stderr, redirect_stdout
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "pi-script-dashboard-backup"
SPEC = importlib.util.spec_from_loader("backup_service", SourceFileLoader("backup_service", str(SCRIPT)))
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class Host:
    def __init__(self, *, draining=False, inactive=(), fail=None):
        self.active = {unit: unit not in inactive for unit in (service.WEB, service.WORKER, service.WATCHER)}
        self.draining = draining
        self.fail = fail
        self.events = []
        self.config = {"service_user": "pi-dashboard", "repo_root": "/opt/pi-script-dashboard",
                       "db_file": "/var/lib/pi-script-dashboard/dashboard.sqlite", "drain_timeout_seconds": 3600}

    def runner(self, args, **kwargs):
        self.events.append(tuple(args))
        if args[0].endswith("systemctl"):
            action, *units = args[1:]
            if action == "is-active":
                return subprocess.CompletedProcess(args, 0 if self.active[units[-1]] else 3, "", "")
            for unit in units:
                if self.fail == (action, unit):
                    return subprocess.CompletedProcess(args, 1, "", "private details must not escape")
                self.active[unit] = action == "start"
        else:
            action = args[-1]
            if self.fail == action:
                return subprocess.CompletedProcess(args, 1, "", "private details must not escape")
            if action in ("drain", "resume"):
                self.draining = action == "drain"
        return subprocess.CompletedProcess(args, 0, json.dumps({"draining": self.draining, "running": 0}), "")

    def controller(self, capture=None):
        return service.ApplicationBackup(self.config, runner=self.runner, validate=lambda value: value,
                                         capture=capture or (lambda value: Path("/backup/full.tar.gz")))

    def actions(self):
        return [event[-1] for event in self.events if event[0].endswith("runuser")]


class BackupServiceTests(unittest.TestCase):
    def test_capture_waits_for_jobs_then_restores_original_services_and_drain_state(self):
        host = Host()
        def capture(config):
            self.assertFalse(any(host.active.values()))
            self.assertTrue(host.draining)
            host.events.append(("capture",))
            return Path("/backup/full.tar.gz")
        result = host.controller(capture).run()
        self.assertEqual(result, Path("/backup/full.tar.gz"))
        self.assertEqual(host.actions(), ["status", "drain", "wait-idle", "resume"])
        self.assertTrue(all(host.active.values()))
        self.assertFalse(host.draining)
        for event in host.events:
            if event[0].endswith("runuser"):
                self.assertNotIn("root", event)

    def test_failed_capture_restores_services_and_does_not_swallow_failure(self):
        host = Host()
        def capture(config):
            raise RuntimeError("Archive verification failed")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            host.controller(capture).run()
        self.assertTrue(all(host.active.values()))
        self.assertFalse(host.draining)

    def test_preexisting_drain_and_stopped_web_are_preserved(self):
        host = Host(draining=True, inactive=(service.WEB,))
        host.controller().run()
        self.assertTrue(host.draining)
        self.assertFalse(host.active[service.WEB])
        self.assertTrue(host.active[service.WORKER])
        self.assertNotIn("resume", host.actions())

    def test_inactive_worker_is_not_started_by_backup(self):
        host = Host(inactive=(service.WEB, service.WORKER, service.WATCHER))
        host.controller().run()
        self.assertFalse(any(host.active.values()))
        self.assertEqual(host.actions(), ["status"])

    def test_drain_timeout_does_not_stop_active_jobs(self):
        host = Host(fail="wait-idle")
        with self.assertRaises(service.BackupError):
            host.controller().run()
        self.assertTrue(all(host.active.values()))
        self.assertFalse(host.draining)
        self.assertFalse(any(event[1:3] == ("stop", service.WEB) for event in host.events))

    def test_partial_stop_failure_still_restores_every_previously_active_unit(self):
        host = Host(fail=("stop", service.WORKER))
        with self.assertRaises(service.BackupError):
            host.controller().run()
        self.assertTrue(all(host.active.values()))
        self.assertFalse(host.draining)

    def test_restart_failure_is_reported_after_attempting_other_service_recovery(self):
        host = Host(fail=("start", service.WORKER))
        with self.assertRaisesRegex(service.BackupError, "service recovery failed"):
            host.controller().run()
        self.assertTrue(host.active[service.WEB])
        self.assertTrue(host.active[service.WATCHER])

    def test_updater_capture_requires_stopped_services_and_preserves_its_drain(self):
        host = Host(draining=True, inactive=(service.WEB, service.WORKER))
        host.controller().run(already_stopped=True)
        self.assertTrue(host.draining)
        self.assertEqual(host.actions(), ["status"])
        with self.assertRaisesRegex(service.BackupError, "stop web and worker"):
            Host().controller().run(already_stopped=True)

    def test_updater_mode_rejects_undrained_state(self):
        host = Host(inactive=(service.WEB, service.WORKER))
        with self.assertRaisesRegex(service.BackupError, "finish draining"):
            host.controller().run(already_stopped=True)

    def test_commands_close_inherited_privileged_descriptors_and_sanitize_errors(self):
        arguments = []
        def runner(args, **kwargs):
            arguments.append(kwargs)
            return subprocess.CompletedProcess(args, 1, "secret", "secret-password")
        controller = service.ApplicationBackup({}, runner=runner)
        with self.assertRaises(service.BackupError) as problem:
            controller.command(["/usr/bin/false"])
        self.assertTrue(arguments[0]["close_fds"])
        self.assertEqual(set(arguments[0]["env"]), {"PATH", "LC_ALL", "LANG"})
        self.assertNotIn("secret", str(problem.exception))


class BackupCliTests(unittest.TestCase):
    def test_notification_does_not_read_application_data_or_take_maintenance_lock(self):
        with patch.object(service, "root_environment", return_value=True), \
             patch.object(service, "load_settings", return_value={"mail": {}}) as settings, \
             patch.object(service, "send_failure_email") as mail, \
             patch.object(service, "maintenance_lock") as lock, redirect_stdout(io.StringIO()):
            self.assertEqual(service.main(["--notify-failure"]), 0)
            settings.assert_called_once_with(service.CONFIG, notification_only=True)
            mail.assert_called_once()
            lock.assert_not_called()

    def test_direct_updater_failure_submits_one_sanitized_alert(self):
        with patch.object(service, "root_environment", return_value=True), \
             patch.object(service, "load_settings", return_value={"drain_timeout_seconds": 1}), \
             patch.object(service, "maintenance_lock", return_value=nullcontext()), \
             patch.object(service, "ApplicationBackup") as controller, \
             patch.object(service, "send_failure_email") as mail, \
             redirect_stderr(io.StringIO()):
            controller.return_value.run.side_effect = RuntimeError("archive error")
            self.assertEqual(service.main(["--already-stopped", "--lock-fd", "9"]), 1)
            mail.assert_called_once()
            self.assertEqual(mail.call_args.kwargs["unit_name"], "pi-script-dashboard-update.service")
            self.assertEqual(mail.call_args.kwargs["summary"], "archive-failed")

    def test_scheduled_failure_leaves_alert_to_systemd_onfailure(self):
        with patch.object(service, "root_environment", return_value=True), \
             patch.object(service, "load_settings", return_value={"drain_timeout_seconds": 1}), \
             patch.object(service, "maintenance_lock", return_value=nullcontext()), \
             patch.object(service, "ApplicationBackup") as controller, \
             patch.object(service, "send_failure_email") as mail, \
             redirect_stderr(io.StringIO()):
            controller.return_value.run.side_effect = RuntimeError("archive error")
            self.assertEqual(service.main([]), 1)
            mail.assert_not_called()


if __name__ == "__main__":
    unittest.main()
