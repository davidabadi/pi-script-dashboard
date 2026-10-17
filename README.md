# Pi Script Dashboard

This repository contains a hardened web console for running and scheduling maintenance scripts on a Raspberry Pi. The dashboard is intentionally designed as a private administration service:

- the Node process listens only on `127.0.0.1:8080`;
- Cloudflare Tunnel publishes that loopback service;
- Cloudflare Access with MFA is the first authentication gate;
- a dedicated PAM authentication broker plus membership in `pi-dashboard-admins` is the second gate;
- editable jobs run as the unprivileged `pi-dashboard` account;
- scripts, configs, logs, locks, sessions, and runtime metadata are confined to dedicated directories.

This README is the complete upgrade and deployment runbook. Read it once before running commands. Do not skip a red-flag check: each one is a stop condition until understood and resolved.

## 1. Scope and assumptions

This runbook assumes:

- Raspberry Pi OS or another Debian-based 64-bit Linux distribution using `systemd`;
- an ARM64 Raspberry Pi (`dpkg --print-architecture` returns `arm64`);
- SSH access through an account with `sudo` privileges;
- the existing repository is `https://github.com/davidabadi/pi-script-dashboard.git`;
- the production checkout will be `/opt/pi-script-dashboard`;
- the public hostname is managed in Cloudflare DNS;
- a named Cloudflare Tunnel already exists or will be created during this deployment;
- the administrator performing the deployment has a separate private file share or encrypted document store.

Commands marked **workstation** run on your Windows administration computer. Commands marked **Pi** run over SSH on the Raspberry Pi.

Do not put any of the following in Git, GitHub issues, screenshots, chat messages, or this README:

- the generated `SESSION_SECRET`;
- Cloudflare tunnel tokens, API tokens, account certificates, or credential JSON;
- PAM passwords;
- SSH private keys;
- backup configuration contents, database passwords, or remote server credentials;
- unredacted logs containing credentials.

## 2. Create the private deployment record outside Git

The repository contains a non-secret template at `deploy/private-deployment-values.example`. The real copy must live on the private file share, outside this repository.

### 2.1 Create the private record from Windows

Run in PowerShell on the **workstation**. Replace the UNC path with the real private share:

```powershell
$Repo = "C:\Users\david\Repos\pi-script-dashboard"
$PrivateShareRoot = "\\PRIVATE-SERVER\PrivateShare\Infrastructure\pi-script-dashboard"
$PrivateFile = Join-Path $PrivateShareRoot "private-deployment-values.env"

New-Item -ItemType Directory -Path $PrivateShareRoot -Force | Out-Null
Copy-Item "$Repo\deploy\private-deployment-values.example" $PrivateFile

$repoResolved = (Resolve-Path $Repo).Path
$privateResolved = (Resolve-Path $PrivateFile).Path
if ($privateResolved.StartsWith($repoResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: the private file is inside the Git repository"
}

icacls $PrivateFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
notepad $PrivateFile
```

What to expect:

- `New-Item` and `Copy-Item` normally print nothing.
- `icacls` should report that one file was successfully processed.
- Notepad should open the copied template. Fill in the hostname, Pi SSH name, admin username, Cloudflare IDs, authorized Access email addresses, and private backup destination.

Red flags — stop here if:

- `$PrivateFile` resolves anywhere beneath the repository;
- the private share is readable by broad groups such as `Everyone`, `Domain Users`, or unauthenticated guests;
- `icacls` fails or the share ignores the restrictive ACL;
- you are tempted to put PAM passwords or SSH private keys in an unencrypted text file. Store those in a password manager or encrypted vault instead.

Confirm Git cannot see the private record:

```powershell
git -C $Repo status --short
git -C $Repo check-ignore -v deployment-private.env
git -C $Repo check-ignore -v private-deployment-values.env
```

What to expect:

- `git status` must not list the private-share file.
- The two `check-ignore` commands should show matching rules from `.gitignore` when those filenames are tested inside the repository.

Red flag: if a real secrets file appears in `git status`, move it outside the repository immediately. If it was ever committed, rotating the affected secrets is required; deleting the file in a later commit is not sufficient.

### 2.2 Private record handling rules

Keep the private record open while following this runbook, but do not copy its contents into shell history. Use its values to replace placeholders such as `dashboard.example.com` and `pi`.

The production application secret will be generated directly into `/etc/pi-script-dashboard/environment`. It does not need long-term backup: generating a new value during recovery only signs out existing sessions. Cloudflare credential JSON and backup configurations do require protected backup because they authorize external access.

### 2.3 Publish and record the release before touching the Pi

The Pi clones from GitHub, so local changes that are not reviewed, committed, and pushed cannot be deployed. Run on the **workstation**:

```powershell
$Repo = "C:\Users\david\Repos\pi-script-dashboard"
git -C $Repo status --short
git -C $Repo diff --check
git -C $Repo diff --stat
git -C $Repo log -1 --oneline
```

What to expect before publication:

- `status --short` lists only the intentional security/deployment changes described in this README.
- `diff --check` prints nothing.
- `diff --stat` gives a plausible summary rather than unexpected binaries or secret files.

Review the complete diff, commit it through your normal reviewed workflow, and push or merge it to `main`. Afterward:

```powershell
git -C $Repo fetch origin
$LocalCommit = git -C $Repo rev-parse HEAD
$RemoteCommit = git -C $Repo rev-parse origin/main
"Local:  $LocalCommit"
"Remote: $RemoteCommit"
if ($LocalCommit -ne $RemoteCommit) {
    throw "STOP: the reviewed local commit is not the commit on origin/main"
}
```

Record `$RemoteCommit` as `EXPECTED_DEPLOY_COMMIT` in the private deployment record.

Red flags — do not start the Pi migration if:

- the security changes are still uncommitted;
- CI tests, CodeQL, or the production dependency audit fail;
- `origin/main` does not equal the reviewed release commit;
- Git status includes `.env`, credentials, private keys, runtime state, or the real private deployment record.

## 3. Start a safe maintenance session

Open two independent SSH sessions to the **Pi** before changing networking or services. Keep the second session idle as a recovery console.

From two workstation terminals:

```powershell
ssh pi@raspberrypi.local
```

Substitute the `PI_ADMIN_USER` and `PI_HOSTNAME` values from the private record.

In the first **Pi** session, start a persistent terminal multiplexer:

```bash
sudo apt-get update
sudo apt-get install -y tmux
tmux new -s dashboard-upgrade
```

What to expect:

- `apt-get update` should finish without repository signature or DNS errors.
- `tmux` opens a new full-screen shell. If SSH disconnects, reconnect and run `tmux attach -t dashboard-upgrade`.

Red flags — do not continue if:

- package repositories report invalid signatures;
- the filesystem is read-only;
- SSH is unstable;
- `sudo` does not work;
- the Pi clock is significantly wrong, because TLS, npm, GitHub, and Cloudflare authentication depend on correct time.

## 4. Preflight the Pi

Run on the **Pi**:

```bash
set -o errexit
set -o nounset
set -o pipefail

echo "=== OS ==="
cat /etc/os-release
echo "=== Kernel and architecture ==="
uname -a
dpkg --print-architecture
echo "=== Init system ==="
systemctl --version | head -n 1
echo "=== Clock ==="
timedatectl status
echo "=== Disk ==="
df -h / /opt /var 2>/dev/null || df -h /
echo "=== Memory ==="
free -h
echo "=== Existing listeners on 8080 ==="
sudo ss -ltnp '( sport = :8080 )' || true
echo "=== Existing dashboard processes ==="
ps -ef | grep -E '[n]ode .*pi-script-dashboard|[c]loudflared' || true
echo "=== Existing dashboard units ==="
systemctl list-unit-files | grep -Ei 'dashboard|cloudflared' || true
```

What to expect:

- OS: a supported Debian/Raspberry Pi OS release.
- Architecture: `arm64`.
- Init: a recent `systemd` version.
- Clock: `System clock synchronized: yes` and `NTP service: active`.
- Disk: at least 1 GB free on `/`, `/opt`, and `/var` is a comfortable minimum.
- Port 8080 may show the old dashboard. Record its process and binding address.
- Existing units may show an old dashboard service and `cloudflared.service`.

Red flags — stop if:

- architecture is `armhf`, `armel`, or another 32-bit platform; migrate the Pi to a 64-bit OS before this deployment;
- the system is not using `systemd`;
- NTP is inactive or the clock is wrong;
- any relevant filesystem is above 90% usage;
- an unidentified process owns port 8080;
- the old dashboard has no known service definition or restart procedure. Find and document it before proceeding.

Save a concise preflight record in the private runbook: OS version, architecture, current dashboard service name, current checkout path, and current Git commit.

Set the old unit name and checkout path from that record. Older installations use `script-dashboard.service`; change this value if your preflight found another name:

```bash
OLD_DASHBOARD_SERVICE="script-dashboard.service"
OLD_REPO="/home/pi/pi-script-dashboard"
git -C "$OLD_REPO" rev-parse HEAD
git -C "$OLD_REPO" status --short
```

Keep local changes such as a modified `scripts.json` intact. A fresh checkout under `/opt` will be used for the replacement.

## 5. Create an off-device rollback backup

The backup contains scripts and configuration secrets. It must end up on the private file share, not in Git.

On the **Pi**, create a timestamped staging directory:

```bash
MIGRATION_ID="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="/root/pi-script-dashboard-backup-${MIGRATION_ID}"
sudo install -d -o root -g root -m 0700 "$BACKUP_ROOT"
echo "$MIGRATION_ID"
echo "$BACKUP_ROOT"
```

What to expect: two paths containing the same UTC timestamp.

Capture the current deployment. Missing optional paths are acceptable; unexpected permission errors are not:

```bash
sudo sh -c "crontab -l > '$BACKUP_ROOT/root-crontab.txt' 2>&1 || true"
sudo sh -c "systemctl cat '$OLD_DASHBOARD_SERVICE' > '$BACKUP_ROOT/old-service.txt'"
for unit in "$OLD_DASHBOARD_SERVICE" cloudflared.service; do
  while IFS= read -r source; do
    if [ -n "$source" ]; then
      sudo sh -c 'cd /; cp -a --parents -- "$1" "$2"' sh "$source" "$BACKUP_ROOT"
    fi
  done < <(systemctl show "$unit" -p FragmentPath -p DropInPaths --value | tr ' ' '\n')
done
sudo sh -c "ss -ltnp > '$BACKUP_ROOT/listeners.txt'"
sudo sh -c "ps -ef > '$BACKUP_ROOT/processes.txt'"

for source in \
  "$OLD_REPO" \
  /opt/pi-script-dashboard \
  /usr/local/bin/backup_unraid.sh \
  /usr/local/bin/backup_unraid_postgresql_db.sh \
  /usr/local/bin/backup_forge_server.sh \
  /usr/local/bin/update_and_reboot.sh \
  /home/pi/backup-configs \
  /var/log/custom \
  /etc/crontab \
  /etc/cron.d \
  /etc/cloudflared \
  /home/pi/.cloudflared \
  /root/.cloudflared; do
  if sudo test -e "$source"; then
    sudo sh -c 'cd /; cp -a --parents -- "$1" "$2"' sh "$source" "$BACKUP_ROOT"
  else
    echo "Not present: $source"
  fi
done

sudo tar --acls --xattrs -C /root -czf "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz" "$(basename "$BACKUP_ROOT")"
sudo sha256sum "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz" | sudo tee "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz.sha256"
sudo ls -lh "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz"*
```

What to expect:

- The loop says `Not present` only for genuinely unused paths.
- The archive should normally be larger than a few kilobytes.
- `sha256sum` prints a 64-character checksum followed by the archive path.

The `cd /` in the copy command avoids a `cp --parents` path-resolution bug on Debian 12. If your modified registry uses other script/config paths, include those actual files as well. Back up the old unit's source file and drop-ins, both `root` and administrator crontabs, tunnel configuration/credentials, and any job SSH keys in the same private archive before changing them.

Red flags — stop if:

- all script/config paths are reported missing;
- the archive is unexpectedly tiny;
- `tar`, `cp`, or `sha256sum` reports an error;
- the current root crontab cannot be captured and you know jobs are scheduled there.

Prepare temporary admin-owned copies on the **Pi** so SCP does not require root login:

```bash
sudo install -o "$(id -un)" -g "$(id -gn)" -m 0600 "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz" "/home/$(id -un)/"
sudo install -o "$(id -un)" -g "$(id -gn)" -m 0600 "/root/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz.sha256" "/home/$(id -un)/"
```

From the **workstation**, pull both files directly into the private share:

```powershell
$MigrationId = "REPLACE_WITH_MIGRATION_ID_PRINTED_BY_THE_PI"
$PrivateShareRoot = "\\PRIVATE-SERVER\PrivateShare\Infrastructure\pi-script-dashboard"
scp "pi@raspberrypi.local:pi-script-dashboard-backup-$MigrationId.tar.gz*" $PrivateShareRoot
Get-ChildItem "$PrivateShareRoot\pi-script-dashboard-backup-$MigrationId.tar.gz*"
```

After the workstation copy succeeds, verify its checksum on Windows:

```powershell
$Archive = Join-Path $PrivateShareRoot "pi-script-dashboard-backup-$MigrationId.tar.gz"
Get-FileHash -Algorithm SHA256 $Archive
Get-Content "$Archive.sha256"
```

What to expect: both SHA-256 values are identical, ignoring letter case.

Red flags — stop if the values differ, the file share copy is incomplete, or the private archive is broadly readable.

Remove only the temporary admin-home copies after verification; retain the root copy until the migration is accepted:

```bash
rm -f "/home/$(id -un)/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz" "/home/$(id -un)/pi-script-dashboard-backup-${MIGRATION_ID}.tar.gz.sha256"
```

## 6. Record how to stop and restore the old dashboard

On the **Pi**, inspect the unit before stopping it:

```bash
sudo systemctl status "$OLD_DASHBOARD_SERVICE" --no-pager || true
sudo systemctl cat "$OLD_DASHBOARD_SERVICE"
```

Keep this service running during preparation. Step 16 stops it and verifies port 8080 is free before starting the replacement. Stop preparation if you cannot identify how to restore the old service. If the old and new units have the same name, preserve the old unit and its drop-ins before Step 12 replaces them; do not restart it during preparation.

Do not delete the old checkout, old unit, root crontab, scripts, or configs yet.

## 7. Install operating-system prerequisites

Run on the **Pi**:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  cron \
  curl \
  git \
  logrotate \
  openssl \
  python3 \
  sasl2-bin \
  xz-utils
```

What to expect: packages install successfully and `apt-get` exits with status 0.

Verify:

```bash
git --version
curl --version | head -n 1
openssl version
python3 --version
dpkg-query -W sasl2-bin cron logrotate
```

Red flags — stop if package signatures fail, the system proposes removing core packages, or `sasl2-bin` cannot be installed. The application uses a Unix socket client and no longer needs a native Node PAM addon or PAM development headers. The packaged `saslauthd` binary runs in the dedicated unit installed in Step 12; do not enable a separate, globally configured `saslauthd.service` for this dashboard.

## 8. Install checksum-verified Node.js 24

The shipped service uses `/usr/local/bin/node`. This procedure downloads the current Node 24 LTS archive from `nodejs.org`, verifies it against the official SHA-256 manifest, and installs it under `/opt`. Use its versioned directory during preparation; switch the stable symlinks only after the old service is stopped in Step 16.

Run on the **Pi**:

```bash
case "$(dpkg --print-architecture)" in
  arm64) NODE_ARCH="linux-arm64" ;;
  amd64) NODE_ARCH="linux-x64" ;;
  *) echo "STOP: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

NODE_WORK="$(mktemp -d)"
cd "$NODE_WORK"
curl --fail --silent --show-error --location --remote-name \
  https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt

NODE_ARCHIVE="$(awk -v arch="$NODE_ARCH" '$2 ~ ("node-v24.*-" arch "\\.tar\\.xz$") { print $2 }' SHASUMS256.txt | tail -n 1)"
test -n "$NODE_ARCHIVE"
echo "$NODE_ARCHIVE"

curl --fail --silent --show-error --location --remote-name \
  "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE"
grep " $NODE_ARCHIVE$" SHASUMS256.txt | sha256sum --check --strict -

NODE_DIR="${NODE_ARCHIVE%.tar.xz}"
sudo tar -xJf "$NODE_ARCHIVE" -C /opt
NODE_BIN_DIR="/opt/$NODE_DIR/bin"

"$NODE_BIN_DIR/node" --version
env PATH="$NODE_BIN_DIR:/usr/bin:/bin" "$NODE_BIN_DIR/npm" --version
readlink -f "$NODE_BIN_DIR/node"
```

What to expect:

- The archive name resembles `node-v24.x.y-linux-arm64.tar.xz`.
- Checksum verification prints `OK`.
- The versioned `node --version` starts with `v24.`; the old service's Node installation is unchanged during preparation.
- `readlink` resolves beneath `/opt/node-v24...`.

Red flags — stop if:

- `NODE_ARCHIVE` is empty;
- download TLS validation fails;
- checksum verification is anything other than `OK`;
- Node reports a non-v24 release;
- `node` or `npm` resolves into a user home directory.

Clean up the download only after verification:

```bash
cd /
rm -rf -- "$NODE_WORK"
```

The target is the unique `mktemp` directory printed into `NODE_WORK`; never replace that command with a broad path.

Record `NODE_BIN_DIR` in the private deployment record so it can be restored after reconnecting SSH.

## 9. Create the service and administrator groups

Set the existing Linux user who should be allowed to sign in. Replace `pi` if needed:

```bash
ADMIN_USER="pi"
```

Create the accounts idempotently:

```bash
getent group pi-dashboard >/dev/null || sudo groupadd --system pi-dashboard
getent group pi-dashboard-admins >/dev/null || sudo groupadd pi-dashboard-admins
id pi-dashboard >/dev/null 2>&1 || sudo useradd \
  --system \
  --gid pi-dashboard \
  --home-dir /var/lib/pi-script-dashboard \
  --create-home \
  --shell /usr/sbin/nologin \
  pi-dashboard

sudo usermod --append --groups pi-dashboard-admins "$ADMIN_USER"
getent passwd pi-dashboard
getent group pi-dashboard-admins
id "$ADMIN_USER"
sudo passwd --status "$ADMIN_USER"
```

What to expect:

- `pi-dashboard` uses `/usr/sbin/nologin`.
- `getent group pi-dashboard-admins` lists only intended dashboard administrators.
- `id "$ADMIN_USER"` includes `pi-dashboard-admins`.
- `passwd --status` normally shows `P`, meaning the PAM user has a usable password.

Red flags — stop if:

- `pi-dashboard` has an interactive shell;
- unintended users are members of `pi-dashboard-admins`;
- the admin account is locked (`L`) or has no usable password;
- the service account itself is added to `pi-dashboard-admins`.

Group membership is evaluated by the application with `id -nG`. An already-open shell does not need the new group for PAM authorization, but confirm the system database sees it:

```bash
id -nG "$ADMIN_USER" | tr ' ' '\n' | grep --line-regexp pi-dashboard-admins
```

Expected output: exactly `pi-dashboard-admins`.

## 10. Install the new checkout

Confirm `/opt/pi-script-dashboard` is either absent or the stopped deployment you backed up:

```bash
sudo ls -ld /opt/pi-script-dashboard 2>/dev/null || true
```

If it does not exist:

```bash
sudo install -d -o pi-dashboard -g pi-dashboard -m 0750 /opt/pi-script-dashboard
sudo -u pi-dashboard git clone \
  https://github.com/davidabadi/pi-script-dashboard.git \
  /opt/pi-script-dashboard
```

If it already exists and is the expected Git checkout:

```bash
sudo chown -R pi-dashboard:pi-dashboard /opt/pi-script-dashboard
sudo -u pi-dashboard git -C /opt/pi-script-dashboard remote -v
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
sudo -u pi-dashboard git -C /opt/pi-script-dashboard pull --ff-only
```

What to expect:

- `remote -v` points to `davidabadi/pi-script-dashboard`.
- `status --short` is empty before pulling.
- `pull --ff-only` either fast-forwards or says it is already up to date.

Red flags — stop if:

- the remote points somewhere unexpected;
- the checkout contains uncommitted changes you have not backed up and understood;
- Git asks for unexpected credentials for a public read-only clone;
- `pull --ff-only` reports divergent history.

Record the deployed commit in the private deployment record:

```bash
sudo -u pi-dashboard git -C /opt/pi-script-dashboard rev-parse HEAD
sudo -u pi-dashboard git -C /opt/pi-script-dashboard log -1 --oneline --show-signature
```

Compare the full `rev-parse HEAD` value with `EXPECTED_DEPLOY_COMMIT`. They must be identical.

Install and validate dependencies:

```bash
cd /opt/pi-script-dashboard
sudo -u pi-dashboard env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" ci
sudo -u pi-dashboard env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" run check
sudo -u pi-dashboard env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" run audit:production
sudo -u pi-dashboard env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" run build:css
sudo -u pi-dashboard git diff --exit-code -- public/tailwind.css
```

What to expect:

- `npm ci` reports a clean install from `package-lock.json`.
- The test command reports all tests passing.
- The production audit reports `found 0 vulnerabilities`.
- Rebuilding CSS produces no Git diff.

Red flags — stop if:

- npm modifies `package-lock.json` during `npm ci`;
- any test fails;
- the audit reports a high or critical vulnerability;
- generated CSS differs from the tracked file.

Remove development-only packages after validation. The authentication broker is installed and tested separately in Step 12:

```bash
sudo -u pi-dashboard env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" prune --omit=dev
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
```

Expected:

- Final Git status is empty.

Red flag: do not start production until the broker can authenticate the intended administrator from the `pi-dashboard` account. Loading a PAM library or authenticating as root does not test that boundary.

## 11. Create the root-only application environment

Set the real public hostname from the private record:

```bash
DASHBOARD_HOST="dashboard.example.com"
```

Create the environment without placing the generated secret in shell history or command arguments:

```bash
sudo install -d -o root -g root -m 0700 /etc/pi-script-dashboard
sudo sh -c "
  set -eu
  umask 077
  secret=\$(openssl rand -base64 48 | tr -d '\\n')
  cat > /etc/pi-script-dashboard/environment <<EOF
SESSION_SECRET=\$secret
ADMIN_GROUP=pi-dashboard-admins
PAM_SOCKET=/run/pi-dashboard-auth/mux
TRUSTED_HOSTS=$DASHBOARD_HOST
PORT=8080
SCRIPT_ROOT=/var/lib/pi-script-dashboard/scripts
CONFIG_ROOT=/var/lib/pi-script-dashboard/configs
LOG_ROOT=/var/log/pi-script-dashboard
LOCK_ROOT=/run/pi-script-dashboard
DATA_FILE=/var/lib/pi-script-dashboard/scripts.json
SESSION_DIR=/var/lib/pi-script-dashboard/sessions
AUDIT_LOG=/var/log/pi-script-dashboard/audit.jsonl
EOF
  chown root:root /etc/pi-script-dashboard/environment
  chmod 0600 /etc/pi-script-dashboard/environment
"
```

Verify metadata and keys without printing the secret:

```bash
sudo stat -c '%U %G %a %n' /etc/pi-script-dashboard/environment
sudo awk -F= '{ print $1 }' /etc/pi-script-dashboard/environment
sudo awk -F= '$1 == "SESSION_SECRET" { print "SESSION_SECRET length:", length($2) }' /etc/pi-script-dashboard/environment
sudo grep -nE 'replace-with|example\.com' /etc/pi-script-dashboard/environment || true
```

What to expect:

- owner/group/mode: `root root 600`;
- only the documented variable names are printed;
- session secret length is comfortably above 32 characters;
- placeholder grep prints nothing.

Red flags — stop if:

- the file is group/world readable;
- the secret length is below 32;
- a placeholder remains;
- `TRUSTED_HOSTS` contains a URL, path, wildcard, or protocol. It must contain only the hostname, for example `dashboard.example.com`.

Never run `cat /etc/pi-script-dashboard/environment` in a recorded terminal or paste its output into support requests.

## 12. Install and test the authentication broker and service units

An unprivileged process cannot normally verify another local user's password with Debian's `pam_unix`. Node therefore sends authentication requests over a local Unix socket to the packaged `saslauthd` daemon. The broker runs as root while Node remains unprivileged. The application client always selects the root-owned `pi-script-dashboard` PAM profile, which requires `pi-dashboard-admins` membership for authentication and account checks. The application also checks group membership independently.

The socket is inside `/run/pi-dashboard-auth`, owned by `root:pi-dashboard` with mode `0750`. `saslauthd` creates the socket itself with permissive mode bits; the protected parent directory controls who can connect and prevents the service account from replacing it. Do not give `pi-dashboard` ownership or write permission on that directory.

Run from `/opt/pi-script-dashboard` on the **Pi**:

```bash
cd /opt/pi-script-dashboard

sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard-auth.service \
  /etc/systemd/system/pi-script-dashboard-auth.service
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard.pam \
  /etc/pam.d/pi-script-dashboard
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard.tmpfiles \
  /etc/tmpfiles.d/pi-script-dashboard.conf
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard.service
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.path
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard-update.service \
  /etc/systemd/system/pi-script-dashboard-update.service
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 \
  deploy/pi-script-dashboard-update \
  /usr/local/libexec/pi-script-dashboard-update
sudo install -o root -g root -m 0644 \
  deploy/pi-script-dashboard.logrotate \
  /etc/logrotate.d/pi-script-dashboard

sudo systemd-analyze verify \
  /etc/systemd/system/pi-script-dashboard-auth.service \
  /etc/systemd/system/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.service
sudo logrotate --debug /etc/logrotate.d/pi-script-dashboard
```

What to expect:

- `install` prints nothing.
- `systemd-analyze verify` returns successfully without unit errors.
- logrotate debug mode explains what it would rotate but does not rotate files.

Red flags — stop if:

- the update helper is writable by `pi-dashboard` or any non-root user;
- the broker unit or PAM profile is writable by a non-root user;
- a unit runs the web application as root;
- `ExecStart` does not point to `/usr/local/bin/node`;
- systemd reports unknown directives or invalid paths;
- logrotate rejects the configuration.

Inspect permissions:

```bash
stat -c '%U %G %a %n' \
  /etc/systemd/system/pi-script-dashboard-auth.service \
  /etc/pam.d/pi-script-dashboard \
  /etc/tmpfiles.d/pi-script-dashboard.conf \
  /etc/systemd/system/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.service \
  /usr/local/libexec/pi-script-dashboard-update \
  /etc/logrotate.d/pi-script-dashboard
```

Expected: every file is owned by `root root`; units/logrotate are `644`; helper is `755`.

Create protected application directories explicitly. `systemd-tmpfiles` recreates the lock directory at boot and keeps it available when cron runs while the web service is stopped:

```bash
sudo systemctl daemon-reload
sudo install -d -o pi-dashboard -g pi-dashboard -m 0700 \
  /var/lib/pi-script-dashboard \
  /var/lib/pi-script-dashboard/scripts \
  /var/lib/pi-script-dashboard/configs \
  /var/lib/pi-script-dashboard/sessions \
  /var/log/pi-script-dashboard
sudo systemd-tmpfiles --create /etc/tmpfiles.d/pi-script-dashboard.conf
sudo stat -c '%U %G %a %n' \
  /var/lib/pi-script-dashboard \
  /var/log/pi-script-dashboard \
  /run/pi-script-dashboard
```

What to expect: all three directories are owned by `pi-dashboard pi-dashboard` with mode `700`.

Start the authentication broker and check its protected socket before starting the web service:

```bash
sudo systemctl enable --now pi-script-dashboard-auth.service
sudo systemctl status pi-script-dashboard-auth.service --no-pager --full
sudo stat -c '%U %G %a %n' /run/pi-dashboard-auth
sudo -u pi-dashboard test -S /run/pi-dashboard-auth/mux
sudo -u pi-dashboard test ! -w /run/pi-dashboard-auth
sudo -u pi-dashboard -H python3 \
  /opt/pi-script-dashboard/deploy/check-pam-login.py "$ADMIN_USER"
```

Enter the administrator's Linux password only at the interactive prompt. The check keeps the password out of command arguments and shell history. Expected: authentication succeeds, and the socket directory is `root pi-dashboard 750`. A wrong password or a user outside `pi-dashboard-admins` must be rejected. If authentication fails, inspect the broker journal and fix the cause before cutover; do not add the web account to `shadow`, grant it `sudo`, or run Node as root. The earlier `sudo -u pi-dashboard pamtester login ...` test may still fail because it bypasses this broker.

Usernames are limited to 128 UTF-8 bytes and passwords to 256 UTF-8 bytes by the socket client/protocol. Passwords are never truncated to fit. Treat access to this socket as part of the trusted dashboard service account: another process running as `pi-dashboard` can connect to the same authentication daemon.

## 13. Migrate editable jobs into restricted directories

The hardened dashboard rejects the legacy locations `/usr/local/bin`, `/var/log/custom`, `/etc/*.lock`, and `/home/pi/backup-configs`. It accepts only:

| Type | New location | Mode |
|---|---|---:|
| Scripts | `/var/lib/pi-script-dashboard/scripts/*.sh` | `0700` |
| Configs | `/var/lib/pi-script-dashboard/configs/*.{conf,json,yaml,yml}` | `0600` |
| Logs | `/var/log/pi-script-dashboard/*.log` | `0600` |
| Locks | `/run/pi-script-dashboard/*.lock` | runtime |
| Registry | `/var/lib/pi-script-dashboard/scripts.json` | `0600` |

Create subdirectories:

```bash
sudo install -d -o pi-dashboard -g pi-dashboard -m 0700 \
  /var/lib/pi-script-dashboard/scripts \
  /var/lib/pi-script-dashboard/configs \
  /var/lib/pi-script-dashboard/sessions
```

Before copying, reject symbolic-link sources:

```bash
for source in \
  /usr/local/bin/backup_unraid.sh \
  /usr/local/bin/backup_unraid_postgresql_db.sh \
  /usr/local/bin/backup_forge_server.sh \
  /home/pi/backup-configs/conabadi.conf \
  /home/pi/backup-configs/lazopanama.conf; do
  if sudo test -L "$source"; then
    echo "STOP: symbolic link source: $source" >&2
    exit 1
  fi
done
```

Expected: no output. Any output is a red flag requiring manual resolution.

Copy scripts and configs:

```bash
sudo install -o pi-dashboard -g pi-dashboard -m 0700 \
  /usr/local/bin/backup_unraid.sh \
  /var/lib/pi-script-dashboard/scripts/backup_unraid.sh
sudo install -o pi-dashboard -g pi-dashboard -m 0700 \
  /usr/local/bin/backup_unraid_postgresql_db.sh \
  /var/lib/pi-script-dashboard/scripts/backup_unraid_postgresql_db.sh
sudo install -o pi-dashboard -g pi-dashboard -m 0700 \
  /usr/local/bin/backup_forge_server.sh \
  /var/lib/pi-script-dashboard/scripts/backup_forge_server.sh

sudo install -o pi-dashboard -g pi-dashboard -m 0600 \
  /home/pi/backup-configs/conabadi.conf \
  /var/lib/pi-script-dashboard/configs/conabadi.conf
sudo install -o pi-dashboard -g pi-dashboard -m 0600 \
  /home/pi/backup-configs/lazopanama.conf \
  /var/lib/pi-script-dashboard/configs/lazopanama.conf
```

If a source path does not exist, stop and locate the actual file from the backup rather than creating an empty replacement.

Create/migrate logs:

```bash
for name in \
  backup_unraid.log \
  unraid_postgresql_db_backup.log \
  conabadi_server_backup.log \
  lazopanama_server_backup.log; do
  if sudo test -f "/var/log/custom/$name"; then
    sudo install -o pi-dashboard -g pi-dashboard -m 0600 "/var/log/custom/$name" "/var/log/pi-script-dashboard/$name"
  else
    sudo install -o pi-dashboard -g pi-dashboard -m 0600 /dev/null "/var/log/pi-script-dashboard/$name"
  fi
done
```

Audit the copied scripts for hard-coded legacy locations and privileged commands:

```bash
sudo grep -RInE \
  '/usr/local/bin|/var/log/custom|/etc/[^ ]*\.lock|/home/pi/backup-configs|(^|[[:space:]])sudo([[:space:]]|$)|systemctl|reboot|shutdown' \
  /var/lib/pi-script-dashboard/scripts || true
```

What to expect: any matches identify lines that must be deliberately updated. Use `sudoedit` on the copied file, never the backup source:

```bash
sudoedit /var/lib/pi-script-dashboard/scripts/backup_unraid.sh
sudoedit /var/lib/pi-script-dashboard/scripts/backup_unraid_postgresql_db.sh
sudoedit /var/lib/pi-script-dashboard/scripts/backup_forge_server.sh
sudo find /var/lib/pi-script-dashboard/scripts -maxdepth 1 -type f -name '*.sh' \
  -exec chown pi-dashboard:pi-dashboard {} + \
  -exec chmod 0700 {} +
```

Required replacements inside scripts:

- `/var/log/custom/...` → the matching `/var/log/pi-script-dashboard/...`;
- `/etc/...lock` → a matching `/run/pi-script-dashboard/...lock`;
- `/home/pi/backup-configs/...` → the passed config argument or `/var/lib/pi-script-dashboard/configs/...`;
- remove `sudo`; grant `pi-dashboard` only the specific filesystem/database/SSH permission the operation requires.

Red flags — do not continue while an editable script contains `sudo`, `reboot`, `shutdown`, arbitrary `systemctl`, writes beneath `/etc`, or depends on broad access to `/home/pi`.

Syntax-check without executing jobs:

```bash
sudo -u pi-dashboard /bin/bash -c '
  set -e
  for script in /var/lib/pi-script-dashboard/scripts/*.sh; do
    echo "Checking $script"
    /bin/bash -n "$script"
  done
'
```

Expected: each filename is printed and no syntax errors follow.

Create the runtime registry. This deliberately excludes the legacy `Update + Reboot` job:

```bash
sudo tee /var/lib/pi-script-dashboard/scripts.json >/dev/null <<'JSON'
{
  "Conabadi Server Backup": {
    "script": "/var/lib/pi-script-dashboard/scripts/backup_forge_server.sh",
    "log": "/var/log/pi-script-dashboard/conabadi_server_backup.log",
    "cron_tag": "Conabadi Server Backup",
    "lock": "/run/pi-script-dashboard/conabadi_server_backup.lock",
    "order": 0,
    "config_path": "/var/lib/pi-script-dashboard/configs/conabadi.conf"
  },
  "Lazo Panama Server Backup": {
    "script": "/var/lib/pi-script-dashboard/scripts/backup_forge_server.sh",
    "log": "/var/log/pi-script-dashboard/lazopanama_server_backup.log",
    "cron_tag": "Lazo Panama Server Backup",
    "lock": "/run/pi-script-dashboard/lazopanama_server_backup.lock",
    "order": 1,
    "config_path": "/var/lib/pi-script-dashboard/configs/lazopanama.conf"
  },
  "Unraid PostgreSQL Backup": {
    "script": "/var/lib/pi-script-dashboard/scripts/backup_unraid_postgresql_db.sh",
    "log": "/var/log/pi-script-dashboard/unraid_postgresql_db_backup.log",
    "cron_tag": "Unraid PostgreSQL Backup",
    "lock": "/run/pi-script-dashboard/unraid_postgresql_db_backup.lock",
    "order": 2
  },
  "Unraid Backup": {
    "script": "/var/lib/pi-script-dashboard/scripts/backup_unraid.sh",
    "log": "/var/log/pi-script-dashboard/backup_unraid.log",
    "cron_tag": "Unraid Backup",
    "lock": "/run/pi-script-dashboard/backup_unraid.lock",
    "order": 3
  }
}
JSON
sudo chown pi-dashboard:pi-dashboard /var/lib/pi-script-dashboard/scripts.json
sudo chmod 0600 /var/lib/pi-script-dashboard/scripts.json
sudo -u pi-dashboard "$NODE_BIN_DIR/node" -e \
  "const fs=require('fs'); JSON.parse(fs.readFileSync('/var/lib/pi-script-dashboard/scripts.json')); console.log('scripts.json valid')"
```

Expected: `scripts.json valid`.

Red flags: JSON parse failure, an unexpected fifth job, or any path outside the managed directories.

## 14. Migrate credentials and narrow job permissions

The service runs with `ProtectHome=true`, so jobs cannot rely on `/home/pi/.ssh`. Old jobs launched through `sudo` may instead use `/root/.ssh`; inspect their actual credentials and key paths before copying. Copy only the specific deployment key and known-host entries required by backup jobs.

Example, replacing filenames with the real values from the private record:

```bash
sudo install -d -o pi-dashboard -g pi-dashboard -m 0700 /var/lib/pi-script-dashboard/.ssh
sudo install -o pi-dashboard -g pi-dashboard -m 0600 \
  /home/pi/.ssh/REPLACE_WITH_REQUIRED_KEY \
  /var/lib/pi-script-dashboard/.ssh/REPLACE_WITH_REQUIRED_KEY
sudo install -o pi-dashboard -g pi-dashboard -m 0600 \
  /home/pi/.ssh/known_hosts \
  /var/lib/pi-script-dashboard/.ssh/known_hosts
```

Inspect without printing private-key content:

```bash
sudo find /var/lib/pi-script-dashboard/.ssh -maxdepth 1 -type f -printf '%u %g %m %f\n'
sudo -u pi-dashboard ssh-keygen -lf /var/lib/pi-script-dashboard/.ssh/REPLACE_WITH_REQUIRED_KEY
```

Expected: files owned by `pi-dashboard`, private key mode `600`, and the expected public fingerprint.

Red flags — stop if:

- you cannot verify the key fingerprint from a trusted record;
- a private key is group/world readable;
- jobs require copying the entire old `.ssh` directory without understanding its contents;
- database or remote credentials are embedded directly in shell scripts.

Grant backup data access with read-only groups or ACLs where possible. Do not make entire trees world-readable or run the dashboard as root. Every `Permission denied` encountered later is a request for one narrow permission, not justification for `chmod -R 777`.

The systemd sandbox makes the host filesystem read-only to dashboard-launched jobs except for the application directories and `/var/spool/cron/crontabs`. The cron exception lets Debian's setgid `crontab` helper update this account's schedule; normal filesystem permissions still prevent it from editing another user's crontab. If a backup job must write to a mounted destination outside `/var/log/pi-script-dashboard` or `/var/lib/pi-script-dashboard`, explicitly allow only that destination with a systemd drop-in. Cron-launched jobs run outside the web unit's systemd sandbox, so their ordinary Unix permissions also need review.

Example — replace these paths with values recorded in the private deployment record and omit any line the jobs do not need:

```bash
BACKUP_SOURCE="/srv/data-to-back-up"
BACKUP_DESTINATION="/mnt/private-backups"

for required_path in "$BACKUP_SOURCE" "$BACKUP_DESTINATION"; do
  test -d "$required_path" || { echo "STOP: missing $required_path" >&2; exit 1; }
  readlink -f "$required_path"
  findmnt --target "$required_path" || true
done

sudo install -d -o root -g root -m 0755 \
  /etc/systemd/system/pi-script-dashboard.service.d
sudo tee /etc/systemd/system/pi-script-dashboard.service.d/backup-paths.conf >/dev/null <<EOF
[Service]
ReadOnlyPaths=$BACKUP_SOURCE
ReadWritePaths=$BACKUP_DESTINATION
EOF
sudo chmod 0644 /etc/systemd/system/pi-script-dashboard.service.d/backup-paths.conf
sudo systemd-analyze verify /etc/systemd/system/pi-script-dashboard.service
sudo systemctl daemon-reload
```

What to expect:

- `readlink -f` prints the intended canonical directories.
- `findmnt` identifies the expected local or network filesystem when the path is a mount.
- systemd verification succeeds.

Red flags — stop if:

- either path resolves to `/`, `/etc`, `/usr`, `/var`, `/home`, or another broad parent;
- the destination is unexpectedly on the Pi root filesystem;
- the mount is absent and writing would silently fill the SD card;
- the service needs `ReadWritePaths=/` or write access to an entire home directory;
- a path contains whitespace or systemd-special characters that have not been correctly escaped.

If jobs only send data to remote servers and write their local logs in `/var/log/pi-script-dashboard`, do not create this drop-in.

## 15. Move schedules from root cron to the service account

First inspect the backed-up root crontab:

```bash
sudo sed -n '1,240p' "$BACKUP_ROOT/root-crontab.txt"
```

Record the five-field schedule and whether each job is active or paused in the private deployment record. Do not copy unrelated or secret-bearing command lines into Git. Stage every new entry as paused until root schedules are disabled and the new service passes its checks.

Set the four schedules interactively on the **Pi**. Enter only the five cron fields, for example `0 2 * * *`:

```bash
read -r -p "Unraid Backup schedule: " CRON_UNRAID
read -r -p "Unraid PostgreSQL Backup schedule: " CRON_POSTGRES
read -r -p "Conabadi Server Backup schedule: " CRON_CONABADI
read -r -p "Lazo Panama Server Backup schedule: " CRON_LAZO

CRON_REVIEW="$(mktemp)"
printf '%s\n' \
  "# $CRON_UNRAID '/bin/bash' '/var/lib/pi-script-dashboard/scripts/backup_unraid.sh' # pi-dashboard:d73547ff98884b97" \
  "# $CRON_POSTGRES '/bin/bash' '/var/lib/pi-script-dashboard/scripts/backup_unraid_postgresql_db.sh' # pi-dashboard:805bfe29eb27fc7b" \
  "# $CRON_CONABADI '/bin/bash' '/var/lib/pi-script-dashboard/scripts/backup_forge_server.sh' '/var/lib/pi-script-dashboard/configs/conabadi.conf' # pi-dashboard:c72d3d1284289cbf" \
  "# $CRON_LAZO '/bin/bash' '/var/lib/pi-script-dashboard/scripts/backup_forge_server.sh' '/var/lib/pi-script-dashboard/configs/lazopanama.conf' # pi-dashboard:19445ae2037a9fae" \
  | tee "$CRON_REVIEW"
```

Review the temporary file carefully:

```bash
cat "$CRON_REVIEW"
awk 'NF < 9 { print "STOP: suspicious line", NR ":", $0; bad=1 } END { exit bad }' "$CRON_REVIEW"
```

Red flags — stop if:

- a schedule is blank;
- a line contains a username field such as `root` (user crontabs do not have that field);
- a command points to a legacy directory;
- markers differ from the exact `pi-dashboard:<16 hex characters>` values above;
- schedules would make jobs overlap unexpectedly.

Confirm the service user's existing crontab is empty or contains only entries you have intentionally accounted for before replacing it. Install the staged, commented entries:

```bash
sudo crontab -u pi-dashboard "$CRON_REVIEW"
sudo -u pi-dashboard crontab -l
rm -f -- "$CRON_REVIEW"
```

Expected: exactly the four managed lines, all commented out, plus any intentionally retained service-user lines. Leave the old root schedules unchanged until the cutover in Step 16. Do not activate the new schedules while the corresponding root jobs are active.

### The old Update + Reboot job

Do not copy `update_and_reboot.sh` into the editable dashboard directory and do not add it to `scripts.json`. It is root-equivalent behavior.

Explicitly comment out its old root schedule during the cutover. Removing it from the new registry does not disable the old scheduled job.

Before restoring that capability:

```bash
sudo install -o root -g root -m 0750 \
  /usr/local/bin/update_and_reboot.sh \
  /usr/local/libexec/update-and-reboot-reviewed
sudo apt-get install -y shellcheck
sudo shellcheck /usr/local/libexec/update-and-reboot-reviewed
sudo less /usr/local/libexec/update-and-reboot-reviewed
```

Red flags include downloaded code executed without verification, arbitrary user input, broad wildcard deletion, writable script dependencies, unbounded package upgrades, or reboot on failure. Keep this capability disabled until a human review is complete. If it must return, create a separate root-owned systemd service/timer with fixed arguments; never invoke it through an editable dashboard job.

## 16. Start and inspect the hardened service

Begin the maintenance window only after the broker login check succeeds and no old backup job is still running. Keep the old dashboard idle. Capture the final mutable metadata before changing schedules:

```bash
sudo sh -c 'crontab -l > "$1/root-crontab.cutover.txt"' sh "$BACKUP_ROOT"
sudo cp -a -- "$OLD_REPO/scripts.json" "$BACKUP_ROOT/scripts.cutover.json"
```

If root had no crontab, record that fact instead of treating an error message as a restorable crontab. Copy this final metadata to the same private off-device storage used for the rollback archive.

Edit the root crontab and comment out only the four migrated backup jobs and the old `Update + Reboot` job. Leave unrelated entries untouched:

```bash
sudo crontab -e
sudo crontab -l
sudo -u pi-dashboard crontab -l
```

Confirm the migrated jobs are inactive in both accounts, then stop the old dashboard:

```bash
sudo systemctl disable --now "$OLD_DASHBOARD_SERVICE"
sudo ss -ltnp '( sport = :8080 )'
```

Expected: no listener on port 8080. Stop if a supervisor restarts the old process or port 8080 remains occupied.

Save the old Node command paths and switch the stable aliases to the verified Node 24 installation. This changes the global commands only after the old dashboard is stopped:

```bash
sudo bash -s -- "$BACKUP_ROOT" "$NODE_BIN_DIR" <<'BASH'
set -euo pipefail
cd /
backup=$1
node_bin_dir=$2
if [ -e "$backup/node-commands" ]; then
  echo 'STOP: existing Node rollback records must not be overwritten' >&2
  exit 1
fi
install -d -o root -g root -m 0700 "$backup/node-commands"
for tool in node npm npx; do
  target="/usr/local/bin/$tool"
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    echo "STOP: unexpected directory at $target" >&2
    exit 1
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    cp -a --parents -- "$target" "$backup/node-commands"
  else
    touch "$backup/node-commands/$tool.absent"
  fi
done
for tool in node npm npx; do
  ln -sfn "$node_bin_dir/$tool" "/usr/local/bin/$tool"
done
BASH
hash -r
/usr/local/bin/node --version
```

Expected: `v24.x.y`. Keep the `node-commands` backup for rollback. Enable the broker, update watcher, and dashboard:

```bash
sudo systemctl daemon-reload
sudo systemd-tmpfiles --create /etc/tmpfiles.d/pi-script-dashboard.conf
sudo systemctl enable --now pi-script-dashboard-auth.service
sudo systemctl enable --now pi-script-dashboard-update.path
sudo systemctl enable --now pi-script-dashboard.service
sudo systemctl status pi-script-dashboard.service --no-pager --full
sudo systemctl status pi-script-dashboard-auth.service --no-pager --full
sudo systemctl status pi-script-dashboard-update.path --no-pager --full
```

What to expect:

- All three units are `active`.
- Dashboard service shows `Main PID` owned by `pi-dashboard`.
- The log says `Server running on 127.0.0.1:8080`.

Inspect recent logs:

```bash
sudo journalctl -u pi-script-dashboard.service --since '-5 minutes' --no-pager
sudo ss -ltnp '( sport = :8080 )'
```

Expected listener: `127.0.0.1:8080`, never `0.0.0.0:8080`, `[::]:8080`, or the Pi LAN address.

Red flags — stop and disable the public tunnel if:

- the service repeatedly restarts;
- production reports an ephemeral session secret;
- PAM is unavailable;
- session/config directories are permission denied;
- Node listens on anything other than loopback;
- the process runs as root.

Test the local origin:

```bash
curl --silent --show-error --dump-header - --output /dev/null \
  http://127.0.0.1:8080/login
```

Expected headers include:

- `HTTP/1.1 200 OK`;
- `Content-Security-Policy`;
- `Cache-Control: no-store`;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;

The local HTTP request normally receives no session cookie because production cookies require HTTPS. Check `Secure`, `HttpOnly`, and `SameSite=Strict` on the session cookie through the HTTPS Cloudflare hostname during real authentication.

Test sandboxing:

```bash
sudo systemd-analyze security pi-script-dashboard.service --no-pager
sudo -u pi-dashboard test ! -w /etc && echo '/etc is not writable by service user'
sudo -u pi-dashboard test -w /var/lib/pi-script-dashboard && echo 'state directory is writable'
sudo -u pi-dashboard test -w /var/log/pi-script-dashboard && echo 'log directory is writable'
```

Red flags: service runs as root, has broad capabilities, can write `/etc`, or cannot write its dedicated state/log directories.

## 17. Close direct network access to port 8080

The Node service is loopback-only, but retain a firewall defense.

Check whether UFW is active:

```bash
sudo ufw status verbose 2>/dev/null || true
```

If UFW is already active, deny port 8080:

```bash
sudo ufw deny 8080/tcp
sudo ufw status numbered
```

If UFW is not currently active, do not enable it remotely until SSH is explicitly allowed:

```bash
sudo ufw allow OpenSSH
sudo ufw deny 8080/tcp
sudo ufw enable
sudo ufw status verbose
```

Keep the second SSH session open while doing this.

From another LAN machine, not the Pi:

```bash
curl --connect-timeout 5 -I http://PI_LAN_ADDRESS:8080/login
```

Expected: connection refused or timeout.

Red flags — stop if the Pi login page is returned over the LAN, or if enabling the firewall disconnects both SSH sessions. Use the recovery console before continuing.

## 18. Install or inspect Cloudflare Tunnel

Cloudflare recommends remotely managed tunnels for most installations. If the existing tunnel is healthy, preserve it and update only its published application route to `http://127.0.0.1:8080`. Do not create a second tunnel unnecessarily.

### 18.1 Install `cloudflared` when absent

On the **Pi**:

```bash
if ! command -v cloudflared >/dev/null; then
  sudo install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y cloudflared
fi

cloudflared --version
```

What to expect: a current `cloudflared version ...` line.

Red flags: repository signature failure, a binary from an unexpected path, or an unsupported ancient release.

### 18.2 Inspect an existing tunnel

```bash
sudo systemctl status cloudflared --no-pager --full || true
sudo systemctl cat cloudflared || true
sudo find /etc/cloudflared /root/.cloudflared -maxdepth 2 -type f -printf '%u %g %m %p\n' 2>/dev/null || true
```

Do not print credential JSON or tunnel tokens.

For a locally managed tunnel, validate the config:

```bash
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule "https://$DASHBOARD_HOST"
```

Expected:

- configuration validation succeeds;
- the hostname resolves to `http://127.0.0.1:8080`;
- the final unmatched rule is `http_status:404`.

Red flags: origin is `0.0.0.0`, a LAN IP, the wrong port, or the catch-all rule proxies elsewhere.

### 18.3 Create a new locally managed tunnel only if necessary

Interactive login opens a browser authorization flow:

```bash
cloudflared tunnel login
cloudflared tunnel create pi-script-dashboard
cloudflared tunnel list
```

Record the tunnel UUID in the private deployment record. The generated credential JSON is sensitive.

Install the configuration using the repository example:

```bash
sudo install -d -o root -g root -m 0700 /etc/cloudflared
TUNNEL_ID="REPLACE_WITH_TUNNEL_UUID"
sudo install -o root -g root -m 0600 \
  "$HOME/.cloudflared/$TUNNEL_ID.json" \
  "/etc/cloudflared/$TUNNEL_ID.json"
sudo install -o root -g root -m 0600 \
  /opt/pi-script-dashboard/deploy/cloudflared-config.example.yml \
  /etc/cloudflared/config.yml
sudoedit /etc/cloudflared/config.yml
```

Replace exactly:

- `replace-with-tunnel-uuid` with the UUID;
- `dashboard.example.com` with `$DASHBOARD_HOST`.

Validate before DNS routing:

```bash
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule "https://$DASHBOARD_HOST"
cloudflared tunnel route dns pi-script-dashboard "$DASHBOARD_HOST"
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

What to expect:

- DNS routing creates a CNAME to the tunnel.
- `cloudflared.service` becomes active.
- Tunnel logs report connected connections, not repeated reconnect/error loops.

Red flags: credentials are group/world readable, DNS points to another tunnel unexpectedly, or `cloudflared` cannot reach `127.0.0.1:8080`.

Inspect without leaking credentials:

```bash
sudo stat -c '%U %G %a %n' /etc/cloudflared/config.yml /etc/cloudflared/*.json
sudo journalctl -u cloudflared --since '-10 minutes' --no-pager
```

Expected ownership/mode: `root root 600`.

## 19. Configure Cloudflare Access before testing the public hostname

This step is performed in the Cloudflare Zero Trust dashboard. A Tunnel by itself is not the identity gate.

1. Go to **Zero Trust → Access controls → Applications**.
2. Create an application and choose **Self-hosted and private**.
3. Set the application hostname to the exact `$DASHBOARD_HOST`; do not use a broad wildcard.
4. Set application session duration to **8 hours**.
5. Add an **Allow** policy containing only the administrator email addresses or identity-provider group recorded in the private deployment record.
6. Add an MFA requirement:
   - for IdP MFA, add **Require → Authentication method → mfa**; or
   - configure Cloudflare independent MFA with **Require every login** or the organization’s approved MFA duration.
7. Do not add a `Bypass`, `Everyone`, broad email-domain, or service-token policy for human browser access.
8. In the Tunnel published application route, enable **Protect with Access** so the tunnel validates the Access token before forwarding to the origin.
9. If compatible with other applications in the Cloudflare account, enable the account-level **Block traffic to all domains in this account** default-deny setting only after confirming every public hostname that should remain reachable has an Access application.
10. Add a cache rule for the dashboard hostname that bypasses cache. This admin application must never be served from shared edge cache.

What to expect:

- The application policy preview matches only intended administrators.
- MFA is shown as required.
- The hostname has an Access application before it is used.

Red flags — do not continue if:

- the policy allows `Everyone` or the entire Internet;
- a broad domain includes users who are not Pi administrators;
- MFA is optional;
- a bypass policy exists;
- Access protection is absent from the tunnel route;
- Cloudflare caching is enabled for HTML or authenticated routes.

## 20. Verify the public security boundary

Use a browser profile that is not already signed in to Cloudflare Access, or an incognito window.

From the **workstation**, before authenticating:

```powershell
$DashboardHost = "dashboard.example.com"
curl.exe -I "https://$DashboardHost/login"
```

Expected: a redirect to a Cloudflare Access authentication domain or an Access denial. You must not receive the Pi dashboard login HTML directly.

Red flags:

- `200 OK` showing the Pi login page before Access authentication;
- Cloudflare cache status `HIT` for the login/dashboard HTML;
- certificate warnings;
- hostname resolves directly to the Pi public IP instead of Cloudflare.

Complete Cloudflare Access authentication and MFA in the browser. You should then see the Pi dashboard PAM login page.

Sign in with the Linux administrator account added to `pi-dashboard-admins`.

Expected:

- a wrong password returns only `Invalid credentials`;
- a valid password for a user outside `pi-dashboard-admins` is rejected;
- the approved PAM user reaches the dashboard;
- logout returns to the login page;
- after 30 idle minutes the application session expires;
- Cloudflare and PAM are separate prompts when both sessions have expired.

On the **Pi**, inspect security audit events without exposing job/config contents:

```bash
sudo tail -n 30 /var/log/pi-script-dashboard/audit.jsonl
sudo stat -c '%U %G %a %n' /var/log/pi-script-dashboard/audit.jsonl
```

Expected: structured JSON events such as login success/failure and logout; file mode `600`.

Red flags: passwords, session cookies, CSRF tokens, config content, or SSH keys appear in audit logs.

## 21. Functional acceptance tests

Perform these in order while watching logs:

```bash
sudo journalctl -u pi-script-dashboard.service -f
```

Open another SSH session for commands.

### 21.1 Dashboard rendering

- Open the dashboard.
- Confirm four migrated jobs appear.
- Confirm `Update + Reboot` does not appear.
- Open each log.

Red flags: a legacy path warning, server error, missing CSS/editor asset, CSP errors in browser developer tools, or another user’s cached content.

### 21.2 Edit validation

- Open one job for editing without saving.
- Confirm its script/config/log/lock paths are under the managed roots.
- Attempt to change a path to `/etc/test.sh` and submit.

Expected: the unsafe path is rejected. Restore the original managed path.

Red flag: any path outside the managed roots is accepted.

### 21.3 Cron pause/resume

- Confirm the corresponding root job is disabled, then resume one job in the dashboard during the maintenance window. Avoid its scheduled run time while testing.
- Pause that job in the dashboard.
- Run `sudo -u pi-dashboard crontab -l`; its exact line should be commented.
- Resume it; the exact line should be active again.

Red flags: multiple lines change, a different job changes, the root crontab changes, or the marker disappears.

After all acceptance tests pass, restore each new job's previously recorded active or paused state. Check both crontabs again: the old root backup entries must stay disabled, and the `Update + Reboot` schedule must stay disabled. Observe at least one scheduled service-user backup separately from the manual-run test.

### 21.4 Manual job execution

Run the least disruptive backup job from the dashboard during the maintenance window.

On the Pi:

```bash
sudo journalctl -u pi-script-dashboard.service --since '-10 minutes' --no-pager
sudo tail -n 100 /var/log/pi-script-dashboard/REPLACE_WITH_JOB_LOG.log
ps -eo user,pid,ppid,cmd | grep -E '[b]ackup_|[p]i-script-dashboard'
```

Expected:

- job process owner is `pi-dashboard`, not root;
- the expected lock appears only while running;
- the log is updated;
- the job succeeds with its narrowly granted permissions.

Red flags: process runs as root, credentials appear in logs, lock remains after completion, job writes legacy paths, or permissions are broadened as a workaround.

### 21.5 Reordering

- Enter reorder mode, move one card, save, and refresh.
- Confirm order persists.
- Inspect `/var/lib/pi-script-dashboard/scripts.json` metadata without printing config contents:

```bash
sudo -u pi-dashboard /usr/local/bin/node -e \
  "const d=require('/var/lib/pi-script-dashboard/scripts.json'); console.table(Object.entries(d).map(([name,v])=>({name,order:v.order})))"
```

Red flag: jobs disappear, duplicates appear, or unrelated fields change.

### 21.6 Update path

Click **Update dashboard** once. Watch:

```bash
sudo journalctl -u pi-script-dashboard-update.service -f
```

Then verify:

```bash
sudo systemctl status pi-script-dashboard-update.service --no-pager --full
sudo systemctl status pi-script-dashboard.service --no-pager --full
sudo test ! -e /var/lib/pi-script-dashboard/update.request && echo 'request cleared'
sudo test ! -e /run/pi-script-dashboard/dashboard-update.lock && echo 'lock cleared'
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
```

Expected: fast-forward-only update, clean `npm ci --omit=dev`, dashboard restart, request/lock removed, clean Git status.

Red flags: update runs concurrently, Git reports local modifications/divergence, lifecycle install fails, request or lock remains, or the dashboard does not restart.

## 22. Remove legacy exposure only after acceptance

After every acceptance test passes and the off-device backup is verified:

1. Keep the legacy backup archive on the private share according to your retention policy.
2. Keep old scripts/configs locally for a short rollback window, but make them root-readable only and ensure no cron entry executes them.
3. Remove or disable the old service definition if it has a different name.
4. Do not delete the old `Update + Reboot` script until its separate replacement is reviewed.
5. Confirm no `.env`, Cloudflare credential, private key, or config has entered Git:

```bash
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short --untracked-files=all
sudo -u pi-dashboard git -C /opt/pi-script-dashboard ls-files | grep -Ei '(^|/)(\.env|secrets?|private-deployment|.*\.pem|.*\.key)$' && echo 'STOP: inspect matched tracked files' || true
```

Expected: clean Git status and no sensitive tracked-file matches.

## 23. Rollback procedure

Rollback if the hardened service cannot authenticate administrators, required jobs cannot run unprivileged without unsafe permission expansion, or Cloudflare Access cannot be made default-deny.

On the **Pi**:

```bash
sudo systemctl disable --now pi-script-dashboard.service
sudo systemctl disable --now pi-script-dashboard-update.path
sudo systemctl disable --now pi-script-dashboard-auth.service
sudo ss -ltnp '( sport = :8080 )' || true
```

Disable the service-user crontab first to prevent duplicate runs. Preserve it in the root-only backup directory:

```bash
sudo sh -c 'crontab -u pi-dashboard -l > "$1/pi-dashboard-crontab.rollback.txt"' sh "$BACKUP_ROOT"
sudo crontab -u pi-dashboard -r
```

If no service-user crontab exists, confirm that before proceeding. Restore the root crontab from the final cutover capture, or from the verified archive if cutover had not reached that capture:

```bash
sudo crontab "$BACKUP_ROOT/root-crontab.cutover.txt"
sudo crontab -l
```

If the root crontab was originally absent, remove it instead of installing a file containing `no crontab` output. Keep the old `Update + Reboot` entry commented out while troubleshooting.

Restore the old Node command paths before restarting the old service. Skip this block if the cutover never switched them:

```bash
sudo bash -s -- "$BACKUP_ROOT" <<'BASH'
set -euo pipefail
backup=$1
for tool in node npm npx; do
  target="/usr/local/bin/$tool"
  saved="$backup/node-commands/usr/local/bin/$tool"
  if [ -e "$saved" ] || [ -L "$saved" ]; then
    rm -f -- "$target"
    cp -a -- "$saved" "$target"
  elif [ -f "$backup/node-commands/$tool.absent" ]; then
    rm -f -- "$target"
  else
    echo "STOP: no rollback record for $target" >&2
    exit 1
  fi
done
BASH
hash -r
```

Restore/re-enable the old dashboard service using the original unit file and drop-ins captured under `$BACKUP_ROOT`, with `$BACKUP_ROOT/old-service.txt` as a reference. If the old service used `pi-script-dashboard.service`, reinstall its original unit file before enabling it. Do not install the concatenated `systemctl cat` reference as a replacement unit.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now "$OLD_DASHBOARD_SERVICE"
```

Keep Cloudflare Access enabled during rollback. It is an independent security layer and should not be removed merely because the origin application was rolled back.

Verify rollback:

```bash
sudo systemctl status "$OLD_DASHBOARD_SERVICE" --no-pager --full || true
sudo ss -ltnp '( sport = :8080 )' || true
sudo crontab -l
sudo -u pi-dashboard crontab -l 2>&1 || true
```

Red flags: duplicate cron schedules, two dashboard processes, public direct access to port 8080, or an unprotected Cloudflare hostname.

## 24. Routine operations after deployment

### Application update

Prefer the dashboard update button after deployment prerequisites are installed. The update helper does not install root-owned units, PAM profiles, or tmpfiles rules. When upgrading an existing hardened deployment to this authentication-broker release, install `sasl2-bin` and the Step 12 files from the reviewed release, then pass the service-account socket login test before starting the updated application. Review and install changes to those root-owned deployment files manually for future releases as well.

Before updating:

```bash
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
sudo -u pi-dashboard git -C /opt/pi-script-dashboard fetch origin
sudo -u pi-dashboard git -C /opt/pi-script-dashboard log --oneline --decorate HEAD..origin/main
```

Expected: clean working tree and only reviewed commits pending.

### Weekly checks

```bash
sudo systemctl --failed
sudo systemctl status pi-script-dashboard.service pi-script-dashboard-auth.service cloudflared.service --no-pager
sudo journalctl -u pi-script-dashboard.service -p warning --since '-7 days' --no-pager
sudo journalctl -u cloudflared.service -p warning --since '-7 days' --no-pager
sudo -u pi-dashboard crontab -l
sudo tail -n 100 /var/log/pi-script-dashboard/audit.jsonl
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
```

Healthy result: no failed units, all three services active, expected four cron lines with the recorded paused states, no unexplained login failures/actions, and clean Git status.

### Dependency review

From a clean checkout with development dependencies installed:

```bash
cd /opt/pi-script-dashboard
sudo -u pi-dashboard /usr/local/bin/npm ci
sudo -u pi-dashboard /usr/local/bin/npm run check
sudo -u pi-dashboard /usr/local/bin/npm run audit:production
sudo -u pi-dashboard /usr/local/bin/npm prune --omit=dev
```

Do not run `npm audit fix --force` blindly on production. Review and test dependency updates through a pull request.

## 25. Troubleshooting quick reference

### Service exits with `SESSION_SECRET must contain at least 32 bytes`

```bash
sudo awk -F= '$1 == "SESSION_SECRET" { print length($2) }' /etc/pi-script-dashboard/environment
sudo stat -c '%U %G %a' /etc/pi-script-dashboard/environment
```

Generate a new environment file as described in Step 11. Existing sessions will be signed out.

### Service exits because PAM is unavailable

```bash
dpkg-query -W sasl2-bin
sudo systemctl status pi-script-dashboard-auth.service --no-pager --full
sudo journalctl -u pi-script-dashboard-auth.service --since '-10 minutes' --no-pager
sudo stat -c '%U %G %a %n' /run/pi-dashboard-auth /etc/pam.d/pi-script-dashboard
sudo -u pi-dashboard test -S /run/pi-dashboard-auth/mux
sudo grep '^PAM_SOCKET=' /etc/pi-script-dashboard/environment
```

The socket path must match `PAM_SOCKET`; its parent must be `root:pi-dashboard 0750`, and the PAM profile must be `root:root 0644`. Reinstall the root-owned broker unit/PAM profile from the reviewed release if needed. Do not enable fallback credentials in production, make the socket directory writable by the application, or grant the web account access to `/etc/shadow`.

### Valid PAM password is rejected

```bash
getent group pi-dashboard-admins
id -nG REPLACE_WITH_USERNAME
sudo passwd --status REPLACE_WITH_USERNAME
sudo -u pi-dashboard -H python3 \
  /opt/pi-script-dashboard/deploy/check-pam-login.py REPLACE_WITH_USERNAME
sudo journalctl -u pi-script-dashboard-auth.service --since '-10 minutes' --no-pager
sudo journalctl -u pi-script-dashboard.service --since '-10 minutes' --no-pager
```

The user must have a usable password, pass PAM account checks, and have explicit group membership. Enter passwords only at the interactive prompt. A root `pamtester login` success paired with an unprivileged failure is expected on standard Debian and does not validate this broker; use the socket check above.

### Browser loops back to login or never receives a session

```bash
sudo journalctl -u pi-script-dashboard.service --since '-10 minutes' --no-pager
sudo systemctl status cloudflared --no-pager
curl -I "https://$DASHBOARD_HOST/login"
```

Confirm Cloudflare forwards the original HTTPS scheme and the browser accesses the exact `TRUSTED_HOSTS` hostname. Never disable the `Secure` cookie to work around a proxy error.

### `403 Request verification failed`

Reload the page and retry once. This normally means a stale form after session rotation or expiry. Persistent failures indicate stripped cookies/headers, an incorrect origin hostname, or cached HTML. Confirm Cloudflare cache bypass.

### Job fails with permission denied

```bash
namei -l /path/reported/by/the/job
sudo -u pi-dashboard test -r /required/input && echo readable
sudo -u pi-dashboard test -w /required/output && echo writable
```

Grant the smallest necessary group/ACL permission. Do not add `sudo`, run the web service as root, disable path validation, or use world-writable permissions.

### Cloudflare returns 502

```bash
curl -I http://127.0.0.1:8080/login
sudo systemctl status pi-script-dashboard.service cloudflared.service --no-pager
sudo journalctl -u cloudflared.service --since '-10 minutes' --no-pager
```

A local `200` plus public `502` points to tunnel configuration. A failed local curl points to the dashboard service.

### Cloudflare hostname shows the Pi login page without Access

Immediately disable the published hostname or tunnel route, then create/fix the Access application and **Protect with Access** setting. Do not rely on PAM alone for this Internet-facing hostname.

## 26. Final acceptance checklist

Deployment is complete only when every item is true:

- [ ] Sensitive deployment values live outside Git on a private share.
- [ ] A verified off-device rollback archive exists.
- [ ] Node is v24 and was installed from a checksum-verified archive.
- [ ] `npm run check` passes.
- [ ] Production dependency audit reports zero vulnerabilities.
- [ ] The dedicated root PAM broker is active, with a root-owned profile requiring `pi-dashboard-admins`.
- [ ] The `pi-dashboard` account can authenticate the intended administrator through the protected socket; wrong passwords and users outside the group are rejected.
- [ ] `/run/pi-dashboard-auth` is `root:pi-dashboard 0750` and not writable by the application.
- [ ] The tmpfiles-managed lock directory exists independently of the web service.
- [ ] `pi-dashboard` has no interactive shell and is not an admin-group member.
- [ ] Only intended PAM users belong to `pi-dashboard-admins`.
- [ ] Environment and Cloudflare credentials are `root:root 0600`.
- [ ] Editable jobs and runtime data stay within managed directories.
- [ ] Editable jobs run as `pi-dashboard`, not root.
- [ ] No editable script contains `sudo`, reboot, shutdown, or broad privileged actions.
- [ ] Root cron no longer contains migrated backup jobs.
- [ ] The service-user crontab contains the expected unique markers.
- [ ] Node listens only on `127.0.0.1:8080`.
- [ ] LAN/public direct access to port 8080 fails.
- [ ] Cloudflare Access uses an explicit allowlist and MFA.
- [ ] Tunnel route has Protect with Access enabled and a 404 catch-all.
- [ ] Unauthenticated public requests do not reach the Pi login page.
- [ ] Authenticated HTML is not cached by Cloudflare.
- [ ] Security headers and secure session cookie are present.
- [ ] Audit events contain no credentials or file contents.
- [ ] Manual run, cron toggle, logs, editing, reordering, and updates pass.
- [ ] Git worktree is clean and contains no secrets.

Only after this checklist passes should the maintenance window be closed.

## 27. Authoritative references

- [Cloudflare: create a locally managed tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)
- [Cloudflare: tunnel configuration and ingress validation](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)
- [Cloudflare: create a self-hosted Access application](https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/)
- [Cloudflare: enforce MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)
- [Cloudflare: require Access protection by default](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
