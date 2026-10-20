"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { FileLogCapture, RunLogWriter, readRunLog, runLogPath } = require("../lib/run-logs");

function fixture(t, maxLogBytes = 1024 * 1024) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { config: { logRoot: root, maxLogBytes }, run: { id: randomUUID(), status: "running" } };
}

test("run logs preserve UTF-8 byte cursors across incomplete writes and bounded reads", (t) => {
  const { config, run } = fixture(t);
  const writer = new RunLogWriter(config, run);
  t.after(() => writer.close());
  const bytes = Buffer.from("one 🐧 two\n");
  writer.append(bytes.subarray(0, 6));
  let page = readRunLog(config, run, { limit: 6 });
  assert.equal(page.text, "one ");
  assert.equal(page.nextOffset, 4);
  writer.append(bytes.subarray(6));
  page = readRunLog(config, run, { offset: page.nextOffset, limit: 4 });
  assert.equal(page.text, "🐧");
  assert.equal(page.nextOffset, 8);
  page = readRunLog(config, run, { offset: page.nextOffset });
  assert.equal(page.text, " two\n");
  assert.equal(page.nextOffset, bytes.length);
  assert.equal(page.complete, false);
  const middle = readRunLog(config, run, { offset: 5 });
  assert.equal(middle.text, " two\n");
});

test("run log cap retains a prefix without splitting characters or accepting later output", (t) => {
  const { config, run } = fixture(t, 6);
  const writer = new RunLogWriter(config, run, (fields) => Object.assign(run, fields));
  writer.append("1234🐧end");
  writer.append("x");
  writer.close();
  assert.equal(readRunLog(config, run).text, "1234");
  assert.equal(readRunLog(config, run).truncated, true);
  assert.ok(fs.statSync(runLogPath(config, run)).size <= 6);
});

test("configured log capture preserves existing bytes and follows only new output", (t) => {
  const { config, run } = fixture(t);
  const original = path.join(config.logRoot, "legacy.log");
  fs.writeFileSync(original, "previous run\n");
  const writer = new RunLogWriter(config, run);
  const capture = new FileLogCapture(original, writer);
  fs.appendFileSync(original, "this run\n");
  capture.flush();
  writer.close();
  assert.equal(readRunLog(config, run).text, "this run\n");
  assert.equal(fs.readFileSync(original, "utf8"), "previous run\nthis run\n");
});

test("configured log replacement and truncation surface a capture gap", (t) => {
  const { config, run } = fixture(t);
  const original = path.join(config.logRoot, "legacy.log");
  fs.writeFileSync(original, "long previous log\n");
  const writer = new RunLogWriter(config, run, (fields) => Object.assign(run, fields));
  const capture = new FileLogCapture(original, writer);
  fs.writeFileSync(original, "new\n");
  capture.flush();
  fs.renameSync(original, `${original}.old`);
  fs.writeFileSync(original, "replacement\n");
  capture.flush();
  writer.close();
  assert.equal(readRunLog(config, run).text, "new\nreplacement\n");
  assert.equal(readRunLog(config, run).captureGap, true);
});

test("configured logs detect truncate-and-regrow between polling passes", (t) => {
  const { config, run } = fixture(t);
  const original = path.join(config.logRoot, "legacy.log");
  fs.writeFileSync(original, "old content\n");
  const writer = new RunLogWriter(config, run, (fields) => Object.assign(run, fields));
  const capture = new FileLogCapture(original, writer);
  fs.writeFileSync(original, "new run starts here\nand quickly exceeds the original size\n");
  capture.flush();
  writer.close();
  assert.equal(readRunLog(config, run).text, "new run starts here\nand quickly exceeds the original size\n");
  assert.equal(run.capture_gap, 1);
});

test("absent output is an empty log; run IDs cannot escape the log directory", (t) => {
  const { config, run } = fixture(t);
  assert.deepEqual(readRunLog(config, { ...run, status: "succeeded" }), { text: "", offset: 0, nextOffset: 0, complete: true, truncated: false, captureGap: false });
  assert.throws(() => runLogPath(config, "../private"), /Invalid run ID/);
});
