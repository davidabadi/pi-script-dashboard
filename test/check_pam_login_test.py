"""Password-handling checks for the interactive deployment diagnostic."""

import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import warnings

spec = importlib.util.spec_from_file_location(
    "check_pam_login", Path(__file__).resolve().parents[1] / "deploy" / "check-pam-login.py"
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PasswordPromptTests(unittest.TestCase):
    def run_check(self, prompt, username="pi", interactive=True):
        output = io.StringIO()
        with (
            patch.object(checker.sys, "argv", ["check-pam-login.py", username]),
            patch.object(checker.sys.stdin, "isatty", return_value=interactive),
            patch.object(checker.getpass, "getpass", side_effect=prompt) as getpass,
            patch.object(checker.socket, "socket") as connection,
            contextlib.redirect_stderr(output),
        ):
            result = checker.main()
        connection.assert_not_called()
        return result, output.getvalue(), getpass

    def test_echo_fallback_is_stopped_before_reading_password(self):
        def insecure_prompt(*args):
            warnings.warn("Echo cannot be disabled", checker.getpass.GetPassWarning)
            self.fail("An insecure password prompt must not continue")

        result, message, _ = self.run_check(insecure_prompt)
        self.assertEqual(result, 2)
        self.assertIn("Cannot securely hide", message)

    def test_noninteractive_input_never_prompts(self):
        result, message, prompt = self.run_check(AssertionError, interactive=False)
        self.assertEqual(result, 2)
        self.assertIn("interactive terminal", message)
        prompt.assert_not_called()

    def test_invalid_username_never_prompts(self):
        result, _, prompt = self.run_check(AssertionError, username="../pi")
        self.assertEqual(result, 2)
        prompt.assert_not_called()

    def test_cancellation_has_no_traceback(self):
        for error in (EOFError, KeyboardInterrupt):
            with self.subTest(error=error):
                result, message, _ = self.run_check(error)
                self.assertEqual(result, 2)
                self.assertIn("cancelled", message)
                self.assertNotIn("Traceback", message)

    def test_byte_limit_and_nul_are_rejected_before_connecting(self):
        for value in ("", "p" * 257, "é" * 129, "p\0word"):
            with self.subTest(length=len(value)):
                result, _, _ = self.run_check(lambda *args: value)
                self.assertEqual(result, 2)


if __name__ == "__main__":
    unittest.main()
