# Pi Script Dashboard deployment and operations

This repository contains a hardened web console for running and scheduling maintenance scripts on a Raspberry Pi. The dashboard is intentionally designed as a private administration service:

- the Node process listens only on `127.0.0.1:8080`;
- Cloudflare Tunnel publishes that loopback service;
- Cloudflare Access with MFA is the first authentication gate;
- a dedicated PAM authentication broker plus membership in `pi-dashboard-admins` is the second gate;
- editable jobs run as the unprivileged `pi-dashboard` account;
- scripts, configs, logs, locks, sessions, and runtime metadata are confined to dedicated directories.

This is the complete upgrade and deployment runbook. SQLite is the active registry; the independent worker runs jobs and accepts local reports on `127.0.0.1:8081`. The web service remains on `127.0.0.1:8080`. Read it once before running commands. Do not skip a red-flag check: each one is a stop condition until understood and resolved.

## SQLite release: choose the correct starting point

For a fresh installation, use the numbered runbook below, record old-service/metadata steps as not applicable instead of creating dummy inputs, skip legacy job copies/registry creation in Step 13 and legacy schedules in Step 15, and initialize an empty database with `bin/migrate.js --sync-only` before starting services. No JSON registry is needed. Add jobs through the dashboard after security acceptance.

For an existing hardened deployment with jobs already under the managed roots:

1. Read the rollback and backup procedures below. Record the deployed commit, root-owned units, environment, complete service-user crontab, each managed job’s original active/paused state, and current runtime `scripts.json`. Back them up to the private off-device destination before changing schedules. Do not print config contents or tokens.
2. Disable the update watcher and stop the old web service to prevent new manual actions. Before waiting for jobs, use `sudo crontab -u pi-dashboard -e` to comment out only recognized dashboard-owned service-user entries; preserve unrelated entries, existing paused lines, and root cron. Compare against the saved table and keep the original active/paused record. Stopping the website alone does not stop direct legacy cron. Once owned triggers are paused, wait for every old job to finish before changing the checkout or importing. If this release’s worker already exists, use its drain procedure before stopping it. The importer never reads or rewrites root cron.
3. Install the reviewed checkout and Node 24 dependencies, and install the worker, web, update helper, and watcher units from Step 12. Retain existing environment values; add `DB_FILE=/var/lib/pi-script-dashboard/dashboard.sqlite`, `HOOK_PORT=8081`, `RETENTION_DAYS=30`, and `MAX_LOG_BYTES=10485760`. `DATA_FILE` now identifies only the legacy importer input.
4. Run the importer explicitly as the service user (from the Pi):

   ```bash
   sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/migrate.js \
     --db /var/lib/pi-script-dashboard/dashboard.sqlite \
     --legacy /var/lib/pi-script-dashboard/scripts.json
   sudo -u pi-dashboard crontab -l
   ```

5. The importer backs up the original registry and entire service-user crontab, validates managed paths and recognized commands, imports permanent job IDs and paused schedules, then rewrites only recognized managed entries to the enqueue CLI. It preserves unrelated entries and never changes script/config contents. Resolve an ambiguous marker/path/command rather than bypassing validation. A failed cutover keeps dispatch disabled; rerun the same command to resume. A completed rerun does not duplicate jobs or replace newer database edits.
6. Copy the importer backup to protected off-device storage. The newly imported schedules remain paused for acceptance. Enable the worker and web service, verify both loopback listeners, and perform Step 21. Only after acceptance restore the originally active schedules using the dashboard, retain originally paused schedules, and re-enable the update watcher. SQLite is authoritative after cutover; keep the preserved JSON and pre-pause crontab backup for recovery.

For a legacy deployment with scripts outside the managed roots, follow all numbered steps, including copies and security review of scripts/configs. Step 15 intentionally stages old-format entries paused so Step 16 can import and rewrite them before worker dispatch starts. Root schedules must be disabled before the new worker starts.

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

Do not put any of the following in Git, GitHub issues, screenshots, chat messages, or repository documentation:

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

- `status --short` lists only the intentional security/deployment changes described in this runbook.
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
sudo ss -ltnp '( sport = :8080 or sport = :8081 )' || true
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
  util-linux \
  xz-utils
```

What to expect: packages install successfully and `apt-get` exits with status 0.

Verify:

```bash
git --version
curl --version | head -n 1
openssl version
python3 --version
dpkg-query -W sasl2-bin cron logrotate util-linux
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
sudo tar --no-same-owner -xJf "$NODE_ARCHIVE" -C /opt
NODE_BIN_DIR="/opt/$NODE_DIR/bin"

"$NODE_BIN_DIR/node" --version
env PATH="$NODE_BIN_DIR:/usr/bin:/bin" "$NODE_BIN_DIR/npm" --version
readlink -f "$NODE_BIN_DIR/node"
stat -c '%U %G %a %n' "$NODE_BIN_DIR/node"
```

What to expect:

- The archive name resembles `node-v24.x.y-linux-arm64.tar.xz`.
- Checksum verification prints `OK`.
- The versioned `node --version` starts with `v24.`; the old service's Node installation is unchanged during preparation.
- `readlink` resolves beneath `/opt/node-v24...`.
- The installed Node binary is owned by `root root`; archive ownership is not restored onto the Pi.

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
sudo -u pi-dashboard -H env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" --prefix /opt/pi-script-dashboard ci
sudo -u pi-dashboard -H env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" --prefix /opt/pi-script-dashboard run check
sudo -u pi-dashboard -H env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" --prefix /opt/pi-script-dashboard run audit:production
sudo -u pi-dashboard git -C /opt/pi-script-dashboard diff --exit-code -- public/tailwind.css
```

What to expect:

- `npm ci` reports a clean install from `package-lock.json`.
- The test command reports all tests passing.
- The production audit reports `found 0 vulnerabilities`.
- The checked-in stylesheet is unchanged.

Deploy the checked-in `public/tailwind.css` from the reviewed release. Run `npm run build:css` during release preparation, review the resulting asset, and commit it with the release. Tailwind's automatic source detection also scans eligible project text beyond the explicit template sources, so documentation, tests, and other checkout files can affect a rebuild. A byte-for-byte rebuild comparison is not a deployment requirement. [Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files)

Red flags — stop if:

- npm modifies `package-lock.json` during `npm ci`;
- any test fails;
- the audit reports a high or critical vulnerability;
- dependency installation or tests unexpectedly modify the checked-in stylesheet.

Remove development-only packages after validation. The authentication broker is installed and tested separately in Step 12:

```bash
sudo -u pi-dashboard -H env PATH="$NODE_BIN_DIR:/usr/bin:/bin" \
  "$NODE_BIN_DIR/npm" --prefix /opt/pi-script-dashboard prune --omit=dev
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
DB_FILE=/var/lib/pi-script-dashboard/dashboard.sqlite
# Legacy importer input only.
DATA_FILE=/var/lib/pi-script-dashboard/scripts.json
HOOK_PORT=8081
RETENTION_DAYS=30
MAX_LOG_BYTES=10485760
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

Run on the **Pi**. The administrator does not need to enter the service account's private checkout; `sudo install` reads the absolute source paths:

```bash
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-auth.service \
  /etc/systemd/system/pi-script-dashboard-auth.service
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard.pam \
  /etc/pam.d/pi-script-dashboard
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard.tmpfiles \
  /etc/tmpfiles.d/pi-script-dashboard.conf
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard.service
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-worker.service \
  /etc/systemd/system/pi-script-dashboard-worker.service
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.path
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-update.service \
  /etc/systemd/system/pi-script-dashboard-update.service
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-update \
  /usr/local/libexec/pi-script-dashboard-update
sudo install -o root -g root -m 0755 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-backup \
  /usr/local/libexec/pi-script-dashboard-backup
sudo install -d -o root -g root -m 0755 \
  /usr/local/libexec/pi-script-dashboard-backup-support
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/backup_settings.py \
  /opt/pi-script-dashboard/deploy/backup_notification.py \
  /opt/pi-script-dashboard/deploy/backup_archive.py \
  /usr/local/libexec/pi-script-dashboard-backup-support/
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-backup.service \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-backup.timer \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard-backup-failure.service \
  /etc/systemd/system/
sudo install -o root -g root -m 0644 \
  /opt/pi-script-dashboard/deploy/pi-script-dashboard.logrotate \
  /etc/logrotate.d/pi-script-dashboard

sudo systemd-analyze verify \
  /etc/systemd/system/pi-script-dashboard-auth.service \
  /etc/systemd/system/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard-worker.service \
  /etc/systemd/system/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.service \
  /etc/systemd/system/pi-script-dashboard-backup.service \
  /etc/systemd/system/pi-script-dashboard-backup.timer \
  /etc/systemd/system/pi-script-dashboard-backup-failure.service
sudo logrotate --debug /etc/logrotate.d/pi-script-dashboard
```

What to expect:

- `install` prints nothing.
- `systemd-analyze verify` returns successfully without unit errors.
- logrotate debug mode explains what it would rotate but does not rotate files.

Red flags — stop if:

- an update/backup helper or its Python support modules are writable by `pi-dashboard` or any non-root user;
- the broker unit or PAM profile is writable by a non-root user;
- a unit runs the web application as root;
- web/worker `ExecStart` does not point to `/usr/local/bin/node`, or a root maintenance unit invokes code from the service-owned checkout;
- systemd reports unknown directives or invalid paths;
- logrotate rejects the configuration.

Inspect permissions:

```bash
stat -c '%U %G %a %n' \
  /etc/systemd/system/pi-script-dashboard-auth.service \
  /etc/pam.d/pi-script-dashboard \
  /etc/tmpfiles.d/pi-script-dashboard.conf \
  /etc/systemd/system/pi-script-dashboard.service \
  /etc/systemd/system/pi-script-dashboard-worker.service \
  /etc/systemd/system/pi-script-dashboard-update.path \
  /etc/systemd/system/pi-script-dashboard-update.service \
  /usr/local/libexec/pi-script-dashboard-update \
  /usr/local/libexec/pi-script-dashboard-backup \
  /usr/local/libexec/pi-script-dashboard-backup-support/*.py \
  /etc/systemd/system/pi-script-dashboard-backup.service \
  /etc/systemd/system/pi-script-dashboard-backup.timer \
  /etc/systemd/system/pi-script-dashboard-backup-failure.service \
  /etc/logrotate.d/pi-script-dashboard
```

Expected: every file is owned by `root root`; units/logrotate/Python support modules are `644`; executable helpers are `755`. Install and validate the root-private backup/mail configuration in **Full application backups** before enabling the timer or using the update helper.

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
  /run/pi-script-dashboard \
  /run/pi-script-dashboard-maintenance
```

What to expect: application state/log/runtime directories are owned by `pi-dashboard pi-dashboard` with mode `700`; `/run/pi-script-dashboard-maintenance` is owned by `root root` with mode `700`.

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

## 13. Legacy transition only: migrate editable jobs into restricted directories

This step is only for migration from a legacy installation. Fresh installations start empty; already-hardened installations must preserve their actual runtime JSON and use the importer instead of replacing it.

The hardened dashboard rejects the legacy locations `/usr/local/bin`, `/var/log/custom`, `/etc/*.lock`, and `/home/pi/backup-configs`. It accepts only:

| Type | New location | Mode |
|---|---|---:|
| Scripts | `/var/lib/pi-script-dashboard/scripts/*.sh` | `0700` |
| Configs | `/var/lib/pi-script-dashboard/configs/*.{conf,json,yaml,yml}` | `0600` |
| Logs | `/var/log/pi-script-dashboard/*.log` | `0600` |
| Locks | `/run/pi-script-dashboard/*.lock` | runtime |
| Active registry | `/var/lib/pi-script-dashboard/dashboard.sqlite` (plus WAL/SHM) | `0600` |
| Legacy import input | `/var/lib/pi-script-dashboard/scripts.json` | `0600` |

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

Legacy migration only: create the importer input registry. This deliberately excludes the legacy `Update + Reboot` job:

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

Expected: `scripts.json valid`. This validates only the one-time importer input. Do not edit or recreate this file after SQLite cutover; manage active jobs through the dashboard.

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

The worker systemd sandbox makes the host filesystem read-only to all job children except for its explicitly writable application directories. The web service separately permits `/var/spool/cron/crontabs` for schedule synchronization. The unit grants `SupplementaryGroups=crontab` and explicitly keeps `NoNewPrivileges=true`: several sandbox settings already imply that restriction, so Debian's helper cannot rely on gaining its packaged setgid privilege. The service-only group allows it to update this account's schedule. Keep the spool root-owned with group `crontab` and mode `1730`, and user crontabs mode `0600`; the sticky bit and file ownership protect existing other-user tables. Do not add the account to that group globally or loosen spool permissions. Before enabling schedules, test comments-only create, list, replace and removal from a transient service with the same sandbox, and confirm `crontab -u root -l` is denied. If a backup job must write to a mounted destination outside `/var/log/pi-script-dashboard` or `/var/lib/pi-script-dashboard`, explicitly allow only that destination with a systemd drop-in. Cron entries now enqueue only; the independent worker executes scheduled and manual jobs in the same sandbox. Apply job data-path exceptions to the worker unit, not the web unit.

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
  /etc/systemd/system/pi-script-dashboard-worker.service.d
sudo tee /etc/systemd/system/pi-script-dashboard-worker.service.d/backup-paths.conf >/dev/null <<EOF
[Service]
ReadOnlyPaths=$BACKUP_SOURCE
ReadWritePaths=$BACKUP_DESTINATION
EOF
sudo chmod 0644 /etc/systemd/system/pi-script-dashboard-worker.service.d/backup-paths.conf
sudo systemd-analyze verify /etc/systemd/system/pi-script-dashboard-worker.service
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

## 15. Move legacy schedules from root cron to the service account

Skip this staging step for fresh installations and existing hardened deployments. Their importer operates on the actual service-user crontab. These legacy commands are temporary importer input; they must be rewritten to enqueue commands before dispatch.

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

Expected: the four managed lines, all commented out, plus preserved service-user lines. Do not discard existing unrelated entries when installing the staged table; merge them into the reviewed temporary file first. Leave the old root schedules unchanged until the cutover in Step 16. Do not activate the new schedules while the corresponding root jobs are active.

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
sudo ss -ltnp '( sport = :8080 or sport = :8081 )'
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

Expected: `v24.x.y`. Keep the `node-commands` backup for rollback. Before enabling worker dispatch, import the actual managed legacy registry and service-user crontab:

```bash
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/migrate.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite \
  --legacy /var/lib/pi-script-dashboard/scripts.json
sudo -u pi-dashboard crontab -l
```

Fresh installation only, with no runtime legacy registry:

```bash
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/migrate.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite --sync-only
```

Expected: migration completes, the registry backup remains preserved, and each managed cron command invokes `/usr/local/bin/node /opt/pi-script-dashboard/bin/enqueue.js --db ... --job <permanent UUID>`. Imported paused states are retained. If migration fails, leave the worker stopped, resolve the reported problem, and rerun the exact command. Do not edit SQLite manually or delete migration records. A partial migration does not allow dispatch.

Enable the broker, worker, update watcher, and dashboard:

```bash
sudo systemctl daemon-reload
sudo systemd-tmpfiles --create /etc/tmpfiles.d/pi-script-dashboard.conf
sudo systemctl enable --now pi-script-dashboard-auth.service
sudo systemctl enable --now pi-script-dashboard-update.path
sudo systemctl enable --now pi-script-dashboard-worker.service
sudo systemctl enable --now pi-script-dashboard.service
sudo systemctl status pi-script-dashboard.service --no-pager --full
sudo systemctl status pi-script-dashboard-worker.service --no-pager --full
sudo systemctl status pi-script-dashboard-auth.service --no-pager --full
sudo systemctl status pi-script-dashboard-update.path --no-pager --full
```

What to expect:

- All four units are `active`.
- Dashboard service shows `Main PID` owned by `pi-dashboard`.
- The log says `Server running on 127.0.0.1:8080`.

Inspect recent logs:

```bash
sudo journalctl -u pi-script-dashboard.service --since '-5 minutes' --no-pager
sudo ss -ltnp '( sport = :8080 or sport = :8081 )'
```

Expected listeners: web at `127.0.0.1:8080`, hooks at `127.0.0.1:8081`. Never `0.0.0.0:8080`, `[::]:8080`, or the Pi LAN address.

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
sudo systemd-analyze security pi-script-dashboard.service pi-script-dashboard-worker.service --no-pager
sudo -u pi-dashboard test ! -w /etc && echo '/etc is not writable by service user'
sudo -u pi-dashboard test -w /var/lib/pi-script-dashboard && echo 'state directory is writable'
sudo -u pi-dashboard test -w /var/log/pi-script-dashboard && echo 'log directory is writable'
```

Red flags: service runs as root, has broad capabilities, can write `/etc`, or cannot write its dedicated state/log directories.

## 17. Close direct network access to ports 8080 and 8081

The web and hook listeners are loopback-only; retain a firewall defense for both ports. Never route port 8081 through Cloudflare Tunnel or Access. The only public origin remains `http://127.0.0.1:8080`.

Check whether UFW is active:

```bash
sudo ufw status verbose 2>/dev/null || true
```

If UFW is already active, deny port 8080:

```bash
sudo ufw deny 8080/tcp
sudo ufw deny 8081/tcp
sudo ufw status numbered
```

If UFW is not currently active, do not enable it remotely until SSH is explicitly allowed:

```bash
sudo ufw allow OpenSSH
sudo ufw deny 8080/tcp
sudo ufw deny 8081/tcp
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
- For the four-job legacy example, confirm those four migrated jobs appear; otherwise compare with the actual migration record. A fresh installation starts empty.
- Confirm `Update + Reboot` does not appear.
- Open each log.

Red flags: a legacy path warning, server error, missing CSS/editor asset, CSP errors in browser developer tools, or another user’s cached content.

### 21.2 Edit validation

- Open one job for editing without saving.
- Confirm its script/config/log/lock paths are under the managed roots.
- Attempt to change a path to `/etc/test.sh` and submit.
- Confirm Save stays disabled if the Monaco editor fails to load; fix the asset/network error and reload instead of enabling Save manually.

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
sudo journalctl -u pi-script-dashboard-worker.service --since '-10 minutes' --no-pager
sudo tail -n 100 /var/log/pi-script-dashboard/REPLACE_WITH_JOB_LOG.log
ps -eo user,pid,ppid,cmd | grep -E '[b]ackup_|[p]i-script-dashboard'
```

Expected:

- job process owner is `pi-dashboard`, not root;
- the worker tracks an active run; any script-owned lock remains the script’s responsibility;
- the log is updated;
- the recorded outcome reflects the actual process exit code with narrowly granted permissions: exit 0 succeeds, nonzero fails, and an otherwise successful run with a partial report is partial; log words or emoji do not decide the outcome;
- logs/status refresh every two seconds, history contains timestamps/duration, and renaming preserves past runs;
- restarting only the web service leaves the worker job and reporting hook alive;
- an enqueue CLI trigger works while the web service is stopped;
- duplicate triggers show already queued/running, with skipped cron attempts in history.

Red flags: process runs as root, credentials appear in logs, lock remains after completion, job writes legacy paths, or permissions are broadened as a workaround.

### 21.5 Reordering

- Enter reorder mode, move one card, save, and refresh.
- Confirm order persists.
- Inspect only the database job names and order, without printing configs:

```bash
sudo -u pi-dashboard /usr/local/bin/node -e \
  "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('/var/lib/pi-script-dashboard/dashboard.sqlite',{readOnly:true}); console.table(d.prepare('SELECT name,position FROM jobs ORDER BY position').all()); d.close()"
```

Red flag: jobs disappear, duplicates appear, or unrelated fields change.

### 21.6 Update path

Complete **Full application backups** below first: install the private configuration, confirm failure-mail delivery, and verify one manual full archive. The update helper requires that backup procedure before changing application files.

Click **Update dashboard** once. Watch:

```bash
sudo journalctl -u pi-script-dashboard-update.service -f
```

Then verify:

```bash
sudo systemctl status pi-script-dashboard-update.service --no-pager --full
sudo systemctl status pi-script-dashboard.service --no-pager --full
sudo systemctl status pi-script-dashboard-worker.service --no-pager --full
sudo test ! -e /var/lib/pi-script-dashboard/update.request && echo 'request cleared'
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/control.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite status
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
```

Expected: status first reports waiting while an active job finishes; no checkout/dependency change happens before drain acknowledgement. A root-owned maintenance lock prevents concurrent updates or full backups. Queued jobs remain queued; a verified full application archive in the configured backup directory precedes the fast-forward pull and `npm ci --omit=dev --ignore-scripts`; both services restart and queued work resumes. The request is removed and durable status is succeeded. The lock file may remain; kernel lock ownership, not file existence, controls exclusivity.

Red flags: update runs concurrently, changes files before active jobs finish, loses queued work, Git reports divergence, dependency installation fails, or services do not restart. A drain timeout or failure leaves durable failed status and the worker drained. Inspect the updater journal, repair or roll back, and explicitly resume only after validation.

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
sudo systemctl disable --now pi-script-dashboard.service pi-script-dashboard-worker.service
sudo systemctl disable --now pi-script-dashboard-update.path
sudo systemctl disable --now pi-script-dashboard-auth.service
sudo ss -ltnp '( sport = :8080 or sport = :8081 )' || true
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
sudo ss -ltnp '( sport = :8080 or sport = :8081 )' || true
sudo crontab -l
sudo -u pi-dashboard crontab -l 2>&1 || true
```

Red flags: duplicate cron schedules, two dashboard processes, public direct access to port 8080, or an unprotected Cloudflare hostname.

## 24. Routine operations after deployment

### Application update

Every update must use the drain-aware helper; do not run `git pull` or replace dependencies while the worker has active children. A failed update leaves queued work intact and drain enabled. After repair or rollback, validate the worker and run `bin/control.js --db /var/lib/pi-script-dashboard/dashboard.sqlite resume` as `pi-dashboard`.

Prefer the dashboard update button after deployment prerequisites are installed. The update helper does not install root-owned units, PAM profiles, or tmpfiles rules. For the first SQLite/worker release, complete the explicit migration above and install the new root-owned worker/update/backup helpers and units before using the update button. A helper from an older release cannot safely update this release. Configure and validate the full backup and failure-mail settings below; updates require the same complete backup and do not create a separate routine database-only backup. Backup crontab capture and update schedule synchronization use the service user's permissions with the required `crontab` group; global account membership is unnecessary. Keep `sasl2-bin` and the Step 12 authentication broker in place and pass its socket login test. Review and install changes to those root-owned deployment files manually for future releases as well.

Before updating:

```bash
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
sudo -u pi-dashboard git -C /opt/pi-script-dashboard fetch origin
sudo -u pi-dashboard git -C /opt/pi-script-dashboard log --oneline --decorate HEAD..origin/main
```

Expected: clean working tree and only reviewed commits pending.

### Worker drain and recovery

To pause new claims while allowing active jobs to finish:

```bash
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/control.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite drain
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/control.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite --timeout 900 wait-idle
```

`wait-idle` requires a recent worker heartbeat, acknowledged idle state, and zero running database rows. An old heartbeat or missing worker must not count as successful draining. A timeout leaves dispatch paused; queued jobs stay durable. Inspect the worker journal and finish/recover interrupted runs before retrying. After a verified update or backup:

```bash
sudo -u pi-dashboard /usr/local/bin/node /opt/pi-script-dashboard/bin/control.js \
  --db /var/lib/pi-script-dashboard/dashboard.sqlite resume
```

A web restart preserves jobs and hook reports. A worker restart or reboot marks unfinished running jobs interrupted and does not automatically retry them. Script-owned lock files are displayed but never deleted by worker coordination; inspect a stale lock according to the script's own recovery procedure before triggering a replacement run.

### Recovering an interrupted script/config edit

A failed or interrupted file edit can leave a private recovery manifest and original file copies under `/var/lib/pi-script-dashboard/edit-recovery`, recorded by the database’s `content_recovery` setting. Dispatch stays blocked by pending schedule synchronization, and cron synchronization refuses to continue until recovery finishes. Keep those files private; do not print their contents, remove the directory, or clear the settings manually.

1. Inspect the web-service journal for the failure and resolve filesystem/disk permission problems. Keep queued runs intact. If a run is still executing, wait for it to finish; restoring original files is refused while runs are active.
2. Sign in to the dashboard and use **Recover interrupted edit** (`POST /recover-edit`) to restore the saved original script/config contents rather than the failed changes. Queued runs do not prevent recovery. If restoration fails or originals are missing/corrupt, preserve and back up the recovery files, then investigate the journal without dumping scripts, configs, or credentials; do not bypass the recovery marker.
3. After restoration succeeds, review the job metadata and use **Retry schedule sync** explicitly. Confirm the recovery warning clears, schedules match the recorded paused states, and a harmless validation run works before editing again.

If Monaco fails to load, Save remains disabled so an unavailable editor cannot overwrite a script/config with empty content. Restore the editor assets/network connection and reload; do not bypass the disabled control.

### Full application backups

The full-backup service runs weekly on Sunday at **03:00 America/New_York**, with up to five minutes of scheduling jitter. `Persistent=true` catches a missed run after the Pi starts again. Each successful run publishes one verified archive and checksum under `/var/lib/pi-script-dashboard/backups/pi-dashboard`; only the newest **seven complete backups** are retained. A failed run does not prune good backups. Both scheduled and manual service failures start the independent failure-email unit. There is no separate weekly database backup: the full archive already contains a consistent database snapshot.

The helper takes the same root-owned maintenance lock as the updater, drains active jobs, records the existing service/drain state, stops the web service, worker, and update watcher for the snapshot, and restores their previous state afterward, including when a recoverable backup error occurs. Cron may keep enqueueing while the website is stopped; queued work remains in the live database. A drain timeout fails without killing an active job. Inspect the journal after a failed run, especially if restoring services also failed.

The archive contains:

- A SQLite online snapshot, the service-user crontab, and backup metadata under `backup-metadata/`. Committed WAL data is included in the snapshot; raw live database/WAL/SHM files are excluded.
- Managed scripts/configs, retained logs/run captures, runtime application data, and application code with its package lock and recorded Git commit when available. Old backups, sessions, transient locks, `.git`, and `node_modules` are excluded.
- `/etc/pi-script-dashboard`, reviewed dashboard unit files/drop-ins, the PAM profile, tmpfiles/logrotate rules, and installed root-owned maintenance helpers. Standard `/etc/cloudflared` tunnel configuration, its service, and common local mail configuration are included when present. Additional private paths outside these locations, such as external job SSH keys, must be listed in `extra_paths`.

The destination and archives are root-private (`0700` directory, `0600` files); archives contain credentials and must not be put in Git or shared support logs. This is an application backup, not an operating-system image. The default destination is on the Pi's local filesystem; use the Step 5 private-copy/checksum procedure if you also want a separate off-device copy.

#### Install the private configuration

Install the root-owned helpers, Python support modules, units, and tmpfiles rule from Step 12 first. Python 3 and the existing Node 24 runtime are required. Copy the example only if a real configuration does not already exist:

```bash
sudo test -e /etc/pi-script-dashboard/backup.json || \
  sudo install -o root -g root -m 0600 \
    /opt/pi-script-dashboard/deploy/backup.example.json \
    /etc/pi-script-dashboard/backup.json
sudoedit /etc/pi-script-dashboard/backup.json
sudo stat -c '%U %G %a %n' /etc/pi-script-dashboard/backup.json
```

Set `backup_directory` to `/var/lib/pi-script-dashboard/backups/pi-dashboard`, `keep` to `7`, and the mail recipient to your chosen failure-alert address. Retain the default runtime/repository paths unless the actual installation uses different locations. The root-owned configuration uses `mail.transport: "auto"` to reuse an installed `sendmail`-compatible command or `msmtp` and its existing outgoing-mail configuration. Check availability without printing configuration or credentials:

```bash
command -v sendmail || command -v msmtp
```

For explicit SMTP instead, choose `mail.transport: "smtp"`, configure `smtp_host`, `smtp_port`, `smtp_security` (`starttls` or `tls`), `from`, and `to`. If authentication is required, set `smtp_username` and `smtp_password_file`; create that password file directly on the Pi with `sudoedit`, owned by root with mode `0600`. Do not paste the password into chat, commit it, or put it on a command line. Leave SMTP unset when using the existing outgoing-mail setup.

Review `extra_paths` for application-owned dependencies outside the default state/config, tunnel, and mail locations. Include a specific external SSH directory/key path only when it belongs to an application job. Do not add `/`, `/root`, whole user homes, unrelated root keys, or the backup destination. Extra paths are backed up as data; they are never sourced or executed. A custom backup/state/log path outside the default writable roots also needs an explicit, reviewed `ReadWritePaths` drop-in for the backup service.

The backup configuration, any SMTP password file, and their parent directory chain must be root-owned, without symlinks or non-root write permission. The helper refuses unsafe configuration. An unresolved script/config edit recovery marker also blocks a normal backup: finish **Recovering an interrupted script/config edit** before retrying. If originals are missing or a recovery journal is corrupt, stop writers and preserve a private forensic copy of the database/WAL/SHM and full `edit-recovery` directory for investigation; do not remove the marker to force a successful backup.

#### Verify mail, run once, then enable the timer

The following first command deliberately sends a test failure notification through the same path used by a failed scheduled backup. Confirm its arrival in the recipient mailbox; a local mail command accepting a message does not itself prove delivery.

```bash
sudo systemctl daemon-reload
sudo systemd-tmpfiles --create /etc/tmpfiles.d/pi-script-dashboard.conf
sudo /usr/local/libexec/pi-script-dashboard-backup --config /etc/pi-script-dashboard/backup.json --check
sudo systemctl start pi-script-dashboard-backup-failure.service
sudo journalctl -u pi-script-dashboard-backup-failure.service --since '-5 minutes' --no-pager

sudo systemctl start pi-script-dashboard-backup.service
sudo systemctl status pi-script-dashboard-backup.service --no-pager --full
sudo journalctl -u pi-script-dashboard-backup.service --since '-2 hours' --no-pager
sudo ls -lh /var/lib/pi-script-dashboard/backups/pi-dashboard
sudo systemctl status pi-script-dashboard.service pi-script-dashboard-worker.service --no-pager

sudo systemctl enable --now pi-script-dashboard-backup.timer
systemctl list-timers pi-script-dashboard-backup.timer --all
systemd-analyze calendar 'Sun *-*-* 03:00:00 America/New_York'
```

Expected: one `.tar.gz` archive and its `.sha256` file; the web/worker/watcher and drain state match their pre-backup state; the timer reports the next Sunday run in the specified timezone. The helper verifies the archive before publishing it and prunes only recognized complete backups after successful publication. Scheduled, manual, and pre-update full backups share the same seven-backup retention. Do not rename unrelated archives to the managed backup naming pattern. Archive retention is independent of the worker's 30-day run-history retention.

To run an extra full backup at any time, use `sudo systemctl start pi-script-dashboard-backup.service`. The service timeout is two hours, including the configured drain wait (one hour by default). Check the journal while it waits; do not bypass the shared lock or stop the worker to force it. If failure mail cannot be sent, the notification unit fails visibly in `systemctl --failed` and records a sanitized error in its journal. Restore the existing outgoing-mail configuration and rerun the notification unit; message delivery cannot be guaranteed during an SMTP/network outage.

#### Restore the complete application

Restore code, state, configuration, and schedules from the same archive. Do not run older code against a newer schema. Reinstall the supported OS packages, Node 24, and dedicated account/groups from this runbook before recovery onto a replacement Pi. Preserve the failed installation and current service-user crontab privately before replacing files. Keep Cloudflare Access enabled throughout recovery.

1. Disable the backup timer and update watcher. Drain active jobs if the worker is healthy, then stop the web and worker. Save and temporarily remove the service-user crontab to stop enqueue writers; preserve unrelated lines for review. Do not alter root cron. Keep the authentication broker/tunnel unchanged until their saved configuration has been reviewed.
2. Verify the selected archive's `.sha256` in its backup directory. List archive members, then extract into a new root-only staging directory, never over the running installation. For the default backup location:

   ```bash
   sudo systemctl disable --now pi-script-dashboard-backup.timer
   sudo systemctl stop pi-script-dashboard-update.path
   # Drain/wait-idle as above before stopping a healthy worker.
   sudo systemctl stop pi-script-dashboard.service pi-script-dashboard-worker.service
   sudo install -d -o root -g root -m 0700 /root/pi-dashboard-recovery
   sudo sh -c 'crontab -u pi-dashboard -l > /root/pi-dashboard-recovery/current.crontab' || true
   sudo crontab -u pi-dashboard -r
   # Replace the exact archive basename; retain its matching checksum file.
   ARCHIVE='REPLACE_WITH_COMPLETE_ARCHIVE.tar.gz'
   sudo sh -c 'cd /var/lib/pi-script-dashboard/backups/pi-dashboard && sha256sum -c -- "$1.sha256"' sh "$ARCHIVE"
   sudo tar -tzf "/var/lib/pi-script-dashboard/backups/pi-dashboard/$ARCHIVE"
   sudo install -d -o root -g root -m 0700 /root/pi-dashboard-recovery/extracted
   sudo tar --acls --xattrs -xzf "/var/lib/pi-script-dashboard/backups/pi-dashboard/$ARCHIVE" \
     -C /root/pi-dashboard-recovery/extracted
   ```

3. Read `backup-metadata/manifest.json` privately for the recorded source paths, `git_commit`, and `database_original_path`. Preserve the current checkout/state/log directories as forensic copies outside the extraction destination. Since `.git` is excluded, clone the repository as `pi-dashboard` and check out the recorded commit before overlaying its archived application files; this restores the Git metadata needed by the updater. If a commit was unavailable, preserve the exact archived files and establish a reviewed repository baseline before using updates. Restore the runtime scripts/configs/retained logs and reviewed extra paths to their recorded locations with their saved ownership/modes. Exclude the existing backup destination from replacement; keep these archives. Do not merge a restored database with stale destination `-wal`/`-shm` files. Install `backup-metadata/dashboard.sqlite` at the recorded database path as `pi-dashboard:pi-dashboard`, mode `0600`.
4. Restore reviewed `/etc/pi-script-dashboard` files root-owned with their private permissions. Review saved units, drop-ins, PAM/tmpfiles/logrotate rules, maintenance helpers, and optional tunnel/SSH credentials before installing them into their original paths. Preserve the root-owned executable/support-module layout from Step 12; never run a root helper directly from the service-owned checkout. Recreate transient directories with tmpfiles and reinstall dependencies from the archived lockfile with `npm ci --omit=dev --ignore-scripts` as `pi-dashboard`. New sessions will be created on login.
5. Review `backup-metadata/service-user.crontab` against the pre-recovery table and preserve unrelated current lines. Restore the matching dashboard entries as `pi-dashboard`, then run `bin/migrate.js --db /var/lib/pi-script-dashboard/dashboard.sqlite --sync-only` as that user. Snapshot restore rolls back runs queued after the snapshot; review those triggers before enabling schedules.
6. Reload systemd, start the broker, worker, and website, and inspect their journals. Validate login, saved job/history/logs, loopback-only ports, and one harmless manual run. Explicitly resume dispatch only after validation. Restore the original paused schedules and update watcher, test failure mail, run a fresh full backup, and re-enable the weekly timer after it succeeds.

For rollback to the old JSON release, restore the preserved legacy registry and pre-import service-user crontab together and disable the worker. The root-credential, root-cron, tunnel, and Node rollback procedures in Step 23 still apply. Importer recovery backups remain an internal migration safeguard; they do not replace the full application archive.

### Local progress and log reports

The worker injects `DASHBOARD_RUN_ID`, `DASHBOARD_HOOK_URL`, and `DASHBOARD_RUN_TOKEN` into each job. Reports use `POST /api/runs/:runId/events` at the injected loopback URL, an `Authorization: Bearer <token>` header, and JSON:

```json
{"eventId":"step-1","type":"progress","message":"Uploading backup"}
```

`type` is `progress`, `log`, or `partial`. Use a new event ID for each logical event; retry the same ID/payload after a transport failure. Requests are limited to 32 KiB. Credentials and writes are rejected after completion. Hooks report progress or supplemental log text; the process exit code decides success/failure. A partial report only changes an otherwise successful exit to partial. Do not put credentials into report messages or print the injected token.

Jobs select one authoritative captured log source: imported jobs use their configured file, and new jobs default to stdout/stderr. Console output is drained even after the 10 MiB stored-log cap; a truncation indicator is retained. File capture follows replacement and observed truncation and flags gaps. Append-style file logging gives the most reliable history; rapid truncate/rewrite loops can lose bytes between observations, so choose console capture for those scripts. Supplemental hook log messages are additional explicit messages, not a second capture source.

Completed run details and captured logs expire after 30 days by default. Active runs are excluded; each job keeps its latest outcome summary after detail cleanup. The script's original configured log file is independent and remains subject to its logrotate policy. Review retention and access for sensitive output.

### Weekly checks

```bash
sudo systemctl --failed
sudo systemctl status pi-script-dashboard.service pi-script-dashboard-worker.service pi-script-dashboard-auth.service cloudflared.service --no-pager
sudo systemctl status pi-script-dashboard-backup.timer --no-pager
systemctl list-timers pi-script-dashboard-backup.timer --all
sudo journalctl -u pi-script-dashboard-backup.service -u pi-script-dashboard-backup-failure.service --since '-8 days' --no-pager
sudo journalctl -u pi-script-dashboard.service -p warning --since '-7 days' --no-pager
sudo journalctl -u cloudflared.service -p warning --since '-7 days' --no-pager
sudo -u pi-dashboard crontab -l
sudo tail -n 100 /var/log/pi-script-dashboard/audit.jsonl
sudo -u pi-dashboard git -C /opt/pi-script-dashboard status --short
```

Healthy result: no failed units, all four services active, expected managed cron lines with the recorded paused states, no unexplained login failures/actions, and clean Git status.

### Dependency review

From a clean checkout with development dependencies installed:

```bash
sudo -u pi-dashboard -H env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/npm --prefix /opt/pi-script-dashboard ci
sudo -u pi-dashboard -H env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/npm --prefix /opt/pi-script-dashboard run check
sudo -u pi-dashboard -H env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/npm --prefix /opt/pi-script-dashboard run audit:production
sudo -u pi-dashboard -H env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/npm --prefix /opt/pi-script-dashboard prune --omit=dev
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

### `403 Invalid origin` after submitting the login form

Check only the failed request's `Origin` header in browser Developer Tools; do not share cookies or form data. The login document must use `Referrer-Policy: same-origin`. A `no-referrer` policy makes browsers send `Origin: null` for native form POSTs, which the origin guard correctly rejects. Deploy the corrected header, then open a fresh `/login` page before retrying; the already-open document retains its previous policy. Keep null-origin rejection and CSRF validation enabled. See the [Fetch origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header).

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
- [ ] Web listens only on `127.0.0.1:8080`; worker hooks only on `127.0.0.1:8081`, without a tunnel route.
- [ ] SQLite import is complete, JSON/crontab originals are backed up, and cron enqueues permanent job IDs.
- [ ] Worker is independent, unprivileged, and has only required writable data paths.
- [ ] Web restart preserves active runs/hooks; scheduled enqueue works with the web stopped.
- [ ] Updates drain active runs before changing code/dependencies and preserve queued runs.
- [ ] Full-backup helpers/modules/configuration are root-owned; the shared root-only maintenance lock serializes backups and updates.
- [ ] One full archive and its checksum verify successfully; restoration paths/ownership have been reviewed.
- [ ] The weekly Sunday 03:00 America/New_York timer is enabled, keeps seven complete archives, and the failure notification reaches the intended mailbox.
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
- [util-linux runuser: primary and supplementary group options](https://man7.org/linux/man-pages/man1/runuser.1.html)
