#!/usr/bin/env bash
# Destructive fixtures for an explicitly opted-in, disposable Debian container.
# This exercises packaged PAM/saslauthd and crontab DAC, not systemd namespaces.
set -euo pipefail
export LC_ALL=C

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ "${PI_DASHBOARD_INTEGRATION_TEST:-}" == 1 ]] || fail 'explicit container-test opt-in is required'
[[ -f /.dockerenv ]] || fail 'run only inside a disposable Docker container'
[[ "$(id -u)" == 0 ]] || fail 'container fixtures require root'

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
service_user=pi-dashboard
admin_user=pi-dashboard-it-admin
other_user=pi-dashboard-it-other
expired_user=pi-dashboard-it-expired
pam_profile=/etc/pam.d/pi-script-dashboard
fixture_users=("$service_user" "$admin_user" "$other_user" "$expired_user")

for command in node python3 getent groupadd useradd chpasswd chage runuser crontab setpriv; do
  command -v "$command" >/dev/null || fail "missing prerequisite: $command"
done
[[ -x /usr/sbin/saslauthd ]] || fail 'install sasl2-bin before running the fixture'
[[ -r /etc/pam.d/common-auth && -r /etc/pam.d/common-account ]] || fail 'Debian common PAM profiles are required'

# Refuse collisions before changing accounts, PAM configuration, or cron.
for account in "${fixture_users[@]}"; do
  if getent passwd "$account" >/dev/null; then
    fail "fixture account already exists: $account"
  fi
  if getent group "$account" >/dev/null; then
    fail "fixture group already exists: $account"
  fi
done
if getent group pi-dashboard-admins >/dev/null; then
  fail 'fixture administrator group already exists'
fi
[[ ! -e "$pam_profile" && ! -L "$pam_profile" ]] || fail 'dashboard PAM profile already exists'
if root_cron_probe="$(crontab -u root -l 2>&1)"; then
  fail 'root already has a crontab; refusing to replace it with a fixture'
elif [[ "$root_cron_probe" != *'no crontab for root'* ]]; then
  fail 'could not establish that the root crontab is absent'
fi
unset root_cron_probe

groupadd --system pi-dashboard
groupadd pi-dashboard-admins
useradd --system --gid pi-dashboard --no-create-home --shell /usr/sbin/nologin "$service_user"
useradd --user-group --no-create-home --shell /bin/bash --groups pi-dashboard-admins "$admin_user"
useradd --user-group --no-create-home --shell /bin/bash "$other_user"
useradd --user-group --no-create-home --shell /bin/bash --groups pi-dashboard-admins "$expired_user"

# Synthetic test-only password: never pass passwords to an external command's argv.
fixture_password='PiDashboardFixtureOnly-2026'
for account in "$admin_user" "$other_user" "$expired_user"; do
  printf '%s:%s\n' "$account" "$fixture_password"
done | chpasswd
unset fixture_password
chage --expiredate 1 "$expired_user"
install -o root -g root -m 0644 "$repo_root/deploy/pi-script-dashboard.pam" "$pam_profile"

run_dir="$(mktemp -d /run/pi-dashboard-auth-it.XXXXXXXX)"
chown root:pi-dashboard "$run_dir"
chmod 0750 "$run_dir"
daemon_pid=''

stop_daemon() {
  local recorded_pid daemon_exe daemon_cwd
  [[ -f "$run_dir/saslauthd.pid" ]] || return 0
  IFS= read -r recorded_pid < "$run_dir/saslauthd.pid"
  [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$recorded_pid" -gt 1 ]] || return 1
  if [[ -n "$daemon_pid" && "$recorded_pid" != "$daemon_pid" ]]; then
    printf 'Refusing to stop a daemon with a changed fixture PID.\n' >&2
    return 1
  fi
  if [[ -d "/proc/$recorded_pid" ]]; then
    # Never use killall/pkill or signal a PID without checking fixture identity.
    # /proc links require matching filesystem UID *and GID* without SYS_PTRACE.
    # Match the daemon's root:pi-dashboard credentials in ordinary Docker;
    # retaining these checks must not require adding a container capability.
    if ! daemon_exe="$(runuser -u root -g pi-dashboard -- readlink -f "/proc/$recorded_pid/exe")"; then
      printf 'Refusing to stop fixture daemon: cannot inspect its executable.\n' >&2
      return 1
    fi
    if ! daemon_cwd="$(runuser -u root -g pi-dashboard -- readlink -f "/proc/$recorded_pid/cwd")"; then
      printf 'Refusing to stop fixture daemon: cannot inspect its working directory.\n' >&2
      return 1
    fi
    if [[ "$daemon_exe" != "$(readlink -f /usr/sbin/saslauthd)" || "$daemon_cwd" != "$run_dir" ]]; then
      printf 'Refusing to stop a process whose executable or working directory differs from the fixture.\n' >&2
      return 1
    fi
    kill -TERM "$recorded_pid" || return 1
  fi
  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ ! -S "$run_dir/mux" ]]; then
      daemon_pid=''
      return 0
    fi
    sleep 0.1
  done
  printf 'Fixture daemon did not remove its socket after termination.\n' >&2
  return 1
}

cleanup() {
  if ! stop_daemon; then
    printf 'Could not safely stop the fixture daemon; the disposable container must be discarded.\n' >&2
  fi
}
trap cleanup EXIT

# Debian 12 / Cyrus SASL 2.1.28 daemonizes by default; it has no -f flag.
# The private directory contains only this fixture's PID, socket, and locks.
runuser -u root -g pi-dashboard -- /usr/sbin/saslauthd -a pam -m "$run_dir" -n 2
IFS= read -r daemon_pid < "$run_dir/saslauthd.pid"
[[ "$daemon_pid" =~ ^[1-9][0-9]*$ && "$daemon_pid" -gt 1 ]] || fail 'invalid fixture daemon PID'
for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -S "$run_dir/mux" ]] && break
  sleep 0.1
done
[[ -S "$run_dir/mux" ]] || fail 'authentication socket was not ready within ten seconds'
chown root:pi-dashboard "$run_dir/mux"
chmod 0660 "$run_dir/mux"
if runuser -u "$service_user" -- test -w "$run_dir"; then
  fail 'service user can write the root-owned authentication directory'
fi
printf 'PASS: service user cannot replace the authentication socket\n'

# Load the real application client as the unprivileged account, not as root.
runuser -u "$service_user" -- node - "$repo_root/saslauthd.js" "$run_dir/mux" <<'JS'
"use strict";
const assert = require("node:assert/strict");
const { authenticate, checkSocket } = require(process.argv[2]);
const options = { socketPath: process.argv[3] };
const password = "PiDashboardFixtureOnly-2026";

(async () => {
  assert.equal(process.getuid() === 0, false, "client must be unprivileged");
  assert.equal(checkSocket(options.socketPath), true);
  const cases = [
    ["approved account and correct password", "pi-dashboard-it-admin", password, true],
    ["wrong password rejected", "pi-dashboard-it-admin", `${password}-wrong`, false],
    ["nonadministrator rejected by PAM profile", "pi-dashboard-it-other", password, false],
    ["expired administrator rejected by account management", "pi-dashboard-it-expired", password, false],
    ["oversized UTF-8 password rejected", "pi-dashboard-it-admin", "é".repeat(129), false],
    ["NUL-containing password rejected", "pi-dashboard-it-admin", `${password}\0extra`, false],
  ];
  for (const [label, username, candidate, expected] of cases) {
    assert.equal(await authenticate(username, candidate, options), expected, label);
    console.log(`PASS: ${label}`);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
JS

runuser -u "$other_user" -- node - "$repo_root/saslauthd.js" "$run_dir/mux" <<'JS'
"use strict";
const assert = require("node:assert/strict");
const { authenticate } = require(process.argv[2]);
(async () => {
  assert.equal(await authenticate("pi-dashboard-it-admin", "PiDashboardFixtureOnly-2026", {
    socketPath: process.argv[3], timeoutMs: 1000,
  }), false, "unrelated local account must not access the private socket");
  console.log("PASS: unrelated local account cannot use the authentication socket");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
JS

# Exercise the distribution's setgid helper, retaining a separate root sentinel.
printf '%s\n' '17 3 * * * /bin/true # pi-dashboard-integration-root' | crontab -u root -
root_cron_before="$(crontab -u root -l)"
service_cron='23 4 * * * /bin/true # pi-dashboard-integration-service'
printf '%s\n' "$service_cron" | runuser -u "$service_user" -- crontab -
[[ "$(runuser -u "$service_user" -- crontab -l)" == "$service_cron" ]] || fail 'service-user crontab roundtrip failed'
printf '# %s\n' "$service_cron" | runuser -u "$service_user" -- crontab -
[[ "$(runuser -u "$service_user" -- crontab -l)" == "# $service_cron" ]] || fail 'service-user cron pause failed'
printf '%s\n' "$service_cron" | runuser -u "$service_user" -- crontab -
[[ "$(runuser -u "$service_user" -- crontab -l)" == "$service_cron" ]] || fail 'service-user cron resume failed'
[[ "$(crontab -u root -l)" == "$root_cron_before" ]] || fail 'service-user operations changed root crontab'
printf 'PASS: service-user cron install/pause/resume preserves root crontab\n'

# The updater's systemd sandbox implies NoNewPrivileges. Its cron subprocesses
# need an explicit supplementary group because the packaged setgid transition
# cannot grant spool access under NNP. Do not add that group to the account.
[[ " $(id -nG "$service_user") " != *' crontab '* ]] || fail 'service account unexpectedly has global crontab membership'
if setpriv --no-new-privs runuser -u "$service_user" -g pi-dashboard -- crontab -l >/dev/null 2>&1; then
  fail 'NNP crontab unexpectedly has spool access without the explicit group'
fi
nnp_service_cron="# $service_cron"
printf '%s\n' "$nnp_service_cron" | setpriv --no-new-privs \
  runuser -u "$service_user" -g pi-dashboard -G crontab -- crontab -
[[ "$(setpriv --no-new-privs runuser -u "$service_user" -g pi-dashboard -G crontab -- crontab -l)" == "$nnp_service_cron" ]] || fail 'NNP explicit-group cron roundtrip failed'
if setpriv --no-new-privs runuser -u "$service_user" -g pi-dashboard -G crontab -- crontab -u root -l >/dev/null 2>&1; then
  fail 'NNP explicit-group service user can inspect root crontab'
fi
printf '%s\n' "$service_cron" | setpriv --no-new-privs \
  runuser -u "$service_user" -g pi-dashboard -G crontab -- crontab -
[[ "$(crontab -u root -l)" == "$root_cron_before" ]] || fail 'NNP explicit-group operations changed root crontab'
[[ " $(id -nG "$service_user") " != *' crontab '* ]] || fail 'NNP fixture changed global group membership'
printf 'PASS: NNP updater cron operations work with a subprocess-only group and preserve root cron\n'

# A changed PID file must never turn cleanup into a signal to another process.
expected_daemon_pid="$daemon_pid"
printf '%s\n' "$$" > "$run_dir/saslauthd.pid"
unexpected_cleanup_acceptance=false
if stop_daemon 2>/dev/null; then
  unexpected_cleanup_acceptance=true
fi
printf '%s\n' "$expected_daemon_pid" > "$run_dir/saslauthd.pid"
[[ "$unexpected_cleanup_acceptance" == false ]] || fail 'cleanup accepted a changed fixture PID'
kill -0 "$expected_daemon_pid" || fail 'cleanup stopped the broker while rejecting a changed PID'
printf 'PASS: cleanup rejects a changed PID without stopping the broker\n'

stop_daemon || fail 'could not safely stop the fixture authentication daemon'
runuser -u "$service_user" -- node - "$repo_root/saslauthd.js" "$run_dir/mux" <<'JS'
"use strict";
const assert = require("node:assert/strict");
const { authenticate } = require(process.argv[2]);
(async () => {
  assert.equal(await authenticate("pi-dashboard-it-admin", "PiDashboardFixtureOnly-2026", {
    socketPath: process.argv[3], timeoutMs: 1000,
  }), false, "authentication must fail closed while the broker is stopped");
  console.log("PASS: stopped authentication broker fails closed");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
JS

printf 'Packaged PAM and cron integration passed; systemd sandbox acceptance remains a separate Pi/VM check.\n'
