"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Store } = require("../lib/store");
const { readConfig } = require("../lib/config");
const { editJobFiles, recoverJobFiles } = require("../lib/job-files");
const { createBackup, syncSchedules } = require("../lib/scheduler");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-edit-"));
  const config = readConfig({ RUNTIME_ROOT: root, LOG_ROOT: path.join(root, "logs"), LOCK_ROOT: path.join(root, "locks") });
  fs.mkdirSync(config.scriptRoot, { recursive: true });
  fs.mkdirSync(config.configRoot, { recursive: true });
  const script = path.join(config.scriptRoot, "backup.sh");
  const configFile = path.join(config.configRoot, "backup.conf");
  fs.writeFileSync(script, "original script\n");
  fs.writeFileSync(configFile, "original secret config\n");
  const store = new Store(config.dbFile);
  const job = store.saveJob({ name: "Backup", script, config_path: configFile });
  store.setSetting("scheduler_pending", false);
  const writes = [{ file: script, content: "new script\n", mode: 0o700 }, { file: configFile, content: "new config\n", mode: 0o600 }];
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, config, script, configFile, job, writes, root };
}

function crashEdit(f) {
  const program = `
    const {Store}=require(process.argv[1]);
    const {editJobFiles}=require(process.argv[2]);
    const config=JSON.parse(process.argv[3]);
    const writes=JSON.parse(process.argv[4]);
    const store=new Store(config.dbFile);
    editJobFiles(store,config,{writes,check(){},save(){process.exit(77)}});
  `;
  const child = spawnSync(process.execPath, ["-e", program, path.resolve(__dirname, "../lib/store.js"), path.resolve(__dirname, "../lib/job-files.js"), JSON.stringify(f.config), JSON.stringify(f.writes)], { encoding: "utf8" });
  assert.equal(child.status, 77, child.stderr);
  assert.ok(f.store.getSetting("content_recovery"));
}

test("successful file edit commits metadata and clears its private recovery journal", (t) => {
  const f = fixture(t);
  const saved = editJobFiles(f.store, f.config, { writes: f.writes,
    check() { assert.ok(f.store.getSetting("content_recovery")); assert.equal(f.store.getSetting("scheduler_pending"), true); },
    save() { return f.store.saveJob({ id: f.job.id, name: "Edited" }); } });
  assert.equal(saved.name, "Edited");
  assert.equal(fs.readFileSync(f.script, "utf8"), "new script\n");
  assert.equal(fs.readFileSync(f.configFile, "utf8"), "new config\n");
  assert.equal(f.store.getSetting("content_recovery"), null);
  assert.equal(f.store.getSetting("scheduler_pending"), true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "edit-recovery")), []);
});

test("busy guard or asynchronous callbacks cannot alter script files", (t) => {
  const f = fixture(t);
  assert.throws(() => editJobFiles(f.store, f.config, { writes: f.writes, check() { throw new Error("busy"); }, save() {} }), /busy/);
  assert.equal(fs.readFileSync(f.script, "utf8"), "original script\n");
  assert.equal(f.store.getSetting("scheduler_pending"), false);
  assert.equal(f.store.getSetting("content_recovery"), null);
  assert.throws(() => editJobFiles(f.store, f.config, { writes: f.writes, async check() {}, save() {} }), /synchronous/);
});

test("a later write failure restores earlier files and rolls back metadata", (t) => {
  const f = fixture(t);
  const rename = fs.renameSync;
  let failed = false;
  fs.renameSync = (source, target) => {
    if (!failed && target === f.configFile) { failed = true; throw new Error("fixture config write failed"); }
    return rename(source, target);
  };
  try {
    assert.throws(() => editJobFiles(f.store, f.config, { writes: f.writes, check() {}, save() { f.store.saveJob({ id: f.job.id, name: "Uncommitted" }); } }), /fixture config write failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.script, "utf8"), "original script\n");
  assert.equal(fs.readFileSync(f.configFile, "utf8"), "original secret config\n");
  assert.equal(f.store.getJob(f.job.id).name, "Backup");
  assert.equal(f.store.getSetting("content_recovery"), null);
  assert.equal(f.store.getSetting("scheduler_pending"), false);
});

test("crash recovery restores originals while queued snapshots remain paused until schedule sync", (t) => {
  const f = fixture(t);
  crashEdit(f);
  assert.equal(fs.readFileSync(f.script, "utf8"), "new script\n");
  assert.equal(f.store.getJob(f.job.id).name, "Backup");
  const queued = f.store.enqueue(f.job.id, "cron").run;
  assert.throws(() => syncSchedules(f.store, f.config, { readCrontab: () => "", writeCrontab() {} }), /Recover/);
  assert.equal(f.store.claimNext(), null);
  assert.equal(recoverJobFiles(f.store, f.config), true);
  assert.equal(fs.readFileSync(f.script, "utf8"), "original script\n");
  assert.equal(fs.readFileSync(f.configFile, "utf8"), "original secret config\n");
  assert.equal(f.store.getSetting("content_recovery"), null);
  assert.equal(f.store.getSetting("scheduler_pending"), true);
  assert.equal(f.store.getRun(queued.id).status, "queued");
  assert.equal(f.store.claimNext(), null);
  syncSchedules(f.store, f.config, { readCrontab: () => "", writeCrontab() {} });
  assert.equal(f.store.claimNext().id, queued.id);
});

test("recovery waits for running jobs and refuses to overwrite an existing journal", (t) => {
  const f = fixture(t);
  const active = f.store.enqueue(f.job.id).run;
  f.store.claimNext();
  // Simulate a crashed editor beside a different active execution. The web
  // guard normally prevents this, but recovery still must fail safely.
  crashEdit(f);
  assert.throws(() => recoverJobFiles(f.store, f.config), /running jobs/);
  assert.throws(() => editJobFiles(f.store, f.config, { writes: f.writes, check() {}, save() {} }), /Recover/);
  f.store.completeRun(active.id, { status: "succeeded" });
  assert.equal(recoverJobFiles(f.store, f.config), true);
});

test("recovery rejects corrupted backups or manifest paths outside managed roots", (t) => {
  const f = fixture(t);
  crashEdit(f);
  const id = f.store.getSetting("content_recovery");
  const directory = path.join(f.root, "edit-recovery", id);
  const backup = path.join(directory, "0.bin");
  const original = fs.readFileSync(backup);
  fs.writeFileSync(backup, "corrupted");
  assert.throws(() => recoverJobFiles(f.store, f.config), /checksum/);
  assert.ok(f.store.getSetting("content_recovery"));
  fs.writeFileSync(backup, original);
  const manifestFile = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.files[0].file = path.join(f.root, "outside.sh");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => recoverJobFiles(f.store, f.config), /remain under/);
  assert.equal(fs.existsSync(path.join(f.root, "outside.sh")), false);
  assert.ok(f.store.getSetting("content_recovery"));
});

test("application backups refuse unresolved edit recovery without creating a misleading snapshot", async (t) => {
  const f = fixture(t);
  crashEdit(f);
  const output = path.join(f.root, "should-not-exist");
  await assert.rejects(createBackup(f.store, f.config, output, { crontab: "" }), /Recover/);
  assert.equal(fs.existsSync(output), false);
});
