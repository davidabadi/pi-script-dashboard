# Hardened Raspberry Pi deployment

1. Back up `/usr/local/bin`, existing config files, logs, `scripts.json`, and `crontab -l`. Keep the backup off the Pi.
2. Create system users and directories:
   - `pi-dashboard` is the non-login service/job account.
   - `pi-dashboard-admins` contains only operators permitted to authenticate through PAM.
   - `/opt/pi-script-dashboard` is owned by `pi-dashboard`; runtime directories follow `deploy/pi-script-dashboard.service`.
3. Copy `deploy/environment.example` to `/etc/pi-script-dashboard/environment`, generate `SESSION_SECRET` with `openssl rand -base64 48`, set the real hostname, and apply owner `root:root` and mode `0600`.
4. Move editable scripts to `/var/lib/pi-script-dashboard/scripts`, configs to `/var/lib/pi-script-dashboard/configs`, logs to `/var/log/pi-script-dashboard`, and locks to `/run/pi-script-dashboard`. Update `/var/lib/pi-script-dashboard/scripts.json` accordingly. Reject migration if any source is a symlink.
5. Install the service, update path/service, root-owned update helper, and logrotate policy from `deploy/`. The update helper must be `root:root` mode `0755`; enable both `pi-script-dashboard.service` and `pi-script-dashboard-update.path`.
6. Replace legacy root cron entries with the `pi-dashboard` user’s crontab. Give backup jobs narrow access to their destinations. Convert reboot or OS-update work into separately reviewed root-owned units; do not place it in an editable script.
7. Configure the named Cloudflare Tunnel from the supplied example. Add a Cloudflare Access self-hosted application first, with a default-deny allow policy for named identities, MFA requirement, an eight-hour Access session, and **Protect with Access** enabled. Add a cache bypass rule for the hostname.
8. Ensure the firewall exposes no dashboard port. Confirm `ss -ltnp` reports only `127.0.0.1:8080` for Node and that the public hostname cannot be reached without Cloudflare Access.
9. Test login, script editing, manual run, cron pause/resume, logs, reordering, and the update path. Confirm a job cannot write outside the managed roots or run root-only commands.

The repository’s original `scripts.json` is copied into the runtime directory only on first start. Migrate its legacy paths before permitting production traffic; legacy `/usr/local/bin`, `/var/log/custom`, and `/etc` paths are deliberately rejected.
