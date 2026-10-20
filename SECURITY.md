# Security model

This application is a privileged operations console. Access to it must be treated like SSH access to the host.

## Production requirements

- Publish it only through a named Cloudflare Tunnel routed to `127.0.0.1:8080`. Do not open port 8080 on the router or host firewall.
- Keep the worker's reporting listener on `127.0.0.1:8081`, outside the tunnel. It uses per-run credentials and is not a browser endpoint.
- Create a Cloudflare Access self-hosted application for the hostname, use a default-deny identity allowlist, require MFA, and enable **Protect with Access** on the tunnel route.
- Keep PAM enabled through the dedicated `pi-script-dashboard-auth.service` broker. Only Unix users in `pi-dashboard-admins` whose PAM authentication and account checks pass can sign in.
- Run the application as the dedicated `pi-dashboard` service account with the supplied systemd unit.
- Run the independent worker as the same unprivileged account using its supplied unit. Web-service restarts must not stop the worker; stopping the worker uses systemd control-group cleanup for its job children.
- Install `sasl2-bin`, the dedicated root-owned broker unit, and the fixed `/etc/pam.d/pi-script-dashboard` profile from the reviewed release. The packaged authentication broker and fixed reviewed maintenance helpers run as root; Node and editable jobs remain unprivileged.
- Keep `/run/pi-dashboard-auth` owned by `root:pi-dashboard` with mode `0750`. The protected parent controls access to the daemon's socket and prevents replacement; do not make it writable by the application or grant the web account `shadow` access or `sudo`.
- Use a unique random `SESSION_SECRET` of at least 32 bytes. Store the environment file as `root:root` mode `0600`.
- Editable scripts run as `pi-dashboard`, never root. Grant that account only the file, SSH key, and database permissions each backup job needs.
- Root-only behavior must be a fixed, reviewed systemd unit. Do not add user-controlled arguments to a root helper.
- Keep the tmpfiles-managed `/run/pi-script-dashboard` lock directory available independently of the web service. The cron spool is writable inside the web sandbox so the packaged `crontab` helper can update the service user's own schedule; normal filesystem permissions remain in effect. Cron enqueues work; the worker executes both scheduled and manual jobs within its sandbox. Grant narrowly reviewed backup write paths to the worker unit.
- Protect SQLite, its WAL/SHM files, preserved legacy registry, captured logs, and backups under service-owned mode-0700 directories. SQLite is the active registry after explicit migration; never overwrite runtime data with repository examples.
- Install the drain-aware update and full-backup helpers and their Python support modules root-owned. Both use the root-only maintenance lock, preventing a backup from racing an application update. Updates wait for a healthy worker to acknowledge drain and finish active jobs before changing executable files or dependencies. A failed update preserves queued work and leaves dispatch drained for operator review.
- The fixed full-backup unit runs as root to read deployment settings and preserve ownership; it never executes backed-up scripts or sources application environment files. Keep its reviewed code, `/etc/pi-script-dashboard/backup.json`, and any SMTP password file owned by root and not writable by the service account. Configuration/password files use mode `0600`.
- Full archives contain application credentials, SSH keys if included, and private logs. Store archives as root-owned mode `0600` inside a mode-`0700` directory. The default destination is `/var/lib/pi-script-dashboard/backups/pi-dashboard`; old backups are excluded from new archives. The independent failure-mail unit can report a destination or disk-space failure using the existing outgoing-mail setup.

Cloudflare Access is mandatory even though PAM remains enabled. A Tunnel without an Access application publishes the hostname without an identity gate.

## Security behavior

- Sessions use secure, HTTP-only, same-site cookies; expire after 30 idle minutes; and have a 12-hour absolute lifetime.
- `/api/events` requires the authenticated session and rejects cross-origin streams. The SPA keeps one active stream per browser view; connection counts and output buffering are bounded. Logout closes that session's streams, and open streams revalidate session expiry without renewing idle activity. Keepalive comments carry no application state.
- All mutations require an authenticated session, same-origin request, and CSRF token.
- Login attempts are limited per username and client IP.
- Scripts, configs, logs, and locks are restricted to configured roots; traversal and symlink paths are rejected.
- Script/config content is size-limited, cron expressions are validated, and cron commands quote every path.
- Security-relevant events are appended to `audit.jsonl`; credentials, tokens, session identifiers, and file contents are excluded.
- Local hook credentials expire when their run finishes; requests require a unique event ID and are limited to 32 KiB. Retries are deduplicated. Do not print injected hook tokens in script output, audit events, or support reports.
- Browser log text is escaped. Scripts can still emit secrets into logs; protect access and review outputs before sharing them.
- Event streams expose the same public status/history/log fields as authenticated API reads. Per-run hook credentials stay private. A `Last-Event-ID` log byte cursor is scoped to the selected run; reconnects read current SQLite state and captured logs rather than trusting notification contents.
- Cross-process change notifications use a private bounded signal file beside SQLite and filesystem watches on managed directories. The signal contains only a random wakeup token; it is not a registry, event journal, or backup requirement. SQLite and captured log files remain authoritative.

Deployment, migration, full application backups, recovery, and acceptance checks are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Reporting

Do not open a public issue for a suspected vulnerability. Contact the repository owner privately and include reproduction steps, impact, and affected commit.
