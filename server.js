"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { createRateLimiter, csrfMiddleware, requireCsrf, requireSameOrigin, safeJson,
  securityHeaders, validateCron, validateManagedPath, validateName } = require("./security");
const { authenticate: authenticatePam, checkSocket } = require("./saslauthd");
const { readConfig } = require("./lib/config");
const { Store } = require("./lib/store");
const { syncSchedules } = require("./lib/scheduler");
const { readRunLog } = require("./lib/run-logs");
const { editJobFiles, recoverJobFiles } = require("./lib/job-files");
const { createLiveEvents } = require("./lib/live-events");

function publicRun(run) {
  if (!run) return null;
  return Object.fromEntries(["id", "job_id", "job_name", "source", "status", "queued_at", "started_at",
    "finished_at", "exit_code", "message", "log_mode", "log_truncated", "capture_gap"].map((key) => [key, run[key] ?? null]));
}
function createApp(options = {}) {
  const env = options.env || process.env;
  const config = options.config || readConfig(env);
  const production = env.NODE_ENV === "production";
  const linux = process.platform === "linux";
  for (const dir of [config.runtimeRoot, config.scriptRoot, config.configRoot, config.logRoot, config.lockRoot, config.sessionDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const store = options.store || new Store(config.dbFile, { legacyFile: config.dataFile });
  const cookieName = production ? "__Host-pi_dashboard" : "pi_dashboard";
  const secret = env.SESSION_SECRET || env.SECRET_KEY || "";
  if (production && (!linux || Buffer.byteLength(secret) < 32)) throw new Error("Production requires Linux and SESSION_SECRET of at least 32 bytes.");
  if (production) checkSocket(env.PAM_SOCKET || "/run/pi-dashboard-auth/mux");
  const cronIO = options.cronIO || (!linux ? {
    readCrontab: () => store.getSetting("development_crontab") || "",
    writeCrontab: (text) => store.setSetting("development_crontab", text),
  } : {});
  const synchronize = () => syncSchedules(store, config, cronIO);
  const audit = (event, details = {}) => {
    try { fs.appendFileSync(config.auditLog, JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n", { mode: 0o600 }); }
    catch (error) { console.error("Audit log write failed:", error.message); }
  };
  const app = express();
  let live;
  const wantsJson = (req) => req.path.startsWith("/api/") || /application\/json/i.test(req.get("accept") || "");
  Object.assign(app.locals, { store, config });
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.urlencoded({ extended: false, limit: "300kb", parameterLimit: 30 }));
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use(session({ store: options.sessionStore || new FileStore({ path: config.sessionDir, retries: 1, ttl: 1800, reapInterval: 600 }),
    name: cookieName, secret: Buffer.byteLength(secret) >= 32 ? secret : crypto.randomBytes(48).toString("base64url"),
    resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, secure: production, sameSite: "strict", path: "/", maxAge: 1800000 } }));
  app.use(csrfMiddleware);
  app.use(requireSameOrigin((env.TRUSTED_HOSTS || "localhost:8080,127.0.0.1:8080").split(",").map((s) => s.trim()).filter(Boolean)));
  app.use((req, res, next) => {
    res.locals.safeJson = safeJson;
    res.locals.cacheBust = fs.statSync(path.join(__dirname, "public/tailwind.css")).mtimeMs.toString();
    next();
  });
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "templates"));
  app.use(express.static(path.join(__dirname, "public"), { index: false }));
  app.use("/vendor/monaco/vs", express.static(path.join(__dirname, "node_modules/monaco-editor/min/vs"), { index: false, fallthrough: false, immutable: true, maxAge: "1y" }));
  app.get("/vendor/sortable/Sortable.min.js", (req, res) => res.sendFile(path.join(__dirname, "node_modules/sortablejs/Sortable.min.js")));
  const messages = (req) => { const list = req.session.messages || []; req.session.messages = []; return list; };
  const flash = (req, category, text) => { (req.session.messages ||= []).push({ category, text }); };
  const requiresAuth = (req, res, next) => {
    const reject = () => wantsJson(req) || ["/update", "/update-status"].includes(req.path) ? res.status(401).json({ error: "Session expired. Sign in again." }) : res.redirect("/login");
    if (!req.session.logged_in) return reject();
    const now = Date.now();
    if (req.session.absoluteExpiresAt <= now || (req.session.lastActivityAt && req.session.lastActivityAt + 1800000 <= now)) return req.session.destroy(reject);
    // Event streams and background reads never renew an unattended session.
    // SPA navigation explicitly posts /api/activity; user actions also renew it.
    if (req.method !== "GET" || (!req.path.startsWith("/api/") && req.path !== "/update-status")) req.session.lastActivityAt = now;
    next();
  };
  const limiter = createRateLimiter({ windowMs: 900000, limit: 5, key: (req) => `${req.ip}:${String(req.body?.username || "").toLowerCase()}` });
  app.get("/login", (req, res) => res.render("login", { messages: messages(req) }));
  app.post("/login", limiter, requireCsrf, async (req, res, next) => {
    try {
      const { username, password } = req.body;
      if (typeof username !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}\$?$/.test(username) ||
        Buffer.byteLength(username) > 128 || typeof password !== "string" || password.includes("\0") || Buffer.byteLength(password) > 256) {
        audit("login.failure", { user: "invalid-input", ip: req.ip }); return res.status(400).send("Invalid credentials.");
      }
      let authenticated;
      if (options.authenticate) authenticated = await options.authenticate(username, password);
      else if (linux) {
        const groups = spawnSync("id", ["-nG", "--", username], { encoding: "utf8" });
        authenticated = groups.status === 0 && groups.stdout.trim().split(/\s+/).includes(env.ADMIN_GROUP || "pi-dashboard-admins") &&
          await authenticatePam(username, password, { socketPath: env.PAM_SOCKET || "/run/pi-dashboard-auth/mux" });
      } else authenticated = Boolean(env.TEST_USER && env.TEST_PASS && username === env.TEST_USER && password === env.TEST_PASS);
      if (!authenticated) { audit("login.failure", { user: username, ip: req.ip }); flash(req, "error", "Invalid credentials"); return res.redirect("/login"); }
      req.session.regenerate((error) => {
        if (error) return next(error);
        Object.assign(req.session, { logged_in: true, username, absoluteExpiresAt: Date.now() + 43200000, lastActivityAt: Date.now(), csrfToken: crypto.randomBytes(32).toString("base64url") });
        audit("login.success", { user: username, ip: req.ip }); res.redirect("/");
      });
    } catch (error) { next(error); }
  });
  app.post("/logout", requiresAuth, requireCsrf, (req, res) => {
    audit("logout", { user: req.session.username, ip: req.ip });
    live?.closeSession(req.sessionID);
    req.session.destroy(() => {
      res.clearCookie(cookieName, { path: "/" });
      if (wantsJson(req)) return res.json({ ok: true, redirect: "/login" });
      res.redirect("/login");
    });
  });
  app.use(requiresAuth);
  const workerInfo = () => ({ online: Date.now() - Date.parse(store.getSetting("worker_heartbeat") || "") < 10000,
    draining: [true, "1", 1].includes(store.getSetting("worker_draining")) });
  const jobSnapshot = () => store.listJobs().map((job) => {
    const active = store.db.prepare("SELECT id FROM runs WHERE job_id=? AND status IN ('queued','running') LIMIT 1").get(job.id);
    const latest = active ? store.getRun(active.id) : (job.last_run_id ? store.getRun(job.last_run_id) : null);
    return { ...job, latest_run: publicRun(latest), status: latest?.status || job.last_status || null,
      last_run: latest?.started_at || latest?.queued_at || job.last_started_at || job.last_finished_at || null, message: latest?.message || "" };
  });
  const updateInfo = () => {
    const state = store.getSetting("update_status") || {};
    return { ...state, updating: fs.existsSync(path.join(config.runtimeRoot, "update.request")) ||
      ["requested", "waiting", "draining", "updating", "restarting"].includes(state.status) };
  };
  const snapshot = () => ({ jobs: jobSnapshot(), worker: workerInfo(),
    schedulerPending: Boolean(store.getSetting("scheduler_pending")), contentRecovery: Boolean(store.getSetting("content_recovery")), update: updateInfo() });
  const actionResult = (req, res, { ok = true, message, status = ok ? 200 : 400, job } = {}) => {
    if (wantsJson(req)) return res.status(status).json({ ok, message, snapshot: snapshot(), ...(job ? { job } : {}) });
    if (message) flash(req, ok ? "success" : "error", message);
    return res.redirect("/");
  };
  const defaults = () => ({ name: "", script: path.join(config.scriptRoot, "job.sh"), log: path.join(config.logRoot, "job.log"),
    lock: path.join(config.lockRoot, "job.lock"), timer: "0 0 * * *", content: "", config_path: "", config_content: "", log_mode: "stdout" });
  const editorData = (job) => {
    validateManagedPath(job.script, config.scriptRoot, [".sh"]);
    if (job.config_path) validateManagedPath(job.config_path, config.configRoot, [".conf", ".json", ".yaml", ".yml"]);
    const content = fs.readFileSync(job.script, "utf8");
    const configContent = job.config_path ? fs.readFileSync(job.config_path, "utf8") : "";
    const revision = crypto.createHash("sha256").update(JSON.stringify([
      ...["id", "name", "script", "log", "lock", "config_path", "log_mode", "schedule"].map(key => job[key]), content, configContent,
    ])).digest("hex");
    return { ...job, timer: job.schedule, content, config_content: configContent, revision };
  };
  const shell = (req, res) => res.render("app", { bootstrap: { csrfToken: req.session.csrfToken, snapshot: snapshot(),
    retentionDays: config.retentionDays, defaults: defaults(), messages: messages(req) } });
  live = createLiveEvents({ store, config, getSnapshot: snapshot, publicRun, ...options.liveOptions });
  app.locals.closeLive = () => live.close();
  app.get("/update-status", (req, res) => {
    res.json({ ...updateInfo(), worker: workerInfo() });
  });
  app.post("/update", requireCsrf, (req, res, next) => {
    try {
      if (fs.existsSync(path.join(config.runtimeRoot, "update.request"))) {
        if (wantsJson(req)) return actionResult(req, res, { ok: false, status: 409, message: "An update is already requested." });
        return res.status(409).send("An update is already requested.");
      }
      store.setSetting("update_status", { status: "requested", message: "Waiting for update service.", updatedAt: new Date().toISOString() });
      fs.writeFileSync(path.join(config.runtimeRoot, "update.request"), `${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
      audit("dashboard.update_requested", { user: req.session.username, ip: req.ip });
      res.status(202).json({ ok: true, status: "requested", message: "Update requested. Active jobs will finish first.", snapshot: snapshot() });
    } catch (error) { next(error); }
  });
  app.use((req, res, next) => {
    if (store.isReady()) return next();
    const error = "Registry migration required. Follow DEPLOYMENT.md before enabling execution.";
    return req.path.startsWith("/api/") ? res.status(503).json({ error }) : res.status(503).send(error);
  });
  app.get("/api/events", live.handler);
  app.post("/api/activity", requireCsrf, (req, res) => res.json({ ok: true }));
  app.get("/api/jobs", (req, res) => res.json(snapshot()));
  app.get("/api/crontab", (req, res, next) => {
    try {
      if (cronIO.readCrontab) return res.json({ text: cronIO.readCrontab() });
      const result = spawnSync("crontab", ["-l"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
      if (result.error || (result.status !== 0 && !/no crontab for/i.test(result.stderr || ""))) throw new Error("Could not read the service-user crontab.");
      res.json({ text: result.stdout || "" });
    } catch (error) { next(error); }
  });
  app.get("/api/jobs/:id/editor", (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Script not found." });
      res.json({ isNew: false, job: editorData(job) });
    } catch (error) { next(error); }
  });
  app.get("/api/jobs/:id/runs", (req, res) => {
    if (!store.getJob(req.params.id)) return res.status(404).json({ error: "Job not found." });
    const before = req.query.before;
    if (before !== undefined && (typeof before !== "string" || before.length > 100)) return res.status(400).json({ error: "Invalid history cursor." });
    res.json({ runs: store.listRuns(req.params.id, { before, limit: 50 }).map(publicRun) });
  });
  app.get("/api/runs/:id/log", (req, res, next) => {
    try {
      const run = store.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found or history expired." });
      const offset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: "Invalid log cursor." });
      res.json({ ...readRunLog(config, run, { offset, limit: 65536 }), run: publicRun(run) });
    } catch (error) { next(error); }
  });
  app.get("/", shell);
  app.post("/run/:name", requireCsrf, (req, res, next) => {
    try {
      const job = store.getJobByName(req.params.name);
      if (!job) return actionResult(req, res, { ok: false, status: 404, message: "Script not found." });
      if (store.getSetting("scheduler_pending")) return actionResult(req, res, { ok: false, status: 409, message: "Resolve schedule synchronization before running jobs." });
      const result = store.enqueue(job.id, "manual", req.session.username);
      if (result.accepted) audit("job.queued", { user: req.session.username, job: job.name, run: result.run.id });
      actionResult(req, res, { ok: result.accepted, status: result.accepted ? 202 : 409,
        message: result.accepted ? `'${job.name}' queued.` : `'${job.name}' is already queued or running.` });
    } catch (error) { next(error); }
  });
  app.get("/log/:name", (req, res) => {
    const job = store.getJobByName(req.params.name);
    if (!job) return res.status(404).send("Script not found.");
    shell(req, res);
  });
  app.get("/legacy-log/:name", (req, res, next) => {
    let fd;
    try {
      const job = store.getJobByName(req.params.name);
      if (!job?.log) return res.status(404).send("Original script log not configured.");
      validateManagedPath(job.log, config.logRoot, [".log"]);
      fd = fs.openSync(job.log, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 262144));
      fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      res.type("text/plain").send(buffer.toString("utf8"));
    } catch (error) { if (error.code === "ENOENT") return res.status(404).send("Original script log not found."); next(error); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  app.get("/new", shell);
  app.get("/edit/:name", (req, res, next) => {
    try {
      const job = store.getJobByName(req.params.name);
      if (!job) return res.status(404).send("Script not found.");
      shell(req, res);
    } catch (error) { next(error); }
  });
  const saveJob = (req, res) => {
    let staged = false;
    try {
      const old = req.params.name ? store.getJobByName(req.params.name) : null;
      if (req.params.name && !old) return actionResult(req, res, { ok: false, status: 404, message: "Script not found." });
      const body = req.body;
      if (body.editor_ready !== "true") throw new Error("Wait for the editors to load before saving.");
      const name = validateName(body.name);
      if (name !== body.name) throw new Error("Name cannot start or end with whitespace.");
      const duplicate = store.getJobByName(name);
      if (duplicate && duplicate.id !== old?.id) throw new Error("A script with this name already exists.");
      const script = validateManagedPath(body.script, config.scriptRoot, [".sh"]);
      const log = validateManagedPath(body.log, config.logRoot, [".log"]);
      const lock = validateManagedPath(body.lock, config.lockRoot);
      const schedule = validateCron(body.timer);
      const enabled = body.config_enabled === "true" || body.config_enabled === "on";
      const configPath = enabled ? validateManagedPath(body.config_path, config.configRoot, [".conf", ".json", ".yaml", ".yml"]) : "";
      const content = String(body.content || "").replace(/\r/g, "");
      const configContent = String(body.config_content || "").replace(/\r/g, "");
      if (Buffer.byteLength(content) > 262144 || Buffer.byteLength(configContent) > 262144) throw new Error("Script or config content is too large.");
      if (!["file", "stdout"].includes(body.log_mode)) throw new Error("Choose a supported log source.");
      const saved = editJobFiles(store, config, {
        writes: [{ file: script, content, mode: 0o700 }, ...(enabled ? [{ file: configPath, content: configContent, mode: 0o600 }] : [])],
        check() {
        if (old && (typeof body.revision !== "string" || editorData(store.getJob(old.id)).revision !== body.revision)) {
          const conflict = new Error("This script changed since you opened it. Copy your draft, then reopen the editor before saving.");
          conflict.status = 409;
          throw conflict;
        }
        const active = store.db.prepare("SELECT snapshot FROM runs WHERE status IN ('queued','running')").all();
        const touched = new Set([script, configPath, log, lock, old?.script, old?.config_path, old?.log, old?.lock].filter(Boolean));
        if (active.some((run) => Object.entries(JSON.parse(run.snapshot)).some(([key, value]) => ["script", "config_path", "log", "lock"].includes(key) && touched.has(value)))) {
          throw new Error("Wait for jobs using these files to finish before editing.");
        }
        },
        save() { return store.saveJob({ ...old, name, script, log, lock, config_path: configPath, schedule, log_mode: body.log_mode, paused: old?.paused ?? false }); },
      });
      staged = true;
      synchronize();
      audit(old ? "job.updated" : "job.created", { user: req.session.username, job: name });
      return actionResult(req, res, { message: `Saved '${name}'.`, job: saved });
    } catch (error) {
      if (error.recoveryRequired) audit("job.write_recovery_required", { user: req.session.username });
      return actionResult(req, res, { ok: false, status: error.status || 400, message: `${error.message}${staged ? " Execution paused until schedule synchronization succeeds." : ""}` });
    }
  };
  app.post("/new", requireCsrf, saveJob);
  app.post("/edit/:name", requireCsrf, saveJob);
  app.post("/toggle_cron/:name", requireCsrf, (req, res) => {
    try {
      const job = store.getJobByName(req.params.name);
      if (!job) return actionResult(req, res, { ok: false, status: 404, message: "Script not found." });
      store.setSetting("scheduler_pending", true);
      store.saveJob({ ...job, paused: !job.paused });
      synchronize();
      audit("cron.toggled", { user: req.session.username, job: job.name, resumed: job.paused });
      return actionResult(req, res, { message: `${job.paused ? "Resumed" : "Paused"} '${job.name}'.` });
    } catch (error) { return actionResult(req, res, { ok: false, message: `${error.message} Schedule synchronization needs attention.` }); }
  });
  app.post("/sync-cron", requireCsrf, (req, res) => {
    try { synchronize(); return actionResult(req, res, { message: "Schedules synchronized." }); }
    catch (error) { return actionResult(req, res, { ok: false, message: error.message }); }
  });
  app.post("/recover-edit", requireCsrf, (req, res) => {
    try {
      recoverJobFiles(store, config);
      audit("job.edit_recovered", { user: req.session.username });
      return actionResult(req, res, { message: "Original files restored. Retry schedule sync before running jobs." });
    } catch (error) { return actionResult(req, res, { ok: false, message: error.message }); }
  });
  app.post("/reorder", requireCsrf, (req, res) => {
    try {
      if (!Array.isArray(req.body.order)) return res.status(400).json({ error: "Invalid order." });
      store.reorderJobs(req.body.order.map((name) => store.getJobByName(name)?.id));
      audit("jobs.reordered", { user: req.session.username, jobs: req.body.order.length }); res.json({ ok: true, success: true, message: "Script order saved.", snapshot: snapshot() });
    } catch { res.status(400).json({ error: "Order must include every known job exactly once." }); }
  });
  app.use((req, res) => res.status(404).send("Not found."));
  app.use((error, req, res, next) => {
    audit("request.error", { user: req.session?.username, ip: req.ip, method: req.method, path: req.path, status: error.status || 500 });
    if (res.headersSent) return next(error);
    const errorText = error.status === 413 ? "Request is too large." : "The request could not be completed.";
    if (wantsJson(req)) res.status(error.status || 500).json({ error: errorText });
    else res.status(error.status || 500).send(errorText);
  });
  return app;
}
if (require.main === module) {
  require("dotenv").config();
  const app = createApp();
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, "127.0.0.1", () => console.log(`Server running on 127.0.0.1:${port}`));
  const shutdown = () => {
    app.locals.closeLive();
    server.close(() => app.locals.store.close());
    server.closeIdleConnections();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createApp, publicRun };
