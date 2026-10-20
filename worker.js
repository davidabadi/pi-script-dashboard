"use strict";

require("dotenv").config();
const { readConfig } = require("./lib/config");
const { Store } = require("./lib/store");
const { Worker } = require("./lib/worker");

async function main() {
  const config = readConfig();
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  const worker = new Worker({ store, config });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await worker.stop(); }
    catch (error) { console.error("Worker shutdown failed:", error.message); process.exitCode = 1; }
    finally { store.close(); }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await worker.start();
    console.log(`Worker running; local hooks at ${worker.hookUrl}`);
  } catch (error) {
    console.error("Worker startup failed:", error.message);
    store.close();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main };
