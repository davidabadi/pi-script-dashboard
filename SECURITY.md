# Security model

This application is a privileged operations console. Access to it must be treated like SSH access to the host.

## Production requirements

- Publish it only through a named Cloudflare Tunnel routed to `127.0.0.1:8080`. Do not open port 8080 on the router or host firewall.
- Create a Cloudflare Access self-hosted application for the hostname, use a default-deny identity allowlist, require MFA, and enable **Protect with Access** on the tunnel route.
- Keep PAM enabled through the dedicated `pi-script-dashboard-auth.service` broker. Only Unix users in `pi-dashboard-admins` whose PAM authentication and account checks pass can sign in.
- Run the application as the dedicated `pi-dashboard` service account with the supplied systemd unit.
- Install `sasl2-bin`, the dedicated root-owned broker unit, and the fixed `/etc/pam.d/pi-script-dashboard` profile from the reviewed release. Only the packaged authentication daemon runs as root; Node and editable jobs remain unprivileged.
- Keep `/run/pi-dashboard-auth` owned by `root:pi-dashboard` with mode `0750`. The protected parent controls access to the daemon's socket and prevents replacement; do not make it writable by the application or grant the web account `shadow` access or `sudo`.
- Use a unique random `SESSION_SECRET` of at least 32 bytes. Store the environment file as `root:root` mode `0600`.
- Editable scripts run as `pi-dashboard`, never root. Grant that account only the file, SSH key, and database permissions each backup job needs.
- Root-only behavior must be a fixed, reviewed systemd unit. Do not add user-controlled arguments to a root helper.
- Keep the tmpfiles-managed `/run/pi-script-dashboard` lock directory available independently of the web service. The cron spool is writable inside the web sandbox so the packaged setgid `crontab` helper can update the service user's own schedule; normal filesystem permissions remain in effect. Cron-launched jobs use ordinary Unix permissions outside the web unit's sandbox.

Cloudflare Access is mandatory even though PAM remains enabled. A Tunnel without an Access application publishes the hostname without an identity gate.

## Security behavior

- Sessions use secure, HTTP-only, same-site cookies; expire after 30 idle minutes; and have a 12-hour absolute lifetime.
- All mutations require an authenticated session, same-origin request, and CSRF token.
- Login attempts are limited per username and client IP.
- Scripts, configs, logs, and locks are restricted to configured roots; traversal and symlink paths are rejected.
- Script/config content is size-limited, cron expressions are validated, and cron commands quote every path.
- Security-relevant events are appended to `audit.jsonl`; credentials, tokens, session identifiers, and file contents are excluded.

## Reporting

Do not open a public issue for a suspected vulnerability. Contact the repository owner privately and include reproduction steps, impact, and affected commit.
