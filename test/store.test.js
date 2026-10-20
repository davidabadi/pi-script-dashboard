"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const { Store } = require("../lib/store");
const { readConfig } = require("../lib/config");

function fixture(t, legacy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-store-"));
  const db = path.join(root, "dashboard.sqlite");
  const legacyFile = path.join(root, "scripts.json");
  if (legacy !== undefined) fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  const store = new Store(db, { legacyFile });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, root, db, legacyFile };
}

function job(store, input = {}) {
  const result = store.saveJob({ name: "Backup", script: "/managed/backup.sh", ...input });
  store.setSetting("scheduler_pending", false);
  return result;
}

test("configuration isolates persistent/runtime roots and validates numeric limits", () => {
  const config = readConfig({ RUNTIME_ROOT: path.resolve("fixture-state"), LOG_ROOT: path.resolve("fixture-logs"), LOCK_ROOT: path.resolve("fixture-locks") });
  assert.equal(config.dbFile, path.join(config.runtimeRoot, "dashboard.sqlite"));
  assert.equal(config.auditLog, path.join(config.logRoot, "audit.jsonl"));
  assert.equal(config.hookPort, 8081);
  assert.equal(config.retentionDays, 30);
  assert.equal(config.maxLogBytes, 10 * 1024 * 1024);
  assert.throws(() => readConfig({ HOOK_PORT: "65536" }));
  assert.throws(() => readConfig({ RETENTION_DAYS: "0" }));
  assert.throws(() => readConfig({ MAX_LOG_BYTES: "abc" }));
});

test("existing legacy registry requires explicit migration and remains unchanged", (t) => {
  const { store, legacyFile } = fixture(t, { Legacy: { script: "/old.sh" } });
  assert.equal(store.isReady(), false);
  assert.equal(store.claimNext(), null);
  assert.throws(() => store.enqueue("missing"), /migration/);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile)), { Legacy: { script: "/old.sh" } });
});

test("immutable job IDs, unique names and order are durable", (t) => {
  const { store } = fixture(t);
  assert.equal(store.isReady(), true);
  const first = job(store);
  const second = job(store, { name: "Other" });
  const renamed = store.saveJob({ id: first.id, name: "Renamed" });
  assert.equal(renamed.id, first.id);
  assert.equal(store.getJobByName("Backup"), null);
  assert.equal(store.getJobByName("Renamed").id, first.id);
  assert.throws(() => store.saveJob({ id: second.id, name: "Renamed" }));
  assert.equal(store.getJob(second.id).name, "Other");
  assert.throws(() => store.reorderJobs([first.id, first.id]));
  store.reorderJobs([second.id, first.id]);
  assert.deepEqual(store.listJobs().map((entry) => entry.id), [second.id, first.id]);
});

test("manual duplicates are rejected and cron overlap is durable skipped history", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  const first = store.enqueue(script.id, "manual", "admin");
  assert.equal(first.accepted, true);
  assert.equal(store.enqueue(script.id).accepted, false);
  assert.equal(store.listRuns(script.id).length, 1);
  const skipped = store.enqueue(script.id, "cron");
  assert.equal(skipped.accepted, false);
  assert.equal(skipped.run.status, "skipped");
  assert.ok(skipped.run.finished_at);
  const claimed = store.claimNext();
  assert.equal(claimed.id, first.run.id);
  assert.equal(store.claimNext(), null);
  assert.equal(store.getJob(script.id).last_status, "running");
  store.completeRun(claimed.id, { status: "succeeded", exit_code: 0 });
  assert.equal(store.getJob(script.id).last_run_id, claimed.id);
  assert.equal(store.getJob(script.id).last_status, "succeeded");
});

test("claims respect pending synchronization, readiness and drain flags inside their transaction", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  store.enqueue(script.id);
  for (const [key, value] of [["scheduler_pending", true], ["ready", false], ["worker_draining", true], ["worker_draining", "1"]]) {
    store.setSetting(key, value);
    assert.equal(store.claimNext(), null, key);
    store.setSetting(key, key === "ready" ? true : false);
  }
  assert.equal(store.claimNext().job_id, script.id);
});

test("different jobs run concurrently while shared file logs or locks wait", (t) => {
  const { store } = fixture(t);
  const first = job(store, { name: "First", lock: "/managed/shared.lock" });
  const shared = job(store, { name: "Shared", lock: "/managed/shared.lock" });
  const other = job(store, { name: "Independent" });
  store.enqueue(first.id);
  const active = store.claimNext();
  store.enqueue(shared.id);
  store.enqueue(other.id);
  assert.equal(store.claimNext().job_id, other.id);
  assert.equal(store.claimNext(), null);
  store.completeRun(active.id, { status: "succeeded" });
  assert.equal(store.claimNext().job_id, shared.id);
});

test("queued runs preserve the full job snapshot across later registry changes", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  const { run } = store.enqueue(script.id);
  store.saveJob({ id: script.id, name: "New name", script: "/managed/new.sh" });
  assert.equal(store.getRun(run.id).snapshot.script, "/managed/backup.sh");
  assert.equal(store.getRun(run.id).job_name, "Backup");
});

test("restart recovery interrupts running jobs, revokes hooks, and preserves queued jobs", (t) => {
  const { store } = fixture(t);
  const first = job(store);
  const second = job(store, { name: "Queued" });
  const active = store.enqueue(first.id).run;
  store.claimNext();
  store.updateRun(active.id, { hook_hash: "secret-hash" });
  const queued = store.enqueue(second.id).run;
  assert.equal(store.recoverRunning(), 1);
  assert.equal(store.getRun(active.id).status, "interrupted");
  assert.equal(store.getRun(active.id).hook_hash, null);
  assert.equal(store.getRun(queued.id).status, "queued");
  assert.equal(store.getJob(first.id).last_status, "interrupted");
});

test("a claimed run blocked by a script lock publishes a skipped summary", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  const run = store.enqueue(script.id).run;
  store.claimNext();
  store.completeRun(run.id, { status: "skipped", message: "Existing script lock." });
  assert.equal(store.getJob(script.id).last_status, "skipped");
  assert.equal(store.getJob(script.id).last_run_id, run.id);
  assert.ok(store.getJob(script.id).last_finished_at);
});

test("retention deletes completed history/events but keeps active rows and job summaries", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  const completed = store.enqueue(script.id).run;
  store.claimNext();
  assert.equal(store.recordHookEvent(completed.id, "event-1", "progress", "message"), true);
  assert.equal(store.recordHookEvent(completed.id, "event-1", "progress", "message"), false);
  store.completeRun(completed.id, { status: "succeeded", exit_code: 0 });
  store.updateRun(completed.id, { finished_at: "2000-01-01T00:00:00.000Z" });
  const active = store.enqueue(script.id).run;
  const purged = store.purgeRuns();
  assert.deepEqual(purged.map((run) => run.id), [completed.id]);
  assert.equal(store.getRun(completed.id), null);
  assert.equal(store.getJob(script.id).last_status, "succeeded");
  assert.equal(store.getJob(script.id).last_run_id, completed.id);
  assert.ok(store.getRun(active.id));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM hook_events").get().n, 0);
});

test("two independent SQLite connections cannot enqueue duplicate active jobs", async (t) => {
  const { store, db } = fixture(t);
  const script = job(store);
  const program = `const {Store}=require(process.argv[1]);const s=new Store(process.argv[2]);try{console.log(JSON.stringify(s.enqueue(process.argv[3])))}finally{s.close()}`;
  const calls = [0, 1].map(() => promisify(execFile)(process.execPath, ["-e", program, path.resolve(__dirname, "../lib/store.js"), db, script.id]));
  const results = await Promise.all(calls);
  const accepted = results.map((result) => JSON.parse(result.stdout.trim()).accepted);
  assert.deepEqual(accepted.sort(), [false, true]);
  assert.equal(store.listRuns(script.id).length, 1);
});

test("nested transactions use savepoints and reject asynchronous callbacks", (t) => {
  const { store } = fixture(t);
  const script = job(store);
  store.transaction(() => {
    store.setSetting("outer", true);
    assert.throws(() => store.transaction(() => {
      store.saveJob({ id: script.id, name: "Should roll back" });
      throw new Error("abort inner savepoint");
    }), /abort inner/);
    assert.equal(store.getJob(script.id).name, "Backup");
    store.saveJob({ id: script.id, name: "Committed" });
  });
  assert.equal(store.getJob(script.id).name, "Committed");
  assert.equal(store.getSetting("outer"), true);
  let executed = false;
  assert.throws(() => store.transaction(async () => { executed = true; }), /synchronous/);
  assert.equal(executed, false);
  assert.throws(() => store.transaction(() => Promise.resolve()), /Promise/);
});

test("an independent cron enqueuer waits for an exclusive edit and snapshots committed metadata", async (t) => {
  const { store, db, root } = fixture(t);
  const script = job(store);
  const signal = path.join(root, "enqueue-start");
  const attempted = path.join(root, "enqueue-attempted");
  const output = path.join(root, "enqueue-result.json");
  const program = `
    const fs=require('node:fs');
    const {Store}=require(process.argv[1]);
    const wait=new Int32Array(new SharedArrayBuffer(4));
    const deadline=Date.now()+5000;
    while(!fs.existsSync(process.argv[4])){if(Date.now()>deadline)throw new Error('signal timeout');Atomics.wait(wait,0,0,5)}
    fs.writeFileSync(process.argv[5],'attempting');
    const s=new Store(process.argv[2]);
    try{fs.writeFileSync(process.argv[6],JSON.stringify(s.enqueue(process.argv[3],'cron')))}finally{s.close()}
  `;
  const child = promisify(execFile)(process.execPath, ["-e", program, path.resolve(__dirname, "../lib/store.js"), db, script.id, signal, attempted, output]);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  store.transaction(() => {
    store.saveJob({ id: script.id, name: "Edited", script: "/managed/edited.sh" });
    fs.writeFileSync(signal, "start");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(attempted)) {
      if (Date.now() > deadline) throw new Error("Child did not attempt the enqueue.");
      Atomics.wait(wait, 0, 0, 5);
    }
    // A child connected at this boundary must not read old registry metadata.
    Atomics.wait(wait, 0, 0, 50);
    assert.equal(fs.existsSync(output), false);
    assert.equal(store.listRuns(script.id).length, 0);
  });
  await child;
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(result.accepted, true);
  assert.equal(result.run.snapshot.name, "Edited");
  assert.equal(result.run.snapshot.script, "/managed/edited.sh");
});
