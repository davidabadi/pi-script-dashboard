"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { timingSafeEqualText, validateManagedPath } = require("../security");
const { FileLogCapture, RunLogWriter, removeRunLog } = require("./run-logs");

const MAX_EVENT_BYTES = 32 * 1024;
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"];

function isEnabled(value) { return value === true || value === 1 || value === "1"; }

function childEnvironment(environment, run, token, hookUrl) {
  const result = {};
  for (const key of ENV_ALLOWLIST) if (typeof environment[key] === "string") result[key] = environment[key];
  return { ...result, DASHBOARD_RUN_ID: run.id, DASHBOARD_HOOK_URL: hookUrl, DASHBOARD_RUN_TOKEN: token };
}

function defaultCommand(job, config) {
  validateManagedPath(job.script, config.scriptRoot, [".sh"]);
  if (job.config_path) validateManagedPath(job.config_path, config.configRoot, [".conf", ".json", ".yaml", ".yml"]);
  return { executable: "/bin/bash", args: [job.script, ...(job.config_path ? [job.config_path] : [])] };
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

class Worker {
  constructor({ store, config, commandForJob = defaultCommand, spawnProcess = spawn, environment = process.env, pollMs = 250, concurrency = 2, logger = console } = {}) {
    if (!store || !config) throw new Error("Worker requires a store and configuration.");
    this.store = store;
    this.config = config;
    this.commandForJob = commandForJob;
    this.spawnProcess = spawnProcess;
    this.environment = environment;
    this.pollMs = pollMs;
    this.concurrency = Math.max(1, Number(concurrency) || 2);
    this.logger = logger;
    this.active = new Map();
    this.stopping = false;
    this.started = false;
    this.ticking = false;
    this.lastRetention = 0;
    this.lastHeartbeat = 0;
    this.lastIdle = undefined;
    this.lockFile = path.join(config.lockRoot, "worker.lock");
    this.lockOwned = false;
    this.server = http.createServer((req, res) => this.handleHook(req, res).catch((error) => {
      this.logger.error("Hook request failed:", error.message);
      if (!res.headersSent) writeJson(res, 500, { error: "The event could not be recorded." });
      else res.destroy();
    }));
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
  }

  async start() {
    if (this.started) return this;
    // Binding happens before recovery so another worker cannot interrupt this
    // worker's runs simply by opening the same database.
    await new Promise((resolve, reject) => {
      const fail = (error) => { this.server.off("listening", ready); reject(error); };
      const ready = () => { this.server.off("error", fail); resolve(); };
      this.server.once("error", fail);
      this.server.once("listening", ready);
      this.server.listen(Number(this.config.hookPort ?? 8081), "127.0.0.1");
    });
    try {
      this.acquireLock();
      if (!this.store.isReady()) throw new Error("Complete the database and cron migration before starting the worker.");
      this.store.recoverRunning();
      this.started = true;
      this.timer = setInterval(() => this.tick(), this.pollMs);
      this.tick();
      return this;
    } catch (error) {
      this.releaseLock();
      await new Promise((resolve) => this.server.close(resolve));
      throw error;
    }
  }

  acquireLock() {
    fs.mkdirSync(this.config.lockRoot, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(this.lockFile, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); }
      finally { fs.closeSync(fd); }
      this.lockOwned = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stats = fs.lstatSync(this.lockFile);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Worker lock is not a regular file.");
      const pid = Number(fs.readFileSync(this.lockFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Worker lock is invalid; inspect it before restarting.");
      try { process.kill(pid, 0); }
      catch (probe) {
        if (probe.code !== "ESRCH") throw probe;
        fs.unlinkSync(this.lockFile);
        return this.acquireLock();
      }
      throw new Error("Another worker already holds the worker lock.");
    }
  }

  releaseLock() {
    if (!this.lockOwned) return;
    try { fs.unlinkSync(this.lockFile); }
    catch (error) { if (error.code !== "ENOENT") this.logger.error("Worker lock cleanup failed:", error.message); }
    this.lockOwned = false;
  }

  get hookUrl() {
    const address = this.server.address();
    return `http://127.0.0.1:${address ? address.port : this.config.hookPort}`;
  }

  tick() {
    if (!this.started || this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastHeartbeat >= 5000) {
        this.store.setSetting("worker_heartbeat", new Date().toISOString());
        this.lastHeartbeat = Date.now();
      }
      for (const active of this.active.values()) {
        if (active.capture) this.flushCapture(active);
      }
      if (!isEnabled(this.store.getSetting("worker_draining")) && !this.store.getSetting("scheduler_pending")) {
        while (this.active.size < this.concurrency) {
          const run = this.store.claimNext();
          if (!run) break;
          this.launch(run);
        }
      }
      this.publishIdle();
      if (Date.now() - this.lastRetention > 60 * 60 * 1000) {
        this.lastRetention = Date.now();
        for (const run of this.store.purgeRuns({ retentionDays: this.config.retentionDays ?? 30 })) removeRunLog(this.config, run);
      }
    } catch (error) {
      this.logger.error("Worker polling failed:", error.message);
    } finally {
      this.ticking = false;
    }
  }

  publishIdle() {
    const idle = this.active.size === 0;
    if (idle !== this.lastIdle) {
      this.store.setSetting("worker_idle", idle);
      this.lastIdle = idle;
    }
    const acknowledged = idle && isEnabled(this.store.getSetting("worker_draining"));
    // Control clears the persisted acknowledgment for each new request, even
    // when the worker's own idle/drain state has not otherwise changed.
    if (this.store.getSetting("worker_drain_ack") !== acknowledged) this.store.setSetting("worker_drain_ack", acknowledged);
  }

  launch(run) {
    let writer;
    try {
      const job = run.snapshot;
      if (!job) throw new Error("Run is missing its job snapshot.");
      if (job.lock) {
        validateManagedPath(job.lock, this.config.lockRoot);
        if (fs.existsSync(job.lock)) {
          this.store.completeRun(run.id, { status: "skipped", exit_code: null, message: "The script's existing lock blocks this run. Inspect the script before removing its lock." });
          return;
        }
      }
      const command = this.commandForJob(job, this.config, run);
      const token = crypto.randomBytes(32).toString("base64url");
      this.store.updateRun(run.id, { hook_hash: crypto.createHash("sha256").update(token).digest("hex") });
      writer = new RunLogWriter(this.config, run, (flags) => this.store.updateRun(run.id, flags));
      let capture = null;
      if (run.log_mode === "file") {
        validateManagedPath(job.log, this.config.logRoot, [".log"]);
        capture = new FileLogCapture(job.log, writer);
      }
      const child = this.spawnProcess(command.executable, command.args || [], {
        cwd: command.cwd || this.config.scriptRoot,
        env: childEnvironment(this.environment, run, token, `${this.hookUrl}/api/runs/${encodeURIComponent(run.id)}/events`),
        stdio: ["ignore", "pipe", "pipe"],
        // Separate process groups allow a direct CLI shutdown to signal the
        // complete script tree; systemd also owns every child via the cgroup.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const active = { run, writer, capture, child, finished: false, spawnError: null, interrupted: false };
      this.active.set(run.id, active);
      const consume = (data) => {
        if (run.log_mode !== "file") {
          try { writer.append(data); }
          catch (error) { this.captureFailure(active, error); }
        }
      };
      // Always drain both streams, even in file mode or after the retention cap.
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", (error) => { active.spawnError = error; });
      child.once("close", (code, signal) => this.finish(active, code, signal));
    } catch (error) {
      if (writer) writer.close();
      this.store.completeRun(run.id, { status: "failed", exit_code: null, message: error.message });
    }
  }

  captureFailure(active, error) {
    active.writer.markCaptureGap();
    this.logger.error(`Log capture failed for ${active.run.id}:`, error.message);
  }

  flushCapture(active) {
    try { active.capture.flush(); }
    catch (error) { this.captureFailure(active, error); }
  }

  finish(active, code, signal) {
    if (active.finished) return;
    active.finished = true;
    if (active.capture) this.flushCapture(active);
    try { active.writer.close(); }
    catch (error) { this.logger.error("Run log close failed:", error.message); }
    try {
      const current = this.store.getRun(active.run.id);
      const status = active.interrupted || signal ? "interrupted" : active.spawnError || code !== 0 ? "failed" : current.partial ? "partial" : "succeeded";
      const message = active.spawnError ? active.spawnError.message : signal ? `Script interrupted by ${signal}.` : current.message || "";
      this.store.completeRun(active.run.id, { status, exit_code: Number.isInteger(code) ? code : null, message });
    } catch (error) {
      this.logger.error("Run completion could not be saved:", error.message);
    } finally {
      this.active.delete(active.run.id);
      this.publishIdle();
      if (!this.stopping) this.tick();
    }
  }

  async handleHook(req, res) {
    const address = req.socket.remoteAddress;
    if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return writeJson(res, 403, { error: "Loopback requests only." });
    const route = /^\/api\/runs\/([a-zA-Z0-9_-]{1,128})\/events$/.exec(req.url || "");
    if (req.method !== "POST" || !route) return writeJson(res, 404, { error: "Not found." });
    // Machine hooks never accept browser credentials or cross-origin requests.
    if (req.headers.origin) return writeJson(res, 403, { error: "Browser requests are not accepted." });
    const run = this.store.getRun(route[1]);
    const active = this.active.get(route[1]);
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization || "");
    const suppliedHash = bearer ? crypto.createHash("sha256").update(bearer[1]).digest("hex") : "";
    if (!run || !active || run.status !== "running" || !run.hook_hash || !timingSafeEqualText(suppliedHash, run.hook_hash)) return writeJson(res, 401, { error: "Invalid or expired run token." });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return writeJson(res, 415, { error: "Send an application/json event." });
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > MAX_EVENT_BYTES) { req.resume(); return writeJson(res, 413, { error: "Event is too large." }); }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_EVENT_BYTES) { req.resume(); return writeJson(res, 413, { error: "Event is too large." }); }
      chunks.push(chunk);
    }
    let event;
    try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return writeJson(res, 400, { error: "Invalid JSON." }); }
    if (!event || Array.isArray(event) || typeof event.eventId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(event.eventId) || !["progress", "log", "partial"].includes(event.type) || typeof event.message !== "string" || Buffer.byteLength(event.message) > MAX_EVENT_BYTES - 256) return writeJson(res, 400, { error: "Invalid run event." });
    // The job may have completed while this request body was being received.
    if (this.active.get(run.id) !== active || this.store.getRun(run.id)?.status !== "running") return writeJson(res, 401, { error: "Run token expired." });
    // Event IDs are durable deduplication keys, not a second uncapped log store.
    const inserted = this.store.recordHookEvent(run.id, event.eventId, event.type, "");
    if (!inserted) return writeJson(res, 200, { accepted: true, duplicate: true });
    if (event.type === "log") active.writer.append(event.message.endsWith("\n") ? event.message : `${event.message}\n`);
    if (event.type === "progress") this.store.updateRun(run.id, { message: event.message });
    if (event.type === "partial") this.store.updateRun(run.id, { partial: 1, message: event.message });
    writeJson(res, 202, { accepted: true });
  }

  signalChild(active, signal) {
    if (!active.child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-active.child.pid, signal);
      else active.child.kill(signal);
    } catch (error) { if (error.code !== "ESRCH") this.logger.error("Unable to signal script:", error.message); }
  }

  async stop({ timeoutMs = 10_000 } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    for (const active of this.active.values()) { active.interrupted = true; this.signalChild(active, "SIGTERM"); }
    const deadline = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.active.size) {
      for (const active of this.active.values()) this.signalChild(active, "SIGKILL");
      const killDeadline = Date.now() + 2000;
      while (this.active.size && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
      for (const active of [...this.active.values()]) this.finish(active, null, "SIGKILL");
    }
    this.store.setSetting("worker_idle", true);
    this.store.setSetting("worker_drain_ack", false);
    this.store.setSetting("worker_heartbeat", null);
    if (this.server.listening) {
      this.server.closeIdleConnections?.();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.releaseLock();
    this.started = false;
  }
}

module.exports = { Worker, childEnvironment, isEnabled };
