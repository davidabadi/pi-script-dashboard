#!/usr/bin/env node
"use strict";

const { Store } = require("../lib/store");
const { readConfig } = require("../lib/config");
const fs = require("node:fs");

function parseArgs(args) {
  const options = { db: readConfig().dbFile, timeout: 900 };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (["--db", "--timeout"].includes(args[i])) {
      const flag = args[i];
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[flag.slice(2)] = args[++i];
    } else if (args[i].startsWith("--")) throw new Error(`Unknown option: ${args[i]}`);
    else positional.push(args[i]);
  }
  options.timeout = Number(options.timeout);
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 86400) throw new Error("Timeout must be 1-86400 seconds.");
  return { ...options, positional };
}

const enabled = (value) => value === true || value === "1" || value === 1;
function status(store) {
  const heartbeat = store.getSetting("worker_heartbeat") || null;
  const age = heartbeat ? Date.now() - Date.parse(heartbeat) : Infinity;
  return {
    draining: enabled(store.getSetting("worker_draining")),
    drainAcknowledged: enabled(store.getSetting("worker_drain_ack")),
    idle: enabled(store.getSetting("worker_idle")),
    heartbeat,
    healthy: Number.isFinite(age) && age >= -5000 && age < 15000,
    running: store.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='running'").get().count,
    queued: store.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='queued'").get().count,
    update: store.getSetting("update_status") || null,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node bin/control.js [--db PATH] [--timeout SECONDS] drain|resume|status|wait-idle|update STATUS [MESSAGE]");
    return;
  }
  const { db, timeout, positional } = parseArgs(process.argv.slice(2));
  const [action, updateStatus, message = ""] = positional;
  if (!["drain", "resume", "status", "wait-idle", "update"].includes(action)) throw new Error("Unknown control action; use --help.");
  if ((action !== "update" && positional.length !== 1) || (action === "update" && (positional.length < 2 || positional.length > 3))) throw new Error("Unexpected control arguments.");
  if (action === "update" && !["requested", "waiting", "updating", "succeeded", "failed"].includes(updateStatus)) throw new Error("Invalid update status.");
  if (!fs.existsSync(db)) throw new Error("Database is missing; run the explicit migration/initialization command first.");
  const store = new Store(db, { legacyFile: readConfig().dataFile });
  try {
    if (action === "drain" || action === "resume") {
      store.transaction(() => {
        store.setSetting("worker_drain_ack", false);
        store.setSetting("worker_draining", action === "drain");
      });
    }
    if (action === "update") store.setSetting("update_status", { status: updateStatus, message, updatedAt: new Date().toISOString() });
    if (action === "wait-idle") {
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        const current = status(store);
        if (current.draining && current.drainAcknowledged && current.idle && current.healthy && current.running === 0) break;
        if (Date.now() >= deadline) throw new Error("Drain timed out; worker must be healthy, acknowledge drain, and have no running jobs. Queued jobs remain preserved.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    console.log(JSON.stringify(status(store)));
  } finally {
    store.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, status };
