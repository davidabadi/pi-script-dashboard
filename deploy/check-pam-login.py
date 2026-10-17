#!/usr/bin/env python3
"""Interactively test the dashboard's PAM broker without passwords on argv."""

import argparse
import getpass
import os
import re
import socket
import struct
import sys
import time
import warnings


def receive_exact(connection, size, deadline):
    result = bytearray()
    while len(result) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        connection.settimeout(remaining)
        chunk = connection.recv(size - len(result))
        if not chunk:
            raise OSError("Incomplete authentication response")
        result.extend(chunk)
    return bytes(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username", help="Linux administrator account to check")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        print("Run this check in an interactive terminal.", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}\$?", args.username) or len(args.username.encode("utf-8")) > 128:
        print("Invalid Linux username.", file=sys.stderr)
        return 2

    try:
        with warnings.catch_warnings():
            # Never permit getpass's fallback to echoed input.
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("Linux password: ").encode("utf-8")
    except getpass.GetPassWarning:
        print("Cannot securely hide password input in this terminal.", file=sys.stderr)
        return 2
    except (EOFError, KeyboardInterrupt):
        print("\nAuthentication check cancelled.", file=sys.stderr)
        return 2
    except UnicodeError:
        print("Password must be valid UTF-8.", file=sys.stderr)
        return 2
    if not 1 <= len(password) <= 256 or b"\0" in password:
        print("Password must be 1-256 UTF-8 bytes without NUL.", file=sys.stderr)
        return 2
    request = bytearray()
    for value in (args.username.encode("utf-8"), password, b"pi-script-dashboard", b""):
        request.extend(struct.pack("!H", len(value)))
        request.extend(value)
    password = None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            deadline = time.monotonic() + 10
            connection.settimeout(10)
            connection.connect(os.environ.get("PAM_SOCKET", "/run/pi-dashboard-auth/mux"))
            connection.sendall(request)
            size = struct.unpack("!H", receive_exact(connection, 2, deadline))[0]
            if not 2 <= size <= 1024:
                raise OSError("Invalid authentication response")
            response = receive_exact(connection, size, deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            connection.settimeout(remaining)
            if connection.recv(1):
                raise OSError("Invalid authentication response")
            if response == b"OK" or (response.startswith(b"OK ") and all(32 <= value < 127 for value in response)):
                print("Authentication succeeded")
                return 0
            print("Authentication failed")
            return 1
    except (OSError, ValueError):
        print("Authentication failed or broker unavailable", file=sys.stderr)
        return 1
    finally:
        request[:] = b"\0" * len(request)


if __name__ == "__main__":
    raise SystemExit(main())
