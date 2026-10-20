"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const session = require("express-session");
const { createApp } = require("../server");
const { readConfig } = require("../lib/config");
const { Store } = require("../lib/store");
const { RunLogWriter } = require("../lib/run-logs");

async function fixture(t, { cronFailure = false, legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-web-"));
  const env = { NODE_ENV: "development", RUNTIME_ROOT: root, LOG_ROOT: path.join(root, "logs"), LOCK_ROOT: path.join(root, "locks"),
    SESSION_SECRET: "fixture-only-session-secret-32-bytes", TRUSTED_HOSTS: "localhost:8080" };
  const config = readConfig(env);
  if (legacy) fs.writeFileSync(config.dataFile, "{}");
  const store = new Store(config.dbFile, { legacyFile: config.dataFile });
  let cron = "13 4 * * * /bin/true # unrelated\n";
  const sessions = new session.MemoryStore();
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  env.TRUSTED_HOSTS = `127.0.0.1:${server.address().port}`;
  const app = createApp({ env, config, store, sessionStore: sessions,
    authenticate: async (username, password) => username === "admin" && password === "fixture-only",
    cronIO: { readCrontab: () => cron, writeCrontab: (value) => { if (cronFailure) throw new Error("fixture cron unavailable"); cron = value; } } });
  server.on("request", app);
  let cookie = "", csrf;
  async function request(url, options = {}) {
    const headers = { ...options.headers };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { ...options, headers, redirect: "manual" });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  }
  async function login() {
    const page = await (await request("/login")).text();
    csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const response = await request("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "fixture-only", _csrf: csrf }) });
    assert.equal(response.status, 302, await response.text());
    if (!legacy) csrf = /name="_csrf" value="([^"]+)"/.exec(await (await request("/")).text())[1];
  }
  async function post(url, body, headers = {}) {
    return request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrf, ...headers }, body: new URLSearchParams(body) });
  }
  async function addJob(overrides = {}) {
    const values = { name: "Backup", script: path.join(config.scriptRoot, "backup.sh"), log: path.join(config.logRoot, "backup.log"),
      lock: path.join(config.lockRoot, "backup.lock"), timer: "0 2 * * *", content: "echo hello", config_enabled: "false", log_mode: "stdout", editor_ready: "true", ...overrides };
    assert.equal((await post("/new", values)).status, 302);
    const saved = store.getJobByName(values.name);
    if (!saved) assert.fail(await (await request("/")).text());
    return { saved, values };
  }
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, env, config, store, sessions, server, request, login, post, addJob, cron: () => cron };
}

test("web APIs require login and browser mutations still require CSRF and same origin", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/jobs")).status, 401);
  await f.login();
  assert.equal((await f.request("/new")).status, 200);
  assert.equal((await f.request("/new", { method: "POST" })).status, 403);
  assert.equal((await f.post("/new", {}, { Origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await f.request("/api/jobs")).status, 200);
});

test("CRUD persists SQLite metadata, keeps permanent IDs, synchronizes only owned cron and validates writes", async (t) => {
  const f = await fixture(t); await f.login();
  const { saved, values } = await f.addJob();
  assert.equal(saved.log_mode, "stdout");
  assert.equal(fs.readFileSync(saved.script, "utf8"), "echo hello");
  assert.match(f.cron(), /13 4 \* \* \* \/bin\/true # unrelated/);
  assert.ok(f.cron().includes(`pi-dashboard:${saved.id}`));
  assert.equal(f.store.getSetting("scheduler_pending"), false);
  assert.equal((await f.request("/edit/Backup")).status, 200);
  await f.post("/edit/Backup", { ...values, name: "Renamed", content: "echo updated", log_mode: "file" });
  const renamed = f.store.getJobByName("Renamed");
  assert.equal(renamed.id, saved.id);
  assert.equal(renamed.log_mode, "file");
  assert.equal(f.store.getJobByName("Backup"), null);
  assert.equal(f.cron().split(`pi-dashboard:${saved.id}`).length, 2);
  await f.post("/new", { ...values, name: "Renamed", content: "must not overwrite" });
  assert.equal(fs.readFileSync(saved.script, "utf8"), "echo updated");
  await f.post("/new", { ...values, name: "Traversal", script: path.join(f.root, "escape.sh") });
  assert.equal(fs.existsSync(path.join(f.root, "escape.sh")), false);
  await f.post("/toggle_cron/Renamed", {});
  assert.equal(f.store.getJob(renamed.id).paused, true);
  assert.ok(f.cron().split("\n").find(line => line.includes(renamed.id)).startsWith("# "));
});

test("manual enqueue prevents overlaps, skipped cron does not hide running status, and busy files cannot be edited", async (t) => {
  const f = await fixture(t); await f.login();
  const { saved, values } = await f.addJob();
  await f.post("/run/Backup", {}); await f.post("/run/Backup", {});
  assert.equal(f.store.listRuns(saved.id).length, 1);
  const run = f.store.claimNext();
  f.store.enqueue(saved.id, "cron");
  const jobs = await (await f.request("/api/jobs")).json();
  assert.equal(jobs.jobs[0].status, "running");
  assert.equal(jobs.jobs[0].latest_run.id, run.id);
  await f.post("/edit/Backup", { ...values, content: "unsafe edit" });
  assert.equal(fs.readFileSync(saved.script, "utf8"), "echo hello");
  assert.equal(f.store.getSetting("scheduler_pending"), false);
  f.store.completeRun(run.id, { status: "succeeded", exit_code: 0 });
  assert.equal((await (await f.request("/api/jobs")).json()).jobs[0].status, "succeeded");
});

test("run history/log API escapes hostile output, bounds reads and excludes hook credentials", async (t) => {
  const f = await fixture(t); await f.login();
  const { saved } = await f.addJob();
  const queued = f.store.enqueue(saved.id).run;
  const run = f.store.claimNext();
  f.store.updateRun(run.id, { hook_hash: "sensitive-credential-hash", message: "</script><script>alert(1)</script>" });
  const writer = new RunLogWriter(f.config, run);
  writer.append("<img src=x onerror=alert(1)>\n" + "x".repeat(100000)); writer.close();
  const response = await f.request(`/api/runs/${queued.id}/log?offset=0`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.ok(data.text.startsWith("<img"));
  assert.ok(Buffer.byteLength(data.text) <= 65536);
  assert.equal(JSON.stringify(data).includes("sensitive-credential-hash"), false);
  assert.equal(data.run.snapshot, undefined);
  assert.equal((await f.request(`/api/runs/${run.id}/log?offset=-1`)).status, 400);
  assert.equal((await f.request(`/api/runs/${run.id}/log?offset=NaN`)).status, 400);
  const history = await (await f.request(`/api/jobs/${saved.id}/runs`)).json();
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].hook_hash, undefined);
  const html = await (await f.request("/log/Backup")).text();
  assert.equal(html.includes("</script><script>alert(1)</script>"), false);
  assert.ok(html.includes("\\u003c"));
  const home = await (await f.request("/")).text();
  assert.equal(home.includes("</script><script>alert(1)</script>"), false);
});

test("failed schedule sync leaves dispatch paused and gives a visible recovery action", async (t) => {
  const f = await fixture(t, { cronFailure: true }); await f.login();
  const { saved } = await f.addJob();
  assert.equal(f.store.getSetting("scheduler_pending"), true);
  f.store.enqueue(saved.id);
  assert.equal(f.store.claimNext(), null);
  const html = await (await f.request("/")).text();
  assert.match(html, /Retry schedule sync/);
  assert.match(html, /fixture cron unavailable/);
});

test("migration gates web execution without overwriting legacy JSON", async (t) => {
  const f = await fixture(t, { legacy: true }); await f.login();
  assert.equal((await f.request("/")).status, 503);
  assert.equal((await f.request("/api/jobs")).status, 503);
  assert.equal(fs.readFileSync(f.config.dataFile, "utf8"), "{}");
  assert.equal(f.store.listJobs().length, 0);
});

test("expired sessions produce API 401, consistent with browser reauthentication", async (t) => {
  const f = await fixture(t); await f.login();
  await new Promise((resolve, reject) => f.sessions.all((error, values) => {
    if (error) return reject(error);
    const [id, value] = Object.entries(values).find(([, value]) => value.logged_in);
    value.absoluteExpiresAt = Date.now() - 1;
    f.sessions.set(id, value, (failure) => failure ? reject(failure) : resolve());
  }));
  assert.equal((await f.request("/api/jobs")).status, 401);
  assert.equal((await f.request("/update-status")).status, 401);
  assert.equal((await f.request("/")).headers.get("location"), "/login");
});

test("saving before the editors load cannot replace existing script contents", async (t) => {
  const f = await fixture(t); await f.login();
  const { saved, values } = await f.addJob();
  await f.post("/edit/Backup", { ...values, content: "", editor_ready: "false" });
  assert.equal(fs.readFileSync(saved.script, "utf8"), "echo hello");
  const form = await (await f.request("/edit/Backup")).text();
  assert.match(form, /id="save-script"[^>]*disabled/);
  assert.match(form, /id="hidden-content" value="echo hello"/);
});

test("durable update waiting and terminal failure are returned without guessing from lock files", async (t) => {
  const f = await fixture(t); await f.login();
  f.store.setSetting("update_status", { status: "waiting", message: "Waiting for backup" });
  let data = await (await f.request("/update-status")).json();
  assert.equal(data.updating, true);
  assert.equal(data.message, "Waiting for backup");
  f.store.setSetting("update_status", { status: "failed", message: "Update interrupted" });
  data = await (await f.request("/update-status")).json();
  assert.equal(data.status, "failed");
  assert.equal(data.updating, false);
});

test("background polling does not extend an unattended administrator's idle deadline", async (t) => {
  const f = await fixture(t); await f.login();
  let expected;
  await new Promise((resolve, reject) => f.sessions.all((error, values) => {
    if (error) return reject(error);
    const [id, value] = Object.entries(values).find(([, item]) => item.logged_in);
    value.lastActivityAt = expected = Date.now() - 60000;
    f.sessions.set(id, value, (failure) => failure ? reject(failure) : resolve());
  }));
  assert.equal((await f.request("/api/jobs")).status, 200);
  await new Promise((resolve, reject) => f.sessions.all((error, values) => {
    if (error) return reject(error);
    const [id, value] = Object.entries(values).find(([, item]) => item.logged_in);
    assert.equal(value.lastActivityAt, expected);
    value.lastActivityAt = Date.now() - 1800001;
    f.sessions.set(id, value, (failure) => failure ? reject(failure) : resolve());
  }));
  assert.equal((await f.request("/api/jobs")).status, 401);
});
