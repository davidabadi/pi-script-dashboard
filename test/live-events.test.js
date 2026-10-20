"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const expressSession = require("express-session");
const { createLiveEvents } = require("../lib/live-events");
const { readRunLog, RunLogWriter } = require("../lib/run-logs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail("Timed out waiting for live event.");
    await sleep(5);
  }
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-events-"));
  const config = { dbFile: path.join(root, "dashboard.sqlite"), logRoot: root };
  const jobs = new Map([["job-a", { id: "job-a", name: "First" }], ["job-b", { id: "job-b", name: "Other" }]]);
  const runs = new Map([["run-a", { id: "run-a", job_id: "job-a", status: "running", hook_hash: "must-stay-private" }],
    ["run-b", { id: "run-b", job_id: "job-b", status: "running", hook_hash: "other-secret" }]]);
  const sessions = new Map([["session-a", { logged_in: true, absoluteExpiresAt: Date.now() + 60000, lastActivityAt: Date.now() }]]);
  const listeners = new Set();
  const counts = { snapshot: 0, history: 0, log: 0, session: 0, unsubscribed: 0, heartbeat: 0 };
  let heartbeat = null;
  const publicRun = (run) => ({ id: run.id, job_id: run.job_id, status: run.status });
  const store = {
    getJob: (id) => jobs.get(id), getRun: (id) => runs.get(id),
    listRuns: (id) => { counts.history++; return [...runs.values()].filter((run) => run.job_id === id); },
    getSetting: (key) => { if (key === "worker_heartbeat") { counts.heartbeat++; return heartbeat; } },
  };
  const app = express();
  app.set("trust proxy", "loopback");
  app.use((req, _res, next) => {
    req.sessionID = req.get("x-test-session") || "session-a";
    req.sessionStore = { get(id, cb) { counts.session++; queueMicrotask(() => cb(null, sessions.get(id))); } };
    next();
  });
  const live = createLiveEvents({ store, config, publicRun,
    getSnapshot: () => { counts.snapshot++; return { jobs: [...jobs.values()], worker: { online: Date.now() - Date.parse(heartbeat || "") < (options.workerStaleMs || 10000) } }; },
    subscribeChanges: (_config, callback) => { listeners.add(callback); return () => { counts.unsubscribed++; listeners.delete(callback); }; },
    readLog: (...args) => { counts.log++; return readRunLog(...args); },
    ...options });
  app.get("/api/events", live.handler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const writers = [];
  const append = (runId, text) => {
    let writer = writers.find((item) => item.runId === runId)?.writer;
    if (!writer) { writer = new RunLogWriter(config, runs.get(runId)); writers.push({ runId, writer }); }
    writer.append(text);
  };
  async function stream(query = "", headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/events${query}`, { headers }, (response) => {
        const client = { request, response, events: [], comments: 0, text: "", ended: false,
          stop() { request.destroy(); response.destroy(); } };
        let pending = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          client.text += chunk;
          pending += chunk;
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (frame.startsWith(":")) { client.comments++; continue; }
            const type = /^event: (.+)$/m.exec(frame)?.[1];
            const body = /^data: (.+)$/m.exec(frame)?.[1];
            if (type && body) client.events.push({ type, data: JSON.parse(body), id: /^id: (.+)$/m.exec(frame)?.[1] });
          }
        });
        response.on("end", () => { client.ended = true; });
        response.on("error", () => { client.ended = true; });
        resolve(client);
      });
      request.on("error", reject);
    });
  }
  t.after(async () => {
    live.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const { writer } of writers) writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { live, store, jobs, runs, sessions, config, counts, listeners, base, stream, append,
    emit(event) { for (const listener of listeners) listener(event); },
    heartbeat(value) { heartbeat = value; } };
}

test("event stream sends initial state, selected history and logs without exposing credentials", async (t) => {
  const f = await fixture(t);
  f.append("run-a", "<script>an escaped text string</script>\n");
  const stream = await f.stream("?jobId=job-a&runId=run-a");
  await until(() => stream.events.some((event) => event.type === "log" && event.data.text));
  assert.equal(stream.response.statusCode, 200);
  assert.match(stream.response.headers["content-type"], /^text\/event-stream/);
  assert.match(stream.response.headers["cache-control"], /no-transform/);
  assert.equal(stream.response.headers["x-accel-buffering"], "no");
  assert.deepEqual(stream.events.slice(0, 3).map((event) => event.type), ["snapshot", "history", "log"]);
  assert.equal(stream.events[1].data.jobId, "job-a");
  assert.deepEqual(stream.events[1].data.runs.map((run) => run.id), ["run-a"]);
  assert.equal(stream.events[2].data.runId, "run-a");
  assert.equal(stream.events[2].data.text, "<script>an escaped text string</script>\n");
  assert.equal(stream.text.includes("must-stay-private"), false);
  assert.match(stream.events[2].id, /^log:run-a:\d+$/);
  assert.equal(stream.events[0].id, undefined);
  assert.equal(stream.events[1].id, undefined);
});

test("idle keepalive and session checks do not reread dashboard history or logs", async (t) => {
  const f = await fixture(t, { keepaliveMs: 10, authIntervalMs: 15 });
  const stream = await f.stream("?jobId=job-a&runId=run-a");
  await until(() => stream.events.length === 3);
  const reads = { snapshot: f.counts.snapshot, history: f.counts.history, log: f.counts.log };
  await until(() => stream.comments >= 3);
  assert.deepEqual({ snapshot: f.counts.snapshot, history: f.counts.history, log: f.counts.log }, reads);
  assert.ok(f.counts.session >= 3);
  assert.equal(stream.events.length, 3);
});

test("actual change notifications send new state and log bytes; unchanged and unrelated changes are suppressed", async (t) => {
  const f = await fixture(t);
  f.append("run-a", "first\n");
  const stream = await f.stream("?jobId=job-a&runId=run-a");
  await until(() => stream.events.filter((event) => event.type === "log").length >= 2);
  const before = stream.events.length;
  const reads = f.counts.log;
  f.emit({ type: "log", runId: "run-b" });
  await sleep(25);
  assert.equal(f.counts.log, reads);
  assert.equal(stream.events.length, before);
  f.emit({ type: "state" });
  await sleep(25);
  assert.equal(stream.events.length, before);
  f.jobs.get("job-a").name = "Renamed";
  f.emit({ type: "state" });
  await until(() => stream.events.some((event) => event.type === "snapshot" && event.data.jobs[0].name === "Renamed"));
  f.append("run-a", "next\n");
  f.emit({ type: "log", runId: "run-a" });
  await until(() => stream.events.some((event) => event.type === "log" && event.data.text === "next\n"));
  assert.equal(stream.events.filter((event) => event.type === "log").map((event) => event.data.text).join(""), "first\nnext\n");
  f.runs.get("run-a").status = "succeeded";
  f.emit({ type: "state" });
  await until(() => stream.events.some((event) => event.type === "log" && event.data.complete));
});

test("reconnect resumes from matching Last-Event-ID byte cursor while state/history do not overwrite it", async (t) => {
  const f = await fixture(t);
  f.append("run-a", "one 🐧\n");
  const first = await f.stream("?jobId=job-a&runId=run-a&offset=0");
  await until(() => first.events.some((event) => event.type === "log" && event.data.text));
  const cursor = first.events.find((event) => event.type === "log").id;
  first.stop();
  f.append("run-a", "two 🐧\n");
  const second = await f.stream("?jobId=job-a&runId=run-a&offset=0", { "Last-Event-ID": cursor });
  await until(() => second.events.some((event) => event.type === "log" && event.data.text));
  assert.equal(second.events.filter((event) => event.type === "log").map((event) => event.data.text).join(""), "two 🐧\n");
  assert.equal(second.events[0].type, "snapshot");
  assert.equal(second.events[0].id, undefined);
  assert.equal(second.events[1].id, undefined);
  const unrelated = await f.stream("?jobId=job-a&runId=run-a", { "Last-Event-ID": "log:run-b:999" });
  await until(() => unrelated.events.some((event) => event.type === "log" && event.data.text));
  assert.equal(unrelated.events.find((event) => event.type === "log").data.offset, 0);
});

test("large UTF-8 logs are paged at 64 KiB with byte offsets and without character loss", async (t) => {
  const f = await fixture(t);
  const content = "🐧long log line\n".repeat(12000);
  f.append("run-a", content);
  const stream = await f.stream("?jobId=job-a&runId=run-a");
  await until(() => stream.events.filter((event) => event.type === "log").reduce((length, event) => length + Buffer.byteLength(event.data.text), 0) === Buffer.byteLength(content));
  const pages = stream.events.filter((event) => event.type === "log");
  assert.ok(pages.length >= 3);
  assert.ok(pages.every((event) => Buffer.byteLength(event.data.text) <= 65536));
  assert.equal(pages.map((event) => event.data.text).join(""), content);
  for (let index = 1; index < pages.length; index++) assert.equal(pages[index].data.offset, pages[index - 1].data.nextOffset);
});

test("query validation and same-origin checks reject bad requests before SSE headers", async (t) => {
  const f = await fixture(t);
  for (const query of ["?offset=-1", "?offset=1.5", "?offset=9007199254740992", "?jobId=", "?jobId[]=job-a", "?runId=../run-a"]) {
    const result = await fetch(`${f.base}/api/events${query}`);
    assert.equal(result.status, 400, query);
    assert.match(result.headers.get("content-type"), /json/);
  }
  for (const headers of [{ Origin: "https://attacker.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const result = await fetch(`${f.base}/api/events`, { headers });
    assert.equal(result.status, 403);
  }
  const schemeMismatch = await fetch(`${f.base}/api/events`, { headers: { Origin: f.base, "X-Forwarded-Proto": "https" } });
  assert.equal(schemeMismatch.status, 403);
  const forwardedSecure = await f.stream("", { Origin: f.base.replace("http:", "https:"), "X-Forwarded-Proto": "https" });
  await until(() => forwardedSecure.events.length === 1);
  assert.equal(forwardedSecure.response.statusCode, 200);
  const allowed = await f.stream("", { Origin: f.base });
  await until(() => allowed.events.length === 1);
  assert.equal(allowed.response.statusCode, 200);
  for (const query of ["?jobId=missing", "?runId=missing", "?jobId=job-b&runId=run-a"]) {
    const result = await fetch(`${f.base}/api/events${query}`);
    assert.equal(result.status, 404, query);
  }
});

test("an expired selected run delivers retained history and an explicit log expiry event", async (t) => {
  const f = await fixture(t);
  const stream = await f.stream("?jobId=job-a&runId=expired-run&offset=123");
  await until(() => stream.events.length === 3);
  assert.equal(stream.response.statusCode, 200);
  assert.deepEqual(stream.events.map((event) => event.type), ["snapshot", "history", "log"]);
  assert.deepEqual(stream.events[1].data.runs.map((run) => run.id), ["run-a"]);
  assert.deepEqual(stream.events[2].data, { runId: "expired-run", text: "", offset: 123, nextOffset: 123,
    complete: true, expired: true, truncated: false, captureGap: false, run: null });
  assert.equal(f.counts.log, 0);
  f.jobs.get("job-a").name = "Renamed";
  f.emit({ type: "state" });
  await until(() => stream.events.some((event) => event.type === "snapshot" && event.data.jobs[0].name === "Renamed"));
  assert.equal(stream.ended, false);
});

test("revoked sessions are rejected initially and ongoing streams receive auth-expired without extending activity", async (t) => {
  const f = await fixture(t, { authIntervalMs: 15 });
  const activity = f.sessions.get("session-a").lastActivityAt;
  const stream = await f.stream();
  await until(() => stream.events.length === 1);
  assert.equal(f.sessions.get("session-a").lastActivityAt, activity);
  f.sessions.delete("session-a");
  await until(() => stream.events.some((event) => event.type === "auth-expired") && stream.ended);
  assert.equal(f.listeners.size, 0);
  const result = await fetch(`${f.base}/api/events`);
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("content-type").includes("event-stream"), false);
});

test("idle and absolute deadlines expire independently of keepalive traffic", async (t) => {
  for (const deadline of ["idle", "absolute"]) {
    const f = await fixture(t, { keepaliveMs: 5, authIntervalMs: 1000 });
    const session = f.sessions.get("session-a");
    if (deadline === "idle") session.lastActivityAt = Date.now() - 1800000 + 100;
    else session.absoluteExpiresAt = Date.now() + 100;
    const stream = await f.stream();
    await until(() => stream.events.some((event) => event.type === "auth-expired"));
    assert.ok(stream.comments > 0);
    assert.equal(f.listeners.size, 0);
  }
});

test("logout closes only that session promptly and connection limits are enforced", async (t) => {
  const f = await fixture(t, { maxConnectionsPerSession: 1 });
  const first = await f.stream();
  await until(() => first.events.length === 1);
  const blocked = await fetch(`${f.base}/api/events`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "5");
  f.sessions.set("session-b", { ...f.sessions.get("session-a") });
  const other = await f.stream("", { "X-Test-Session": "session-b" });
  await until(() => other.events.length === 1);
  f.live.closeSession("session-a");
  await until(() => first.ended);
  assert.equal(first.events.at(-1).type, "auth-expired");
  assert.equal(other.ended, false);
  assert.equal(f.listeners.size, 1);
});

test("a one-shot heartbeat expiry publishes worker offline without polling job data", async (t) => {
  const f = await fixture(t, { workerStaleMs: 80 });
  f.heartbeat(new Date().toISOString());
  const stream = await f.stream();
  await until(() => stream.events.length === 1);
  assert.equal(stream.events[0].data.worker.online, true);
  await until(() => stream.events.some((event) => event.type === "snapshot" && event.data.worker.online === false));
  const snapshots = f.counts.snapshot;
  await sleep(100);
  assert.equal(f.counts.snapshot, snapshots);
  assert.equal(f.counts.history, 0);
  assert.equal(f.counts.log, 0);
  f.heartbeat(new Date().toISOString());
  f.emit({ type: "state" });
  await until(() => stream.events.at(-1).data.worker.online === true);
});

test("advancing heartbeats check liveness without rebuilding an unchanged dashboard snapshot", async (t) => {
  const f = await fixture(t, { workerStaleMs: 100 });
  f.heartbeat(new Date().toISOString());
  const stream = await f.stream("?jobId=job-a&runId=run-a");
  await until(() => stream.events.length === 3);
  const snapshots = f.counts.snapshot, history = f.counts.history, logs = f.counts.log;
  await sleep(60);
  f.heartbeat(new Date().toISOString());
  await sleep(60);
  assert.equal(f.counts.snapshot, snapshots);
  assert.equal(f.counts.history, history);
  assert.equal(f.counts.log, logs);
  assert.equal(stream.events.filter((event) => event.type === "snapshot").length, 1);
  await until(() => stream.events.some((event) => event.type === "snapshot" && !event.data.worker.online));
});

test("express-session cannot renew or resurrect a session when a long-lived stream ends", async (t) => {
  const sessions = new expressSession.MemoryStore();
  const app = express();
  app.use(expressSession({ secret: "live-events-test-only-secret-value", store: sessions, resave: false, saveUninitialized: false,
    rolling: true, cookie: { maxAge: 1800000 } }));
  app.get("/seed", (req, res) => {
    Object.assign(req.session, { logged_in: true, absoluteExpiresAt: Date.now() + 60000, lastActivityAt: Date.now() });
    res.json({ id: req.sessionID });
  });
  const live = createLiveEvents({ store: { getSetting: () => null }, config: {},
    getSnapshot: () => ({ jobs: [] }), publicRun: (value) => value,
    subscribeChanges: () => () => {} });
  app.get("/api/events", live.handler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { live.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const seeded = await fetch(`${base}/seed`);
  const { id } = await seeded.json();
  const cookie = seeded.headers.get("set-cookie").split(";")[0];
  const getSession = () => new Promise((resolve, reject) => sessions.get(id, (error, value) => error ? reject(error) : resolve(value)));
  const original = await getSession();
  const first = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
  assert.equal(first.headers.get("set-cookie"), null);
  live.closeSession(id);
  await first.text();
  assert.equal((await getSession()).cookie.expires, original.cookie.expires);
  assert.equal((await getSession()).lastActivityAt, original.lastActivityAt);
  const second = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
  await new Promise((resolve) => sessions.destroy(id, resolve));
  live.closeSession(id);
  await second.text();
  assert.equal(await getSession(), undefined);
});

test("client disconnects, failed subscriptions and transport shutdown release subscriptions", async (t) => {
  const f = await fixture(t);
  const stream = await f.stream();
  await until(() => f.listeners.size === 1);
  stream.stop();
  await until(() => f.listeners.size === 0);
  const again = await f.stream();
  await until(() => f.listeners.size === 1);
  f.emit({ type: "error", error: new Error("watch failed") });
  await until(() => again.ended && f.listeners.size === 0);
  const final = await f.stream();
  await until(() => f.listeners.size === 1);
  f.live.close();
  await until(() => final.ended && f.listeners.size === 0);
  assert.equal(f.counts.unsubscribed, 3);
  const result = await fetch(`${f.base}/api/events`);
  assert.equal(result.status, 503);
});

class SlowResponse extends EventEmitter {
  constructor() { super(); this.frames = []; this.headersSent = false; this.destroyed = false; this.writableEnded = false; }
  status(value) { this.statusCode = value; return this; }
  set(value) { this.headers = value; return this; }
  flushHeaders() { this.headersSent = true; }
  json(value) { this.body = value; this.end(); return this; }
  write(value) { this.frames.push(value); return !value.includes("event: log"); }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
}

function slowFixture(t, options = {}) {
  let change, reads = 0, unsubscribed = false;
  const run = { id: "run-a", job_id: "job-a", status: "running" };
  const req = Object.assign(new EventEmitter(), { query: { jobId: "job-a", runId: "run-a" }, sessionID: "a", get: () => undefined });
  const res = new SlowResponse();
  const live = createLiveEvents({ config: {}, store: { getJob: () => ({ id: "job-a" }), getRun: () => run, getSetting: () => null, listRuns: () => [run] },
    getSnapshot: () => ({ jobs: [] }), publicRun: (value) => value, checkSession: async () => true,
    subscribeChanges: (_config, cb) => { change = cb; return () => { unsubscribed = true; }; },
    readLog: (_config, _run, { offset, limit }) => { reads++; return { offset, nextOffset: offset + limit, text: "x".repeat(limit), complete: false }; },
    ...options });
  const pending = live.handler(req, res);
  t.after(async () => { live.close(); await pending; });
  return { live, res, req, pending, emit: (value) => change(value), reads: () => reads, unsubscribed: () => unsubscribed };
}

test("slow clients buffer one log page, coalesce changes and resume only after drain", async (t) => {
  const f = slowFixture(t);
  await until(() => f.reads() === 1);
  for (let i = 0; i < 50; i++) f.emit({ type: "log", runId: "run-a" });
  await sleep(25);
  assert.equal(f.reads(), 1);
  assert.equal(f.res.frames.filter((frame) => frame.includes("event: log")).length, 1);
  assert.ok(Buffer.byteLength(f.res.frames.at(-1)) < 66000);
  f.res.emit("drain");
  await until(() => f.reads() === 2);
  f.live.close();
  await f.pending;
  assert.equal(f.unsubscribed(), true);
  assert.equal(f.res.listenerCount("drain"), 0);
});

test("slow client deadline disconnects and releases listeners rather than growing a queue", async (t) => {
  const f = slowFixture(t, { slowClientMs: 25 });
  await until(() => f.res.destroyed);
  await f.pending;
  assert.equal(f.reads(), 1);
  assert.equal(f.unsubscribed(), true);
  assert.equal(f.res.listenerCount("drain"), 0);
});
