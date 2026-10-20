"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { publishStateChange } = require("./change-channel");

const TERMINAL = new Set(["succeeded", "failed", "partial", "interrupted", "skipped"]);
const RUN_FIELDS = new Set(["status", "started_at", "finished_at", "exit_code", "message", "partial", "log_mode", "log_truncated", "capture_gap", "hook_hash"]);
const JOB_FIELDS = ["name", "script", "log", "lock", "config_path", "log_mode", "schedule", "paused", "position"];
const now = () => new Date().toISOString();

function jobRow(row) {
  return row ? { ...row, paused: Boolean(row.paused) } : null;
}
function runRow(row) {
  return row ? { ...row, partial: Boolean(row.partial), log_truncated: Boolean(row.log_truncated), capture_gap: Boolean(row.capture_gap), snapshot: JSON.parse(row.snapshot) } : null;
}

class Store {
  constructor(dbFile, { legacyFile } = {}) {
    this.dbFile = dbFile;
    if (dbFile !== ":memory:") {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
      if (fs.existsSync(dbFile) && fs.lstatSync(dbFile).isSymbolicLink()) throw new Error("Database must not be a symbolic link.");
      const fd = fs.openSync(dbFile, "a", 0o600);
      fs.closeSync(fd);
      fs.chmodSync(dbFile, 0o600);
    }
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    if (this.db.prepare("PRAGMA user_version").get().user_version > 1) {
      this.close();
      throw new Error("Database schema is newer than this release.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, script TEXT NOT NULL,
        log TEXT NOT NULL DEFAULT '', lock TEXT NOT NULL DEFAULT '', config_path TEXT NOT NULL DEFAULT '',
        log_mode TEXT NOT NULL DEFAULT 'stdout' CHECK(log_mode IN ('file','stdout')),
        schedule TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0, last_status TEXT, last_started_at TEXT,
        last_finished_at TEXT, last_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), job_name TEXT NOT NULL,
        source TEXT NOT NULL, requested_by TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','partial','interrupted','skipped')),
        queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, exit_code INTEGER,
        message TEXT NOT NULL DEFAULT '', partial INTEGER NOT NULL DEFAULT 0,
        log_mode TEXT NOT NULL CHECK(log_mode IN ('file','stdout')),
        log_truncated INTEGER NOT NULL DEFAULT 0, capture_gap INTEGER NOT NULL DEFAULT 0,
        hook_hash TEXT, snapshot TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_job ON runs(job_id) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS runs_job_history ON runs(job_id, queued_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status, queued_at, id);
      CREATE TABLE IF NOT EXISTS hook_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL, PRIMARY KEY(run_id,event_id)
      );
      PRAGMA user_version=1;
    `);
    this.transaction(() => {
      if (this.getSetting("ready") === undefined) {
        this.setSetting("ready", !(legacyFile && fs.existsSync(legacyFile)));
        this.setSetting("scheduler_pending", false);
      }
    });
    if (dbFile !== ":memory:") fs.chmodSync(dbFile, 0o600);
  }

  close() { this.db.close(); }
  changed() {
    if (this.transactionDepth > 0) this.changePending = true;
    else publishStateChange(this.dbFile);
  }
  transaction(callback) {
    if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") throw new Error("Store transactions require a synchronous callback.");
    const nested = (this.transactionDepth || 0) > 0;
    const previousChange = this.changePending;
    let committed = false;
    const savepoint = `store_${this.transactionCounter = (this.transactionCounter || 0) + 1}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    try {
      const result = callback();
      if (result && typeof result.then === "function") throw new Error("Store transactions must not return a Promise.");
      this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      committed = true;
      return result;
    } catch (error) {
      try { this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); } catch {}
      this.changePending = previousChange;
      throw error;
    } finally {
      this.transactionDepth -= 1;
      if (committed && !nested && this.changePending) {
        this.changePending = false;
        publishStateChange(this.dbFile);
      }
    }
  }
  getSetting(key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : undefined;
  }
  setSetting(key, value) {
    const heartbeat = key === "worker_heartbeat";
    const previousHeartbeat = heartbeat ? Date.parse(this.getSetting(key) || "") : NaN;
    const result = this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value").run(key, JSON.stringify(value));
    // Routine heartbeats must not refresh the dashboard. Worker start/stop and
    // recovery after a stale heartbeat are meaningful presence changes, though.
    const nextHeartbeat = heartbeat ? Date.parse(value || "") : NaN;
    const presenceChanged = heartbeat && (Number.isFinite(previousHeartbeat) !== Number.isFinite(nextHeartbeat) ||
      (Number.isFinite(nextHeartbeat) && Date.now() - previousHeartbeat >= 10000));
    if (result.changes && (!heartbeat || presenceChanged)) this.changed();
  }
  isReady() { return this.getSetting("ready") === true; }
  markReady() { this.setSetting("ready", true); }
  listJobs() { return this.db.prepare("SELECT * FROM jobs ORDER BY position,id").all().map(jobRow); }
  getJob(id) { return jobRow(this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id)); }
  getJobByName(name) { return jobRow(this.db.prepare("SELECT * FROM jobs WHERE name=?").get(name)); }

  saveJob(input) {
    return this.transaction(() => {
      const existing = input.id ? this.getJob(input.id) : null;
      if (input.id && !existing) throw new Error("Job not found.");
      const job = {
        id: existing ? existing.id : randomUUID(), name: "", script: "", log: "", lock: "", config_path: "",
        log_mode: "stdout", schedule: "", paused: false,
        position: this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM jobs").get().n,
        ...existing,
      };
      for (const field of JOB_FIELDS) if (input[field] !== undefined) job[field] = input[field];
      if (!job.name || !job.script || !["file", "stdout"].includes(job.log_mode)) throw new Error("Invalid job metadata.");
      if (job.log_mode === "file" && !job.log) throw new Error("File log mode requires a log path.");
      if (!Number.isSafeInteger(job.position)) throw new Error("Invalid job position.");
      const values = JOB_FIELDS.map((field) => field === "paused" ? Number(Boolean(job[field])) : job[field]);
      this.db.prepare(`INSERT INTO jobs(id,${JOB_FIELDS.join(",")}) VALUES(?,${JOB_FIELDS.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${JOB_FIELDS.map((field) => `${field}=excluded.${field}`).join(",")}`).run(job.id, ...values);
      this.changed();
      this.setSetting("scheduler_pending", true);
      return this.getJob(job.id);
    });
  }

  reorderJobs(ids) {
    this.transaction(() => {
      const current = this.listJobs();
      if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || current.some((job) => !ids.includes(job.id))) throw new Error("Order must contain every job exactly once.");
      const update = this.db.prepare("UPDATE jobs SET position=? WHERE id=?");
      ids.forEach((id, position) => update.run(position, id));
      if (current.some((job, index) => job.id !== ids[index])) this.changed();
    });
  }

  getRun(id) { return runRow(this.db.prepare("SELECT * FROM runs WHERE id=?").get(id)); }
  listRuns(jobId, { before, limit = 30 } = {}) {
    limit = Math.min(100, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : 30));
    const cursor = before ? this.getRun(before) : null;
    if (before && (!cursor || cursor.job_id !== jobId)) return [];
    const rows = cursor
      ? this.db.prepare("SELECT * FROM runs WHERE job_id=? AND (queued_at<? OR (queued_at=? AND id<?)) ORDER BY queued_at DESC,id DESC LIMIT ?").all(jobId, cursor.queued_at, cursor.queued_at, cursor.id, limit)
      : this.db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY queued_at DESC,id DESC LIMIT ?").all(jobId, limit);
    return rows.map(runRow);
  }

  enqueue(jobId, source = "manual", requestedBy = "") {
    return this.transaction(() => {
      if (!this.isReady()) throw new Error("Registry migration must finish before runs can be queued.");
      const job = this.getJob(jobId);
      if (!job) throw new Error("Job not found.");
      if (!["manual", "cron"].includes(source)) throw new Error("Invalid run source.");
      const active = this.db.prepare("SELECT * FROM runs WHERE job_id=? AND status IN ('queued','running') LIMIT 1").get(jobId);
      if (active && source !== "cron") return { accepted: false, run: runRow(active) };
      const id = randomUUID();
      const timestamp = now();
      const status = active ? "skipped" : "queued";
      this.db.prepare("INSERT INTO runs(id,job_id,job_name,source,requested_by,status,queued_at,finished_at,message,log_mode,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, job.id, job.name, source, requestedBy, status, timestamp, active ? timestamp : null, active ? "A run for this job is already queued or running." : "", job.log_mode, JSON.stringify(job));
      this.changed();
      return { accepted: !active, run: this.getRun(id) };
    });
  }

  claimNext() {
    return this.transaction(() => {
      const drain = this.getSetting("worker_draining");
      if (!this.isReady() || this.getSetting("scheduler_pending") || drain === true || drain === "1" || drain === 1) return null;
      const running = this.db.prepare("SELECT snapshot FROM runs WHERE status='running'").all().map((row) => JSON.parse(row.snapshot));
      const run = this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY queued_at,id").all().find((candidate) => {
        const job = JSON.parse(candidate.snapshot);
        return !running.some((active) => (job.lock && job.lock === active.lock) || (job.log_mode === "file" && active.log_mode === "file" && job.log && job.log === active.log));
      });
      if (!run) return null;
      const started = now();
      this.db.prepare("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(started, run.id);
      this.db.prepare("UPDATE jobs SET last_status='running',last_started_at=?,last_finished_at=NULL,last_run_id=? WHERE id=?").run(started, run.id, run.job_id);
      this.changed();
      return this.getRun(run.id);
    });
  }

  updateRun(id, fields) {
    const entries = Object.entries(fields).filter(([key]) => RUN_FIELDS.has(key));
    if (entries.length !== Object.keys(fields).length) throw new Error("Invalid run update.");
    if (fields.status && !["queued", "running", ...TERMINAL].includes(fields.status)) throw new Error("Invalid run status.");
    if (entries.length && this.db.prepare(`UPDATE runs SET ${entries.map(([field]) => `${field}=?`).join(",")} WHERE id=?`).run(...entries.map(([field, value]) => ["partial", "log_truncated", "capture_gap"].includes(field) ? Number(Boolean(value)) : value), id).changes) this.changed();
    return this.getRun(id);
  }

  completeRun(id, { status, exit_code = null, message = "" }) {
    if (!TERMINAL.has(status)) throw new Error("Invalid completed run status.");
    return this.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new Error("Run not found.");
      if (TERMINAL.has(run.status)) return run;
      const finished = now();
      this.db.prepare("UPDATE runs SET status=?,finished_at=?,exit_code=?,message=?,hook_hash=NULL WHERE id=?").run(status, finished, exit_code, message, id);
      // Busy cron ticks are inserted directly by enqueue. A claimed run that
      // is skipped (for example an existing script lock) is an execution result.
      this.db.prepare("UPDATE jobs SET last_status=?,last_started_at=?,last_finished_at=?,last_run_id=? WHERE id=?").run(status, run.started_at, finished, id, run.job_id);
      this.changed();
      return this.getRun(id);
    });
  }

  recoverRunning() {
    const interrupted = this.db.prepare("SELECT id FROM runs WHERE status='running'").all();
    for (const { id } of interrupted) this.completeRun(id, { status: "interrupted", message: "Worker stopped before this run finished; automatic retry is disabled." });
    return interrupted.length;
  }

  recordHookEvent(runId, eventId, type, message = "") {
    const changed = Boolean(this.db.prepare("INSERT OR IGNORE INTO hook_events(run_id,event_id,type,message,received_at) VALUES(?,?,?,?,?)").run(runId, eventId, type, message, now()).changes);
    if (changed) this.changed();
    return changed;
  }

  purgeRuns({ retentionDays = 30, now: reference = Date.now() } = {}) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error("Invalid retention period.");
    const cutoff = new Date(Number(reference) - retentionDays * 86400000).toISOString();
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM runs WHERE finished_at IS NOT NULL AND finished_at<? AND status NOT IN ('queued','running')").all(cutoff).map(runRow);
      this.db.prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at<? AND status NOT IN ('queued','running')").run(cutoff);
      if (rows.length) this.changed();
      return rows;
    });
  }
}

module.exports = { Store };
