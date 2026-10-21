"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Store } = require("../lib/store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-enqueue-"));
  const dbFile = path.join(root, "dashboard.sqlite");
  const store = new Store(dbFile);
  const job = store.saveJob({ name: "Backup", script: path.join(root, "backup.sh") });
  store.setSetting("scheduler_pending", false);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, RUNTIME_ROOT: root };
  // Exercise the actual cron command without inherited warning suppression.
  delete env.NODE_NO_WARNINGS;
  delete env.NODE_OPTIONS;
  const enqueue = (args = ["--job", job.id]) => spawnSync(process.execPath, [path.resolve(__dirname, "../bin/enqueue.js"), "--db", dbFile, ...args], { env, encoding: "utf8" });
  return { store, job, dbFile, enqueue };
}

function assertSilentSuccess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("cron enqueue records accepted work without producing mail-triggering output", (t) => {
  const { store, job, enqueue } = fixture(t);
  assertSilentSuccess(enqueue());
  const [run] = store.listRuns(job.id);
  assert.equal(run.status, "queued");
  assert.equal(run.source, "cron");
});

test("cron overlap skips stay silent for queued and running jobs and retain history", (t) => {
  const { store, job, enqueue } = fixture(t);
  const active = store.enqueue(job.id).run;
  for (const status of ["queued", "running"]) {
    if (status === "running") assert.equal(store.claimNext().id, active.id);
    assertSilentSuccess(enqueue());
    assert.equal(store.getRun(active.id).status, status);
  }
  const history = store.listRuns(job.id);
  assert.equal(history.filter((run) => run.status === "skipped" && run.source === "cron").length, 2);
  assert.equal(history.length, 3);
});

test("cron enqueue errors remain visible on stderr with a failing exit status", (t) => {
  const { enqueue } = fixture(t);
  const result = enqueue(["--job", "missing"]);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Job not found/);
});
