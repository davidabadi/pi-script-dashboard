"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { Store } = require("../lib/store");
const { RunLogWriter, readRunLog } = require("../lib/run-logs");
const { signalPath, subscribeChanges, publishStateChange } = require("../lib/change-channel");

const runChild = promisify(execFile);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-events-"));
  const config = { dbFile: path.join(root, "dashboard.sqlite"), logRoot: path.join(root, "logs") };
  const store = new Store(config.dbFile);
  const events = [];
  const close = subscribeChanges(config, (event) => events.push(event));
  t.after(() => { close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, store, events, close, root };
}

function nextChange(config, predicate) {
  return new Promise((resolve, reject) => {
    const close = subscribeChanges(config, (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      close();
      resolve(event);
    });
    const timer = setTimeout(() => { close(); reject(new Error("No change notification received.")); }, 5000);
  });
}

test("state wakeups follow committed outer transactions and leave rollback quiet", async (t) => {
  const { config, store, events } = fixture(t);
  const before = fs.readFileSync(signalPath(config.dbFile), "utf8");
  store.transaction(() => {
    store.setSetting("update_status", { status: "waiting" });
    store.transaction(() => store.setSetting("worker_draining", true));
    assert.equal(events.length, 0);
    assert.equal(fs.readFileSync(signalPath(config.dbFile), "utf8"), before);
  });
  await delay(40);
  assert.ok(events.some((event) => event.type === "state"));
  const committed = fs.readFileSync(signalPath(config.dbFile), "utf8");
  events.length = 0;
  assert.throws(() => store.transaction(() => {
    store.setSetting("worker_draining", false);
    throw new Error("cancelled");
  }), /cancelled/);
  assert.equal(store.getSetting("worker_draining"), true);
  assert.equal(fs.readFileSync(signalPath(config.dbFile), "utf8"), committed);
  await delay(40);
  assert.equal(events.length, 0);
});

test("worker heartbeat and unchanged settings never produce dashboard refreshes", async (t) => {
  const { config, store, events } = fixture(t);
  store.setSetting("worker_heartbeat", new Date().toISOString());
  await delay(40);
  events.length = 0;
  const before = fs.readFileSync(signalPath(config.dbFile), "utf8");
  store.setSetting("worker_heartbeat", new Date(Date.now() + 5000).toISOString());
  store.setSetting("scheduler_pending", false);
  assert.equal(fs.readFileSync(signalPath(config.dbFile), "utf8"), before);
  await delay(60);
  assert.deepEqual(events, []);
});

test("worker start, stop and return after stale heartbeat notify presence changes", (t) => {
  const { config, store } = fixture(t);
  let token = fs.readFileSync(signalPath(config.dbFile), "utf8");
  for (const value of [new Date().toISOString(), null, new Date().toISOString()]) {
    store.setSetting("worker_heartbeat", value);
    const next = fs.readFileSync(signalPath(config.dbFile), "utf8");
    assert.notEqual(next, token);
    token = next;
  }
  // An otherwise idle worker can disappear and return without changing any
  // other setting or run. Its first fresh heartbeat must wake the browser.
  store.setSetting("worker_heartbeat", new Date(Date.now() - 20000).toISOString());
  token = fs.readFileSync(signalPath(config.dbFile), "utf8");
  store.setSetting("worker_heartbeat", new Date().toISOString());
  assert.notEqual(fs.readFileSync(signalPath(config.dbFile), "utf8"), token);
});

test("job changes, enqueue, claim, hook progress, outcome and retention notify", async (t) => {
  const { config, store } = fixture(t);
  let token = fs.readFileSync(signalPath(config.dbFile), "utf8");
  const changed = (mutate) => {
    const result = mutate();
    const next = fs.readFileSync(signalPath(config.dbFile), "utf8");
    assert.notEqual(next, token);
    token = next;
    return result;
  };
  const job = changed(() => store.saveJob({ name: "Backup", script: "/managed/backup.sh" }));
  changed(() => store.saveJob({ id: job.id, name: "Renamed" }));
  store.setSetting("scheduler_pending", false);
  token = fs.readFileSync(signalPath(config.dbFile), "utf8");
  const { run } = changed(() => store.enqueue(job.id));
  const duplicate = store.enqueue(job.id);
  assert.equal(duplicate.accepted, false);
  assert.equal(fs.readFileSync(signalPath(config.dbFile), "utf8"), token);
  changed(() => store.enqueue(job.id, "cron"));
  changed(() => store.claimNext());
  changed(() => store.recordHookEvent(run.id, "one", "progress", "Halfway"));
  assert.equal(store.recordHookEvent(run.id, "one", "progress", "Halfway"), false);
  assert.equal(fs.readFileSync(signalPath(config.dbFile), "utf8"), token);
  changed(() => store.updateRun(run.id, { partial: true }));
  changed(() => store.completeRun(run.id, { status: "partial", exit_code: 0 }));
  changed(() => store.purgeRuns({ now: Date.now() + 40 * 86400000 }));
});

test("independent enqueue processes wake subscribers without database polling", async (t) => {
  const { config, store } = fixture(t);
  const job = store.saveJob({ name: "Backup", script: "/managed/backup.sh" });
  store.setSetting("scheduler_pending", false);
  await delay(40);
  const event = nextChange(config, (change) => change.type === "state");
  await runChild(process.execPath, ["-e", `const {Store}=require(${JSON.stringify(path.resolve(__dirname, "../lib/store"))}); const s=new Store(process.argv[1]); s.enqueue(process.argv[2], 'cron'); s.close();`, config.dbFile, job.id]);
  assert.equal((await event).type, "state");
  assert.equal(store.listRuns(job.id)[0].status, "queued");
});

test("captured log appends wake same-process and independent-process subscribers", async (t) => {
  const { config } = fixture(t);
  const run = { id: "test-run", status: "running" };
  const writer = new RunLogWriter(config, run);
  const first = nextChange(config, (change) => change.type === "log" && change.runId === run.id);
  writer.append("first\n");
  assert.equal((await first).runId, run.id);
  writer.close();
  await delay(40);
  const second = nextChange(config, (change) => change.type === "log" && change.runId === run.id);
  await runChild(process.execPath, ["-e", `const {RunLogWriter}=require(${JSON.stringify(path.resolve(__dirname, "../lib/run-logs"))}); const w=new RunLogWriter(JSON.parse(process.argv[1]), JSON.parse(process.argv[2])); w.append('second\\n'); w.close();`, JSON.stringify(config), JSON.stringify(run)]);
  await second;
  assert.equal(readRunLog(config, run).text, "first\nsecond\n");
});

test("directory watches survive atomic replacement of the bounded state signal", async (t) => {
  const { config, store, root } = fixture(t);
  const replacement = path.join(root, "replacement");
  fs.writeFileSync(replacement, "replacement\n", { mode: 0o600 });
  fs.renameSync(replacement, signalPath(config.dbFile));
  await delay(40);
  const event = nextChange(config, (change) => change.type === "state");
  store.setSetting("update_status", { status: "finished" });
  await event;
  const stats = fs.statSync(signalPath(config.dbFile));
  assert.equal(stats.size, 37);
  if (process.platform !== "win32") assert.equal(stats.mode & 0o777, 0o600);
});

test("subscriptions reattach after captured log directory replacement", async (t) => {
  const { config } = fixture(t);
  fs.renameSync(path.join(config.logRoot, "runs"), path.join(config.logRoot, "old-runs"));
  fs.mkdirSync(path.join(config.logRoot, "runs"));
  await delay(50);
  const run = { id: "replacement-run", status: "running" };
  const event = nextChange(config, (change) => change.type === "log" && change.runId === run.id);
  await runChild(process.execPath, ["-e", `const {RunLogWriter}=require(${JSON.stringify(path.resolve(__dirname, "../lib/run-logs"))}); const w=new RunLogWriter(JSON.parse(process.argv[1]), JSON.parse(process.argv[2])); w.append('new directory\\n'); w.close();`, JSON.stringify(config), JSON.stringify(run)]);
  await event;
  assert.equal(readRunLog(config, run).text, "new directory\n");
});

test("closing subscriptions is idempotent and suppresses queued notifications", async (t) => {
  const { config, events, close } = fixture(t);
  publishStateChange(config.dbFile);
  close();
  close();
  await delay(40);
  assert.deepEqual(events, []);
});

test("state signal refuses hardlinks instead of overwriting another file", { skip: process.platform === "win32" }, (t) => {
  const { config, root } = fixture(t);
  const target = path.join(root, "private");
  fs.writeFileSync(target, "do not overwrite");
  fs.unlinkSync(signalPath(config.dbFile));
  fs.linkSync(target, signalPath(config.dbFile));
  publishStateChange(config.dbFile);
  assert.equal(fs.readFileSync(target, "utf8"), "do not overwrite");
});

test("state signal refuses symbolic links instead of following them", { skip: process.platform === "win32" }, (t) => {
  const { config, root } = fixture(t);
  const target = path.join(root, "private");
  fs.writeFileSync(target, "do not overwrite");
  fs.unlinkSync(signalPath(config.dbFile));
  fs.symlinkSync(target, signalPath(config.dbFile));
  publishStateChange(config.dbFile);
  assert.equal(fs.readFileSync(target, "utf8"), "do not overwrite");
});
