"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("../lib/store");
const { readConfig } = require("../lib/config");
const { commandWords, createBackup, migrateLegacy, renderCron, syncSchedules } = require("../lib/scheduler");
const { shellQuote, stableJobId } = require("../security");

function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-migration-"));
  const config = readConfig({ RUNTIME_ROOT: root, LOG_ROOT: path.join(root, "logs"), LOCK_ROOT: path.join(root, "locks") });
  for (const dir of [config.scriptRoot, config.configRoot, config.logRoot, config.lockRoot]) fs.mkdirSync(dir, { recursive: true });
  const registry = {
    Backup: { script: path.join(config.scriptRoot, "backup.sh"), log: path.join(config.logRoot, "backup.log"), lock: path.join(config.lockRoot, "backup.lock"), config_path: path.join(config.configRoot, "backup.conf"), order: 2 },
  };
  if (legacy) fs.writeFileSync(config.dataFile, JSON.stringify(registry, null, 2));
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let cron = "# User comment\nMAILTO=operator@example.com\n0 4 * * * /bin/true # unrelated\n";
  const options = { readCrontab: () => cron, writeCrontab: (value) => { cron = value; }, nodePath: "/usr/local/bin/node", enqueuePath: "/opt/pi-script-dashboard/bin/enqueue.js" };
  return { store, config, root, registry, options, getCron: () => cron, setCron: (value) => { cron = value; } };
}

function legacyLine(info, paused = true) {
  return `${paused ? "# " : ""}0 2 * * * ${["/bin/bash", info.script, info.config_path].filter(Boolean).map(shellQuote).join(" ")} # pi-dashboard:${stableJobId("Backup")}\n`;
}

test("cron tokenizer accepts literal quoted paths and rejects shell execution syntax", () => {
  assert.deepEqual(commandWords("'/bin/bash' '/path with space/a.sh'"), ["/bin/bash", "/path with space/a.sh"]);
  assert.deepEqual(commandWords(shellQuote("it's literal")), ["it's literal"]);
  for (const command of ["/bin/bash /a.sh; reboot", "/bin/bash $(id)", '/bin/bash "$HOME/a.sh"', "/bin/bash /a.sh >> /log", "'/unclosed"]) assert.throws(() => commandWords(command));
});

test("schedule synchronization preserves unrelated cron and uses permanent UUID markers", (t) => {
  const { store, config, options, getCron } = fixture(t);
  const original = getCron();
  const job = store.saveJob({ name: "Backup", script: "/managed/backup.sh", schedule: "@daily", paused: true });
  syncSchedules(store, config, options);
  assert.ok(getCron().startsWith(original));
  assert.ok(getCron().includes(renderCron(job, config, options)));
  assert.equal(store.getSetting("scheduler_pending"), false);
  const id = job.id;
  const updated = store.saveJob({ id, name: "Renamed", paused: false, schedule: "@hourly" });
  syncSchedules(store, config, options);
  assert.ok(getCron().includes(renderCron(updated, config, options)));
  assert.equal(getCron().split(`# pi-dashboard:${id}`).length - 1, 1);
  assert.ok(getCron().startsWith(original));
});

test("sync failures remain visibly pending and never replace a marker on an unrelated command", (t) => {
  const { store, config, options, getCron, setCron } = fixture(t);
  const job = store.saveJob({ name: "Backup", script: "/managed/backup.sh", schedule: "@daily" });
  setCron(`@daily /bin/true # pi-dashboard:${job.id}\n`);
  const original = getCron();
  assert.throws(() => syncSchedules(store, config, options), /unexpected command/);
  assert.equal(getCron(), original);
  assert.equal(store.getSetting("scheduler_pending"), true);
  assert.equal(store.claimNext(), null);
});

test("cron write failure keeps dispatch blocked until a successful retry", (t) => {
  const { store, config, options } = fixture(t);
  const job = store.saveJob({ name: "Backup", script: "/managed/backup.sh", schedule: "@daily" });
  store.enqueue(job.id);
  assert.throws(() => syncSchedules(store, config, { ...options, writeCrontab: () => { throw new Error("denied"); } }), /denied/);
  assert.equal(store.claimNext(), null);
  syncSchedules(store, config, options);
  assert.equal(store.claimNext().job_id, job.id);
});

test("legacy import backs up JSON, WAL database and complete cron before rewriting only owned lines", async (t) => {
  const { store, config, registry, options, getCron, setCron } = fixture(t, true);
  const source = fs.readFileSync(config.dataFile);
  setCron(getCron() + legacyLine(registry.Backup));
  const originalCron = getCron();
  const result = await migrateLegacy(store, config, options);
  assert.equal(result.imported, 1);
  assert.equal(store.isReady(), true);
  assert.equal(store.getSetting("scheduler_pending"), false);
  const [job] = store.listJobs();
  assert.equal(job.paused, true);
  assert.equal(job.schedule, "0 2 * * *");
  assert.equal(job.log_mode, "file");
  assert.ok(getCron().includes(`# pi-dashboard:${job.id}`));
  assert.equal(getCron().includes(stableJobId("Backup")), false);
  assert.ok(fs.readFileSync(config.dataFile).equals(source));
  assert.equal(fs.readFileSync(path.join(result.backup, "crontab.txt"), "utf8"), originalCron);
  assert.ok(fs.readFileSync(path.join(result.backup, "scripts.json")).equals(source));
  const backedUp = new DatabaseSync(path.join(result.backup, "dashboard.sqlite"), { readOnly: true });
  try { assert.equal(backedUp.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0); }
  finally { backedUp.close(); }
});

test("interrupted import resumes after cron write without duplicate jobs or schedules", async (t) => {
  const { store, config, registry, options, getCron, setCron } = fixture(t, true);
  setCron(getCron() + legacyLine(registry.Backup, false));
  await assert.rejects(migrateLegacy(store, config, { ...options, writeCrontab: (value) => { setCron(value); throw new Error("simulated crash after write"); } }), /simulated crash/);
  assert.equal(store.isReady(), false);
  assert.equal(store.listJobs().length, 1);
  const id = store.listJobs()[0].id;
  const result = await migrateLegacy(store, config, options);
  assert.equal(result.resumed, true);
  assert.equal(store.isReady(), true);
  assert.equal(store.listJobs()[0].id, id);
  assert.equal(getCron().split(`# pi-dashboard:${id}`).length - 1, 1);
});

test("legacy command mismatch fails without imported rows or cron edits", async (t) => {
  const { store, config, registry, options, getCron, setCron } = fixture(t, true);
  setCron(legacyLine(registry.Backup).replace("'/bin/bash'", "'/bin/true'"));
  const original = getCron();
  await assert.rejects(migrateLegacy(store, config, options), /does not match/);
  assert.equal(store.listJobs().length, 0);
  assert.equal(store.isReady(), false);
  assert.equal(getCron(), original);
});

test("legacy unsafe paths, duplicate markers, and shared log paths require explicit correction", async (t) => {
  const { store, config, registry, options, getCron, setCron } = fixture(t, true);
  setCron(getCron() + legacyLine(registry.Backup) + legacyLine(registry.Backup));
  await assert.rejects(migrateLegacy(store, config, options), /Duplicate/);
  setCron("");
  registry.Other = { ...registry.Backup };
  fs.writeFileSync(config.dataFile, JSON.stringify(registry));
  await assert.rejects(migrateLegacy(store, config, options), /share/);
  delete registry.Other;
  registry.Backup.script = path.join(config.runtimeRoot, "outside.sh");
  fs.writeFileSync(config.dataFile, JSON.stringify(registry));
  await assert.rejects(migrateLegacy(store, config, options), /remain under/);
  assert.equal(store.listJobs().length, 0);
});

test("backup is consistent with WAL and refuses an existing destination", async (t) => {
  const { store, config, options, root } = fixture(t);
  const job = store.saveJob({ name: "Backup", script: "/managed/backup.sh" });
  store.enqueue(job.id);
  const output = path.join(root, "snapshot");
  await createBackup(store, config, output, options);
  const snapshot = new DatabaseSync(path.join(output, "dashboard.sqlite"), { readOnly: true });
  try { assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1); }
  finally { snapshot.close(); }
  await assert.rejects(createBackup(store, config, output, options), /exist/i);
});
