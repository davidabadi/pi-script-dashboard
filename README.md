# Pi Script Dashboard

A private Raspberry Pi console for editing, scheduling, and running local maintenance scripts. SQLite stores job definitions and run history; an independent unprivileged worker executes jobs while the authenticated single-page application displays progress and live logs.

- Manual and cron triggers share a durable queue with one queued/running run per job.
- Status comes from actual process exit results, with optional local progress, log, and partial-outcome hooks.
- One authenticated server-sent event connection pushes status, run history, and incremental logs when they change. Dashboard, editor, and log navigation stay in the SPA; reconnects resume captured logs from their byte cursor.
- Jobs choose configured file logs or captured stdout/stderr. Completed run details/logs retain 30 days by default, with a 10 MiB capture cap per run; each job keeps its latest outcome summary.
- Renaming preserves job IDs and history. Script/config files and captured logs stay on disk.
- Full application backups run weekly, keep the last seven verified archives in `/var/lib/pi-script-dashboard/backups/pi-dashboard`, and email on failure using the Pi's existing outgoing-mail configuration. Each archive includes a consistent SQLite snapshot, scripts/configs, logs, application code, and deployment settings.

Production requires Node.js 24, Linux/systemd, a dedicated `pi-dashboard` account, Cloudflare Tunnel and Access with MFA, and the supplied PAM authentication broker. Web listens on `127.0.0.1:8080`; worker reporting hooks listen only on `127.0.0.1:8081`. Editable jobs never run as root.

Read the complete [deployment, migration, operations, and rollback runbook](DEPLOYMENT.md) before installing or upgrading. It includes the required security checks and backup commands. See [SECURITY.md](SECURITY.md) for the security model.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run audit:production
```

Use Node 24 for development and CI; SQLite uses `node:sqlite` without a database dependency. The checked-in `public/tailwind.css` is the production asset; regenerate it with `npm run build:css` only when changing styles.

The web process (`node server.js`) and worker (`node worker.js`) are separate services. Runtime paths and defaults are documented in [deploy/environment.example](deploy/environment.example). A fresh installation starts with an empty SQLite database; add jobs through the dashboard.

The browser subscribes to `/api/events`. Filesystem notifications carry committed database changes and captured-log writes between the worker, cron CLI, and web process. Keepalive comments maintain the open connection without requesting status or logs. Local script reporting hooks remain on the worker's private loopback listener.

## Existing installations

SQLite replaces `scripts.json` as the active registry. Run `node bin/migrate.js --help` for the explicit importer, which backs up the actual runtime JSON and service-user crontab, validates managed paths, and rewrites recognized cron entries to enqueue by permanent job ID. Follow the runbook for first cutover; migration must complete before worker dispatch.

The worker owns local reporting hooks and jobs independently of the website. See the runbook for the hook contract, capture limitations, safe draining, and [weekly backup setup and recovery](DEPLOYMENT.md#full-application-backups). Configure the failure-mail recipient before enabling the backup timer; private settings belong in root-private files on the Pi.
