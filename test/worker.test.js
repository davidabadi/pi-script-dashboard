"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { Store } = require("../lib/store");
const { Worker, childEnvironment } = require("../lib/worker");
const { readRunLog, runLogPath } = require("../lib/run-logs");

async function until(check, message = "Timed out waiting for worker", timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-worker-"));
  const config = { runtimeRoot: root, scriptRoot: path.join(root, "scripts"), configRoot: path.join(root, "configs"), logRoot: path.join(root, "logs"), lockRoot: path.join(root, "locks"), hookPort: 0, retentionDays: 30, maxLogBytes: options.maxLogBytes || 1024 * 1024 };
  for (const directory of [config.scriptRoot, config.configRoot, config.logRoot, config.lockRoot]) fs.mkdirSync(directory);
  const store = new Store(path.join(root, "dashboard.sqlite"));
  const environments = new Map();
  const worker = new Worker({
    store, config, pollMs: 25, logger: { error() {} },
    commandForJob(job) { return { executable: process.execPath, args: ["-e", fs.readFileSync(job.script, "utf8")] }; },
    spawnProcess(executable, args, spawnOptions) { environments.set(spawnOptions.env.DASHBOARD_RUN_ID, spawnOptions.env); return spawn(executable, args, spawnOptions); },
    ...options,
  });
  t.after(async () => { await worker.stop({ timeoutMs: 500 }); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let count = 0;
  function job(code, overrides = {}) {
    const script = path.join(config.scriptRoot, `job-${++count}.sh`);
    fs.writeFileSync(script, code);
    const saved = store.saveJob({ name: `Job ${count}`, script, ...overrides });
    store.setSetting("scheduler_pending", false);
    return saved;
  }
  function enqueue(saved) { return store.enqueue(saved.id).run; }
  const terminal = (run) => until(() => { const current = store.getRun(run.id); return current && !["queued", "running"].includes(current.status) && current; });
  return { root, config, store, worker, environments, job, enqueue, terminal };
}

test("worker records live output, actual exit status and isolated child credentials", async (t) => {
  const f = fixture(t, { environment: { ...process.env, SESSION_SECRET: "do-not-inherit", TEST_PASS: "password", CUSTOM_API_TOKEN: "secret" } });
  const saved = f.job("console.log('start'); setTimeout(() => { console.error('failure'); process.exit(7); }, 250);");
  const run = f.enqueue(saved);
  await f.worker.start();
  await until(() => readRunLog(f.config, f.store.getRun(run.id)).text.includes("start"));
  assert.equal(f.store.getRun(run.id).status, "running");
  const finished = await f.terminal(run);
  assert.equal(finished.status, "failed");
  assert.equal(finished.exit_code, 7);
  assert.match(readRunLog(f.config, finished).text, /start[\r\n]+failure/);
  const environment = f.environments.get(run.id);
  assert.equal(environment.SESSION_SECRET, undefined);
  assert.equal(environment.TEST_PASS, undefined);
  assert.equal(environment.CUSTOM_API_TOKEN, undefined);
  assert.equal(environment.DASHBOARD_RUN_ID, run.id);
  assert.ok(environment.DASHBOARD_RUN_TOKEN);
});

test("worker tracks different jobs concurrently and drain preserves queued work", async (t) => {
  const f = fixture(t);
  f.store.setSetting("worker_draining", "1");
  const first = f.enqueue(f.job("setTimeout(() => console.log('done'), 300);"));
  const second = f.enqueue(f.job("setTimeout(() => console.log('done'), 300);"));
  await f.worker.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(f.store.getRun(first.id).status, "queued");
  assert.equal(f.store.getSetting("worker_idle"), true);
  assert.equal(f.store.getSetting("worker_drain_ack"), true);
  f.store.setSetting("worker_draining", "0");
  await until(() => f.worker.active.size === 2);
  f.store.setSetting("worker_draining", "1");
  await Promise.all([f.terminal(first), f.terminal(second)]);
  assert.equal(f.store.getRun(first.id).status, "succeeded");
  assert.equal(f.store.getSetting("worker_idle"), true);
  assert.equal(f.store.getSetting("worker_drain_ack"), true);
});

test("scoped hooks deduplicate events, report partial results and expire on completion", async (t) => {
  const f = fixture(t);
  const release = path.join(f.root, "finish-hooks");
  const run = f.enqueue(f.job(`setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 25);`));
  await f.worker.start();
  const environment = await until(() => f.environments.get(run.id));
  f.store.setSetting("worker_draining", true);
  const send = (event, token = environment.DASHBOARD_RUN_TOKEN, extra = {}) => fetch(environment.DASHBOARD_HOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(event) });
  assert.equal((await send({ eventId: "bad", type: "log", message: "bad" }, "x".repeat(40))).status, 401);
  assert.equal((await send({ eventId: "browser", type: "log", message: "bad" }, undefined, { Origin: "http://localhost" })).status, 403);
  assert.equal((await send({ eventId: "large", type: "log", message: "x".repeat(32 * 1024) })).status, 413);
  assert.equal((await send({ eventId: "invalid", type: "succeeded", message: "cannot override exit" })).status, 400);
  assert.equal((await send({ eventId: "one", type: "log", message: "progress output" })).status, 202);
  const duplicate = await send({ eventId: "one", type: "log", message: "progress output" });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal((await send({ eventId: "two", type: "progress", message: "50 percent" })).status, 202);
  assert.equal(f.store.getRun(run.id).message, "50 percent");
  assert.equal((await send({ eventId: "three", type: "partial", message: "One item unavailable" })).status, 202);
  fs.writeFileSync(release, "finish");
  const finished = await f.terminal(run);
  assert.equal(finished.status, "partial");
  assert.equal(readRunLog(f.config, finished).text, "progress output\n");
  assert.equal((await send({ eventId: "late", type: "log", message: "late" })).status, 401);
});

test("worker preserves script locks and file logging without duplicating stdout", async (t) => {
  const f = fixture(t);
  const log = path.join(f.config.logRoot, "existing.log");
  fs.writeFileSync(log, "old\n");
  const source = `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'new\\n'); console.log('new');`;
  const run = f.enqueue(f.job(source, { log, log_mode: "file" }));
  await f.worker.start();
  const finished = await f.terminal(run);
  assert.equal(readRunLog(f.config, finished).text, "new\n");
  assert.equal(fs.readFileSync(log, "utf8"), "old\nnew\n");
  const lock = path.join(f.config.lockRoot, "script-owned.lock");
  fs.writeFileSync(lock, "preserve");
  const blocked = f.enqueue(f.job("throw new Error('must not run');", { lock }));
  const skipped = await f.terminal(blocked);
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.message, /existing lock/);
  assert.equal(fs.readFileSync(lock, "utf8"), "preserve");
});

test("partial hook cannot mask an unsuccessful process exit", async (t) => {
  const f = fixture(t);
  const release = path.join(f.root, "finish-failed");
  const run = f.enqueue(f.job(`setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(9); }, 25);`));
  await f.worker.start();
  const environment = await until(() => f.environments.get(run.id));
  const response = await fetch(environment.DASHBOARD_HOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${environment.DASHBOARD_RUN_TOKEN}` }, body: JSON.stringify({ eventId: "partial", type: "partial", message: "Warnings before failure" }) });
  assert.equal(response.status, 202);
  fs.writeFileSync(release, "finish");
  const finished = await f.terminal(run);
  assert.equal(finished.status, "failed");
  assert.equal(finished.exit_code, 9);
});

test("output above the cap is drained and script can finish", async (t) => {
  const f = fixture(t, { maxLogBytes: 1024 });
  const run = f.enqueue(f.job("process.stdout.write('x'.repeat(2 * 1024 * 1024), () => process.exit(0));"));
  await f.worker.start();
  const finished = await f.terminal(run);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.log_truncated, true);
  assert.equal(fs.statSync(runLogPath(f.config, run)).size, 1024);
});

test("stop interrupts the active child, leaves queued runs intact and releases singleton lock", async (t) => {
  const f = fixture(t, { concurrency: 1 });
  const first = f.enqueue(f.job("setInterval(() => {}, 1000);"));
  const second = f.enqueue(f.job("console.log('later');"));
  await f.worker.start();
  await until(() => f.worker.active.size === 1);
  await f.worker.stop({ timeoutMs: 500 });
  assert.equal(f.store.getRun(first.id).status, "interrupted");
  assert.equal(f.store.getRun(second.id).status, "queued");
  assert.equal(fs.existsSync(path.join(f.config.lockRoot, "worker.lock")), false);
});

test("Linux shutdown signals Bash's process group and flushes its TERM trap output", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t, { commandForJob: (job) => ({ executable: "/bin/bash", args: [job.script] }) });
  const run = f.enqueue(f.job("#!/bin/bash\ntrap 'printf \"terminated\\n\"; exit 0' TERM\nprintf 'ready\\n'\nsleep 60 &\nwait\n"));
  await f.worker.start();
  await until(() => readRunLog(f.config, f.store.getRun(run.id)).text.includes("ready"));
  const pid = f.worker.active.get(run.id).child.pid;
  await f.worker.stop({ timeoutMs: 3000 });
  assert.equal(f.store.getRun(run.id).status, "interrupted");
  assert.match(readRunLog(f.config, f.store.getRun(run.id)).text, /terminated/);
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
});

test("a second worker cannot recover the first worker's live runs", async (t) => {
  const f = fixture(t);
  const run = f.enqueue(f.job("setTimeout(() => process.exit(0), 350);"));
  await f.worker.start();
  const second = new Worker({ store: f.store, config: f.config, logger: { error() {} } });
  await assert.rejects(second.start(), /Another worker/);
  assert.equal(f.store.getRun(run.id).status, "running");
  assert.equal((await f.terminal(run)).status, "succeeded");
});

test("worker recovers abandoned runs, expires old logs and retains current jobs", async (t) => {
  const f = fixture(t);
  const old = f.enqueue(f.job("console.log('old');"));
  f.store.claimNext();
  f.store.completeRun(old.id, { status: "succeeded", exit_code: 0 });
  f.store.updateRun(old.id, { finished_at: "2020-01-01T00:00:00.000Z" });
  fs.mkdirSync(path.dirname(runLogPath(f.config, old)), { recursive: true });
  fs.writeFileSync(runLogPath(f.config, old), "expired");
  const abandoned = f.enqueue(f.job("console.log('not retried');"));
  f.store.claimNext();
  await f.worker.start();
  assert.equal(f.store.getRun(abandoned.id).status, "interrupted");
  assert.equal(f.store.getRun(old.id), null);
  assert.equal(fs.existsSync(runLogPath(f.config, old)), false);
  assert.ok(f.store.getJob(old.job_id));
});

test("child environment exposes only allowlisted runtime settings and scoped hook values", () => {
  assert.deepEqual(childEnvironment({ PATH: "safe", HOME: "/job", SESSION_SECRET: "secret", PASSWORD: "secret", API_TOKEN: "secret" }, { id: "run" }, "scoped", "local"), { PATH: "safe", HOME: "/job", DASHBOARD_RUN_ID: "run", DASHBOARD_RUN_TOKEN: "scoped", DASHBOARD_HOOK_URL: "local" });
});

test("worker process and scoped hooks survive an independently restarted web process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-services-"));
  const config = { runtimeRoot: root, scriptRoot: path.join(root, "scripts"), configRoot: path.join(root, "configs"), logRoot: path.join(root, "logs"), lockRoot: path.join(root, "locks"), hookPort: 0, retentionDays: 30, maxLogBytes: 1024 * 1024 };
  for (const directory of [config.scriptRoot, config.configRoot, config.logRoot, config.lockRoot]) fs.mkdirSync(directory);
  const dbFile = path.join(root, "dashboard.sqlite");
  const store = new Store(dbFile);
  const children = [];
  const messages = new Map();
  let serviceError = "";
  function service(code) {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    children.push(child);
    messages.set(child, []);
    child.on("message", (message) => messages.get(child).push(message));
    child.stderr.on("data", (data) => { serviceError += data.toString(); });
    return child;
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null || child.signalCode !== null, "Service did not stop");
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const release = path.join(root, "finish");
  const script = path.join(config.scriptRoot, "long.sh");
  fs.writeFileSync(script, `console.log('running independently'); setInterval(() => { if(require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 25);`);
  const job = store.saveJob({ name: "Independent backup", script });
  store.setSetting("scheduler_pending", false);
  const run = store.enqueue(job.id).run;
  const workerCode = `
    const {Store}=require(${JSON.stringify(require.resolve("../lib/store"))});
    const {Worker}=require(${JSON.stringify(require.resolve("../lib/worker"))});
    const store=new Store(${JSON.stringify(dbFile)});
    const worker=new Worker({store,config:${JSON.stringify(config)},pollMs:25,
      commandForJob(job){return {executable:process.execPath,args:['-e',require('node:fs').readFileSync(job.script,'utf8')]};},
      spawnProcess(executable,args,options){ process.send({type:'run',url:options.env.DASHBOARD_HOOK_URL,token:options.env.DASHBOARD_RUN_TOKEN}); return require('node:child_process').spawn(executable,args,options); }
    });
    worker.start().then(()=>process.send({type:'ready'})).catch(error=>{console.error(error);process.exit(1);});
    process.on('SIGTERM',async()=>{await worker.stop({timeoutMs:500});store.close();process.exit(0);});
  `;
  const worker = service(workerCode);
  const hook = await until(() => messages.get(worker).find((message) => message.type === "run"), `Worker did not start: ${serviceError}`);
  const webCode = "const s=require('node:http').createServer((q,r)=>r.end('web')).listen(0,'127.0.0.1',()=>process.send({type:'ready'}));process.on('SIGTERM',()=>s.close(()=>process.exit(0)));";
  const web = service(webCode);
  await until(() => messages.get(web).some((message) => message.type === "ready"));
  await stop(web);
  assert.equal(store.getRun(run.id).status, "running");
  const duringRestart = await fetch(hook.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hook.token}` }, body: JSON.stringify({ eventId: "during-restart", type: "log", message: "hook stayed available" }) });
  assert.equal(duringRestart.status, 202);
  const restartedWeb = service(webCode);
  await until(() => messages.get(restartedWeb).some((message) => message.type === "ready"));
  assert.equal(worker.exitCode, null);
  assert.equal(store.getRun(run.id).status, "running");
  fs.writeFileSync(release, "finish");
  const finished = await until(() => { const row = store.getRun(run.id); return row.status === "succeeded" && row; });
  assert.match(readRunLog(config, finished).text, /hook stayed available/);
});
