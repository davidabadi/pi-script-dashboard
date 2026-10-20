#!/usr/bin/env node
"use strict";

require("dotenv").config();
const { readConfig } = require("../lib/config");
const { Store } = require("../lib/store");
const { migrateLegacy, syncSchedules } = require("../lib/scheduler");

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: migrate.js [--db PATH] [--legacy PATH] [--backup-dir PATH] [--sync-only]\nImport a backed-up legacy registry and replace exact owned cron commands.\n--sync-only reconciles schedules in an already ready database.");
    return;
  }
  const env = { ...process.env };
  const options = {};
  let syncOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--db" && args[index + 1]) env.DB_FILE = args[++index];
    else if (args[index] === "--legacy" && args[index + 1]) env.DATA_FILE = args[++index];
    else if (args[index] === "--backup-dir" && args[index + 1]) options.backupDir = args[++index];
    else if (args[index] === "--sync-only") syncOnly = true;
    else throw new Error("Usage: migrate.js [--db PATH] [--legacy PATH] [--backup-dir PATH] [--sync-only]");
  }
  const config = readConfig(env);
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  try {
    if (syncOnly) {
      if (!store.isReady()) throw new Error("Run the explicit legacy import before synchronizing schedules.");
      syncSchedules(store, config);
      console.log("Schedules synchronized.");
    } else {
      const result = await migrateLegacy(store, config, options);
      console.log(`Migration complete: ${result.imported} jobs imported${result.resumed ? " (resumed existing import)" : ""}. Backup: ${result.backup}`);
    }
  } finally { store.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
