#!/usr/bin/env node
"use strict";

const { readConfig } = require("../lib/config");
const { Store } = require("../lib/store");
const fs = require("node:fs");

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: enqueue.js [--db PATH] --job UUID\nQueue a cron run without requiring the web service.");
    return;
  }
  let job;
  const env = { ...process.env };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--db" && args[index + 1]) env.DB_FILE = args[++index];
    else if (args[index] === "--job" && args[index + 1]) job = args[++index];
    else throw new Error("Usage: enqueue.js [--db PATH] --job UUID");
  }
  if (!job) throw new Error("A job ID is required.");
  const config = readConfig(env);
  if (!fs.existsSync(config.dbFile)) throw new Error("Database not found; initialize or migrate the dashboard before enqueueing runs.");
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  try {
    // Cron mails command output. Accepted runs and normal overlap skips belong
    // in dashboard history, without an email for each scheduled trigger.
    return store.enqueue(job, "cron");
  } finally { store.close(); }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
