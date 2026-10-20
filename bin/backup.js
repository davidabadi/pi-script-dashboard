#!/usr/bin/env node
"use strict";

require("dotenv").config();
const { readConfig } = require("../lib/config");
const { Store } = require("../lib/store");
const { createBackup } = require("../lib/scheduler");
const fs = require("node:fs");
const path = require("node:path");

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: backup.js [--db PATH] --output NEW_DIRECTORY\nCreate a private, consistent SQLite/legacy-registry/service-user-cron backup.");
    return;
  }
  const env = { ...process.env };
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--db" && args[index + 1]) env.DB_FILE = args[++index];
    else if (args[index] === "--output" && args[index + 1]) output = args[++index];
    else throw new Error("Usage: backup.js [--db PATH] --output NEW_DIRECTORY");
  }
  if (!output) throw new Error("A new backup output directory is required.");
  const config = readConfig(env);
  if (!fs.existsSync(config.dbFile)) throw new Error("Database not found; refusing to back up an empty replacement.");
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  try {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
    await createBackup(store, config, output);
    console.log(`Backup complete: ${output}`);
  } finally { store.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
