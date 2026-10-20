#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: npm run backup\nStart the installed full-application backup service. For administrator authorization, run: sudo systemctl start pi-script-dashboard-backup.service\nConfiguration: /etc/pi-script-dashboard/backup.json. Includes SQLite; keeps the latest seven verified archives.");
    return 0;
  }
  if (args.length) throw new Error("Individual database backup arguments are no longer supported. Use the full backup service; see --help.");
  if (process.platform !== "linux") throw new Error("Full application backup runs through systemd on the Pi.");
  const result = spawnSync("/usr/bin/systemctl", ["--no-ask-password", "start", "--wait", "pi-script-dashboard-backup.service"], { stdio: "inherit" });
  if (result.error) throw new Error("Could not start the backup service. Run sudo systemctl start pi-script-dashboard-backup.service on the Pi.");
  return result.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
