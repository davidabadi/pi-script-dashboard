const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const os = require("os");
const crypto = require("crypto");
const {
  createRateLimiter, csrfMiddleware, requireCsrf, requireSameOrigin, safeJson,
  securityHeaders, shellQuote, stableJobId, validateCron, validateManagedPath,
  validateName,
} = require("./security");
const { authenticate: authenticatePam, checkSocket } = require("./saslauthd");
require("dotenv").config();
const isLinux = os.platform() === "linux";
const isProduction = process.env.NODE_ENV === "production";
const runtimeRoot = isLinux ? "/var/lib/pi-script-dashboard" : path.join(__dirname, ".runtime");
const SCRIPT_ROOT = process.env.SCRIPT_ROOT || path.join(runtimeRoot, "scripts");
const CONFIG_ROOT = process.env.CONFIG_ROOT || path.join(runtimeRoot, "configs");
const LOG_ROOT = process.env.LOG_ROOT || (isLinux ? "/var/log/pi-script-dashboard" : path.join(runtimeRoot, "logs"));
const LOCK_ROOT = process.env.LOCK_ROOT || (isLinux ? "/run/pi-script-dashboard" : path.join(runtimeRoot, "locks"));
const DATA_FILE = process.env.DATA_FILE || path.join(runtimeRoot, "scripts.json");
const AUDIT_LOG = process.env.AUDIT_LOG || path.join(LOG_ROOT, "audit.jsonl");
const SESSION_DIR = process.env.SESSION_DIR || path.join(runtimeRoot, "sessions");
const ADMIN_GROUP = process.env.ADMIN_GROUP || "pi-dashboard-admins";
const PAM_SOCKET = process.env.PAM_SOCKET || "/run/pi-dashboard-auth/mux";
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || "localhost:8080,127.0.0.1:8080").split(",").map((value) => value.trim()).filter(Boolean);
const SESSION_COOKIE_NAME = isProduction ? "__Host-pi_dashboard" : "pi_dashboard";

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
for (const dir of [runtimeRoot, SCRIPT_ROOT, CONFIG_ROOT, LOG_ROOT, LOCK_ROOT, SESSION_DIR]) ensurePrivateDirectory(dir);

function audit(event, details = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n";
  try { fs.appendFileSync(AUDIT_LOG, entry, { encoding: "utf8", mode: 0o600 }); }
  catch (error) { console.error("Audit log write failed:", error.message); }
}

function safeSpawnSync(cmd, args, options = {}) {
  if (!isLinux) {
    console.warn(`⚠️ Skipping spawnSync on non-Linux: ${cmd} ${args.join(" ")}`);
    return { status: 0 };
  }
  return spawnSync(cmd, args, options);
}

function safeSpawn(cmd, args, options = {}) {
  if (!isLinux) {
    console.warn(`⚠️ Skipping spawn on non-Linux: ${cmd} ${args.join(" ")}`);
    return { unref() {} };
  }
  return spawn(cmd, args, options);
}

function formatSpawnError(result, fallback) {
  if (result && result.error) {
    return result.error.message;
  }
  const stderr = result && result.stderr ? result.stderr.toString().trim() : "";
  return stderr || fallback;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!dir || dir === ".") return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFileWithSudo(filePath, content, label) {
  ensureParentDir(filePath);
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw new Error(`${label}: ${error.message}`);
  }
}

function runSudoCommand(args, label) {
  if (args[0] === "chmod" && args[1] === "+x") {
    fs.chmodSync(args[2], 0o700);
    return;
  }
  throw new Error(`${label}: privileged command is not allowlisted.`);
}

function readCrontab() {
  const result = safeSpawnSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return "";
  return String(result.stdout || "");
}

function writeCrontab(content) {
  const result = safeSpawnSync("crontab", ["-"], { input: content, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error(formatSpawnError(result, "Failed to update crontab."));
}

const lockFile = path.join(LOCK_ROOT, "dashboard-update.lock");
const updateRequestFile = path.join(runtimeRoot, "update.request");

if (fs.existsSync(lockFile)) {
  try {
    fs.unlinkSync(lockFile);
    console.log("🧹 Removed stale update lock.");
  } catch (err) {
    console.warn("⚠️ Failed to remove update lock:", err.message);
  }
}

if (isProduction) {
  if (!isLinux) throw new Error("PAM authentication requires Linux in production.");
  checkSocket(PAM_SOCKET);
} else if (!isLinux) {
  console.warn("⚠️ PAM is disabled — using test login for development.");
}

function isAuthorizedAdmin(username) {
  if (!isLinux) return !isProduction;
  const result = safeSpawnSync("id", ["-nG", "--", username], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return false;
  return String(result.stdout || "").trim().split(/\s+/).includes(ADMIN_GROUP);
}

const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.urlencoded({ extended: false, limit: "300kb", parameterLimit: 30 }));
app.use(express.json({ limit: "32kb", strict: true }));
const configuredSecret = process.env.SESSION_SECRET || process.env.SECRET_KEY || "";
if (isProduction && Buffer.byteLength(configuredSecret) < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 bytes in production.");
}
const sessionSecret = Buffer.byteLength(configuredSecret) >= 32 ? configuredSecret : crypto.randomBytes(48).toString("base64url");
if (!isProduction && Buffer.byteLength(configuredSecret) < 32) console.warn("Using an ephemeral development session secret.");
app.use(
  session({
    store: new FileStore({
      path: SESSION_DIR,
      retries: 1,
      ttl: 30 * 60,
      reapInterval: 10 * 60,
    }),
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, secure: isProduction, sameSite: "strict", path: "/", maxAge: 30 * 60 * 1000 },
  })
);
app.use(csrfMiddleware);
app.use(requireSameOrigin(TRUSTED_HOSTS));
app.use((req, res, next) => {
  res.locals.safeJson = safeJson;
  if (req.session.logged_in) res.set("Cache-Control", "no-store, private");
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "templates"));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (path.basename(filePath) === "tailwind.css") {
        // Cache aggressively and rely on the query parameter for busting
        res.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );
      }
    },
  })
);
app.use("/vendor/monaco/vs", express.static(path.join(__dirname, "node_modules", "monaco-editor", "min", "vs"), { fallthrough: false, index: false, immutable: true, maxAge: "1y" }));
app.get("/vendor/sortable/Sortable.min.js", (req, res) => res.sendFile(path.join(__dirname, "node_modules", "sortablejs", "Sortable.min.js")));

if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(path.join(__dirname, "scripts.json"), DATA_FILE);
const scriptsData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

let scriptOrder = Object.keys(scriptsData).sort(
  (a, b) => (scriptsData[a].order ?? 0) - (scriptsData[b].order ?? 0)
);

const SCRIPTS = {};
const LOGS = {};
const CRON_TAGS = {};
const CRON_KEYS = {};
const LOCKS = {};
const CONFIG_PATHS = {};
const CRON_TIMERS = {};

const cssFilePath = path.join(__dirname, "public", "tailwind.css");
function getCacheBust() {
  try {
    return fs.statSync(cssFilePath).mtimeMs.toString();
  } catch {
    return Date.now().toString();
  }
}

for (const name of scriptOrder) {
  const info = scriptsData[name];
  SCRIPTS[name] = info.script;
  LOGS[name] = info.log;
  CRON_TAGS[name] = info.cron_tag;
  LOCKS[name] = info.lock;
  CONFIG_PATHS[name] = info.config_path || "";
  CRON_KEYS[name] = buildCronKey(name, info.cron_tag, info.config_path);
}

function buildCronKey(name, cronTag, configPath) {
  return `pi-dashboard:${stableJobId(String(name || cronTag || ""))}`;
}

function buildCronCommand(script, configPath) {
  const commandParts = ["/bin/bash", script];
  if (configPath) {
    commandParts.push(configPath);
  }
  return commandParts.map(shellQuote).join(" ");
}

function loadCronTimers() {
  let lines = [];
  try {
    lines = readCrontab().split(/\r?\n/);
  } catch (e) {
    lines = [];
  }
  for (const [name, tag] of Object.entries(CRON_KEYS)) {
    const line = lines.find((l) => l.includes(tag));
    if (line) {
      const cleaned = line.replace(/^#\s*/, "").trim();
      const m = cleaned.match(/^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)/);
      CRON_TIMERS[name] = m ? m[1] : "";
    } else {
      CRON_TIMERS[name] = "";
    }
  }
}

loadCronTimers();

function cronToFrequency(timer) {
  const t = (timer || "").trim();
  if (!t) return "daily";
  if (t.startsWith("@")) {
    if (t === "@weekly") return "weekly";
    if (t === "@monthly") return "monthly";
    if (t === "@yearly" || t === "@annually") return "yearly";
    return "daily";
  }
  const parts = t.split(/\s+/);
  if (parts.length >= 5) {
    const [, , dom, , dow] = parts;
    if (dow && dow !== "*") return "weekly";
    if (dom && dom !== "*") return "monthly";
  }
  return "daily";
}

function flash(req, category, text) {
  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ category, text });
}

function requiresAuth(req, res, next) {
  if (!req.session.logged_in) return res.redirect("/login");
  if (req.session.absoluteExpiresAt <= Date.now()) {
    return req.session.destroy(() => res.redirect("/login"));
  }
  next();
}

function validateSubmittedJob(body) {
  if (validateName(body.name) !== body.name) throw new Error("Name cannot start or end with whitespace.");
  validateManagedPath(body.script, SCRIPT_ROOT, [".sh"]);
  validateManagedPath(body.log, LOG_ROOT, [".log"]);
  validateManagedPath(body.lock, LOCK_ROOT);
  validateCron(body.timer);
  if (Buffer.byteLength(String(body.content || ""), "utf8") > 256 * 1024) throw new Error("Script content is too large.");
  const configEnabled = body.config_enabled === "true" || body.config_enabled === "on" || Boolean(String(body.config_path || "").trim());
  if (configEnabled) validateManagedPath(body.config_path, CONFIG_ROOT, [".conf", ".json", ".yaml", ".yml"]);
  if (Buffer.byteLength(String(body.config_content || ""), "utf8") > 256 * 1024) throw new Error("Config content is too large.");
}

app.get("/login", (req, res) => {
  const messages = req.session.messages || [];
  req.session.messages = [];
  res.render("login", { messages, cacheBust: getCacheBust() });
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: (req) => `${req.ip}:${String(req.body && req.body.username || "").toLowerCase()}`,
});

app.post("/login", loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (
      typeof username !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}\$?$/.test(username) ||
      Buffer.byteLength(username) > 128 ||
      typeof password !== "string" ||
      password.includes("\0") ||
      Buffer.byteLength(password) > 256
    ) {
      audit("login.failure", { user: "invalid-input", ip: req.ip });
      return res.status(400).send("Invalid credentials.");
    }

    const finishLogin = () => req.session.regenerate((error) => {
      if (error) return res.status(500).send("Unable to create session.");
      req.session.logged_in = true;
      req.session.username = username;
      req.session.absoluteExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
      req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
      audit("login.success", { user: username, ip: req.ip });
      res.redirect("/");
    });

    const authenticated = isLinux
      ? isAuthorizedAdmin(username) && await authenticatePam(username, password, { socketPath: PAM_SOCKET })
      : Boolean(process.env.TEST_USER && process.env.TEST_PASS && username === process.env.TEST_USER && password === process.env.TEST_PASS);
    if (authenticated) return finishLogin();
    audit("login.failure", { user: username, ip: req.ip });
    flash(req, "error", "Invalid credentials");
    return res.redirect("/login");
  } catch (error) {
    next(error);
  }
});

app.post("/logout", requiresAuth, requireCsrf, (req, res) => {
  const user = req.session.username;
  req.session.destroy(() => {
    audit("logout", { user, ip: req.ip });
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.redirect("/login");
  });
});

app.get("/", requiresAuth, (req, res) => {
  const cronOutput = readCrontab();
  const cronLines = cronOutput.split(/\r?\n/);
  const paused = {};
  const status = {};
  const lastRun = {};
  for (const [name, tag] of Object.entries(CRON_KEYS)) {
    paused[name] = cronLines.some(
      (l) => l.includes(tag) && l.trim().startsWith("#")
    );

    const lockPath = LOCKS[name];
    if (lockPath && fs.existsSync(lockPath)) {
      status[name] = "running";
      continue;
    }

    const logPath = LOGS[name];
    if (logPath && fs.existsSync(logPath)) {
      try {
        const stats = fs.statSync(logPath);
        lastRun[name] = stats.mtime.toLocaleString("en-US", { hour12: true });
        const content = fs.readFileSync(logPath, "utf8").trim();
        if (!content) {
          status[name] = null;
        } else {
          const lastLine = content.split(/\r?\n/).pop();
          if (lastLine.includes("✅")) {
            status[name] = "success";
          } else if (lastLine.includes("⚠️")) {
            status[name] = "partial";
          } else {
            status[name] = "failed";
          }
        }
      } catch (e) {
        status[name] = null;
        lastRun[name] = null;
      }
    } else {
      status[name] = null;
      lastRun[name] = null;
    }
  }
  const messages = req.session.messages || [];
  req.session.messages = [];
  res.render("index", {
    scripts: SCRIPTS,
    scriptOrder,
    logs: LOGS,
    cron_output: cronOutput,
    paused,
    status,
    messages,
    last_run: lastRun,
    cacheBust: getCacheBust(),
  });
});

app.post("/run/:name", requiresAuth, requireCsrf, (req, res) => {
  const name = req.params.name;
  const script = SCRIPTS[name];
  if (script) {
    try {
      validateManagedPath(script, SCRIPT_ROOT, [".sh"]);
      const configPath = CONFIG_PATHS[name];
      if (configPath) validateManagedPath(configPath, CONFIG_ROOT, [".conf", ".json", ".yaml", ".yml"]);
      const args = ["/bin/bash", script];
      if (configPath) {
        args.push(configPath);
      }
      safeSpawn(args.shift(), args, {
        detached: true,
        stdio: "ignore",
      }).unref();
      audit("job.started", { user: req.session.username, ip: req.ip, job: name });
      flash(req, "success", `✅ '${name}' started successfully.`);
    } catch (e) {
      flash(req, "error", `❌ Error: ${e}`);
    }
  } else {
    flash(req, "error", "❌ Script not found.");
  }
  res.redirect("/");
});

app.get("/log/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const logPath = LOGS[name];
  if (logPath && fs.existsSync(logPath)) {
    try { validateManagedPath(logPath, LOG_ROOT, [".log"]); }
    catch { return res.status(403).send("Log path is outside the managed directory."); }
    const stats = fs.statSync(logPath);
    const bytes = Math.min(stats.size, 256 * 1024);
    const buffer = Buffer.alloc(bytes);
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, bytes, stats.size - bytes);
    fs.closeSync(fd);
    const content = buffer.toString("utf8").split(/\r?\n/).slice(-100);
    res.render("log", { name, content, cacheBust: getCacheBust() });
  } else {
    flash(req, "error", "❌ Log not found.");
    res.redirect("/");
  }
});

app.get("/new", requiresAuth, (req, res) => {
  const messages = req.session.messages || [];
  req.session.messages = [];
  const data = {
    name: "",
    script: path.join(SCRIPT_ROOT, "job.sh"),
    log: path.join(LOG_ROOT, "job.log"),
    lock: path.join(LOCK_ROOT, "job.lock"),
    timer: "* * * * *",
    content: "",
    config_path: "",
    config_content: "",
  };
  res.render("form", { isNew: true, data, messages, cacheBust: getCacheBust() });
});

app.post("/new", requiresAuth, requireCsrf, (req, res) => {
  const {
    name,
    script,
    log,
    lock,
    timer,
    content,
    config_path,
    config_content,
    config_enabled,
  } = req.body;
  try { validateSubmittedJob(req.body); }
  catch (error) { flash(req, "error", error.message); return res.redirect("/new"); }
  const normalized = (content || "").replace(/\r/g, "");
  try {
    writeFileWithSudo(script, normalized, "Failed to write script");
    runSudoCommand(["chmod", "+x", script], "Failed to chmod script");
  } catch (e) {
    flash(req, "error", `❌ Failed to write script: ${e.message}`);
    return res.redirect("/");
  }

  const rawConfigPath = (config_path || "").trim();
  const configEnabled =
    config_enabled === "true" || config_enabled === "on" || Boolean(rawConfigPath);
  if (configEnabled && !rawConfigPath) {
    flash(req, "error", "❌ Config file path required.");
    return res.redirect("/");
  }
  const normalizedConfig = (config_content || "").replace(/\r/g, "");
  const configPath = configEnabled ? rawConfigPath : "";
  const cronTagValue = (name || "").trim();
  const cronKey = buildCronKey(name, cronTagValue, configPath);
  if (configEnabled && configPath) {
    try {
      writeFileWithSudo(configPath, normalizedConfig, "Failed to write config file");
    } catch (e) {
      flash(req, "error", `❌ Failed to write config file: ${e.message}`);
      return res.redirect("/");
    }
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    data = {};
  }
  const existing = data[name];
  const nextOrder =
    Math.max(-1, ...Object.values(data).map((d) => d.order ?? 0)) + 1;
  const order = existing ? existing.order ?? scriptOrder.indexOf(name) : nextOrder;
  data[name] = { script, log, cron_tag: cronTagValue, lock, order };
  if (configPath) {
    data[name].config_path = configPath;
  }
  try {
    writeFileWithSudo(DATA_FILE, JSON.stringify(data, null, 2), "Failed to save metadata");
  } catch (e) {
    console.warn("⚠️ Failed to save scripts.json:", e.message);
  }
  SCRIPTS[name] = script;
  LOGS[name] = log;
  CRON_TAGS[name] = cronTagValue;
  CRON_KEYS[name] = cronKey;
  LOCKS[name] = lock;
  CONFIG_PATHS[name] = configPath;
  if (!existing) {
    scriptOrder.push(name);
  }

  let cronContent = "";
  try {
    cronContent = readCrontab();
  } catch (e) {
    cronContent = "";
  }
  if (existing && existing.cron_tag) {
    const oldKey = buildCronKey(name, existing.cron_tag, existing.config_path);
    const lines = cronContent
      .split(/\r?\n/)
      .filter((line) => line && !line.includes(oldKey));
    lines.push(`${timer} ${buildCronCommand(script, configPath)} # ${cronKey}`);
    cronContent = lines.join("\n") + "\n";
  } else {
    cronContent += `\n${timer} ${buildCronCommand(script, configPath)} # ${cronKey}\n`;
  }
  try {
    writeCrontab(cronContent);
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  loadCronTimers();
  audit(existing ? "job.updated" : "job.created", { user: req.session.username, ip: req.ip, job: name });

  flash(req, "success", `✅ ${existing ? "Updated" : "Added"} script '${name}'.`);
  res.redirect("/");
});

app.get("/edit/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const scriptPath = SCRIPTS[name];
  try {
    validateManagedPath(scriptPath, SCRIPT_ROOT, [".sh"]);
    if (CONFIG_PATHS[name]) validateManagedPath(CONFIG_PATHS[name], CONFIG_ROOT, [".conf", ".json", ".yaml", ".yml"]);
  } catch {
    flash(req, "error", "This legacy job must be migrated into the managed directories before editing.");
    return res.redirect("/");
  }
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    flash(req, "error", "❌ Script not found.");
    return res.redirect("/");
  }
  let content = "";
  try {
    content = fs.readFileSync(scriptPath, "utf8");
  } catch (e) {
    flash(req, "error", "❌ Failed to read script file.");
    return res.redirect("/");
  }
  const messages = req.session.messages || [];
  req.session.messages = [];
  const data = {
    name,
    script: scriptPath,
    log: LOGS[name] || "",
    lock: LOCKS[name] || "",
    timer: CRON_TIMERS[name] || "",
    content,
    config_path: CONFIG_PATHS[name] || "",
    config_content: "",
  };
  if (data.config_path && fs.existsSync(data.config_path)) {
    try {
      data.config_content = fs.readFileSync(data.config_path, "utf8");
    } catch (e) {
      flash(req, "error", "❌ Failed to read config file.");
      return res.redirect("/");
    }
  }
  res.render("form", { isNew: false, data, messages, cacheBust: getCacheBust() });
});

app.post("/edit/:name", requiresAuth, requireCsrf, (req, res) => {
  const oldName = req.params.name;
  const {
    name,
    script,
    log,
    lock,
    timer,
    content,
    config_path,
    config_content,
    config_enabled,
  } = req.body;
  try { validateSubmittedJob(req.body); }
  catch (error) { flash(req, "error", error.message); return res.redirect(`/edit/${encodeURIComponent(req.params.name)}`); }
  const scriptPath = script;
  const oldKey = CRON_KEYS[oldName];
  const oldLog = LOGS[oldName];
  const oldConfigPath = CONFIG_PATHS[oldName];
  if (!scriptPath) {
    flash(req, "error", "❌ Script path required.");
    return res.redirect("/");
  }
  const normalized = (content || "").replace(/\r/g, "");
  try {
    writeFileWithSudo(scriptPath, normalized, "Failed to write script");
    runSudoCommand(["chmod", "+x", scriptPath], "Failed to chmod script");
  } catch (e) {
    flash(req, "error", `❌ Failed to write script: ${e.message}`);
    return res.redirect("/");
  }

  const rawConfigPath = (config_path || "").trim();
  const configEnabled =
    config_enabled === "true" || config_enabled === "on" || Boolean(rawConfigPath);
  if (configEnabled && !rawConfigPath) {
    flash(req, "error", "❌ Config file path required.");
    return res.redirect("/");
  }
  const normalizedConfig = (config_content || "").replace(/\r/g, "");
  const configPath = configEnabled ? rawConfigPath : "";
  const cronTagValue = (name || "").trim();
  const cronKey = buildCronKey(name, cronTagValue, configPath);
  if (configEnabled && configPath) {
    try {
      writeFileWithSudo(configPath, normalizedConfig, "Failed to write config file");
    } catch (e) {
      flash(req, "error", `❌ Failed to write config file: ${e.message}`);
      return res.redirect("/");
    }
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    data = {};
  }
  const oldOrder = data[oldName] ? data[oldName].order : scriptOrder.indexOf(oldName);
  delete data[oldName];
  data[name] = { script, log, cron_tag: cronTagValue, lock, order: oldOrder };
  if (configPath) {
    data[name].config_path = configPath;
  }
  try {
    writeFileWithSudo(DATA_FILE, JSON.stringify(data, null, 2), "Failed to save metadata");
  } catch (e) {
    console.warn("⚠️ Failed to save scripts.json:", e.message);
  }

  delete SCRIPTS[oldName];
  delete LOGS[oldName];
  delete CRON_TAGS[oldName];
  delete CRON_KEYS[oldName];
  delete LOCKS[oldName];
  delete CRON_TIMERS[oldName];
  delete CONFIG_PATHS[oldName];

  SCRIPTS[name] = script;
  LOGS[name] = log;
  CRON_TAGS[name] = cronTagValue;
  CRON_KEYS[name] = cronKey;
  LOCKS[name] = lock;
  CONFIG_PATHS[name] = configPath;
  const idx = scriptOrder.indexOf(oldName);
  if (idx !== -1) scriptOrder[idx] = name;

  let cronLines = [];
  try {
    cronLines = readCrontab().split(/\r?\n/);
  } catch (e) {
    cronLines = [];
  }
  const filtered = cronLines.filter((l) => l && !l.includes(oldKey));
  filtered.push(`${timer} ${buildCronCommand(script, configPath)} # ${cronKey}`);
  const newCron = filtered.join("\n") + "\n";
  try {
    writeCrontab(newCron);
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  if (oldConfigPath && oldConfigPath !== configPath && !configPath) {
    CONFIG_PATHS[name] = "";
  }

  loadCronTimers();
  audit("job.updated", { user: req.session.username, ip: req.ip, job: name, previousName: oldName });

  flash(req, "success", `✅ Saved '${name}' successfully.`);
  res.redirect("/");
});

app.post("/toggle_cron/:name", requiresAuth, requireCsrf, (req, res) => {
  const name = req.params.name;
  const tag = CRON_KEYS[name];
  if (!tag) {
    flash(req, "error", "❌ Unknown script tag.");
    return res.redirect("/");
  }
  const cronLines = readCrontab().split(/\r?\n/);
  const updatedLines = [];
  let resumed = false;
  for (const line of cronLines) {
    if (line.includes(tag)) {
      if (line.trim().startsWith("#")) {
        updatedLines.push(line.replace(/^#\s*/, ""));
        resumed = true;
      } else {
        updatedLines.push("# " + line);
        resumed = false;
      }
    } else {
      updatedLines.push(line);
    }
  }
  const newCron = updatedLines.join("\n") + "\n";
  writeCrontab(newCron);
  audit("cron.toggled", { user: req.session.username, ip: req.ip, job: name, resumed });
  flash(
    req,
    "success",
    `${resumed ? "▶️ Resumed" : "⏸️ Paused"} cron job for '${name}'.`
  );
  res.redirect("/");
});

app.post("/reorder", requiresAuth, requireCsrf, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "Invalid order" });
  }
  if (order.length !== scriptOrder.length || new Set(order).size !== order.length || order.some((name) => !SCRIPTS[name])) {
    return res.status(400).json({ error: "Order must include every known job exactly once" });
  }
  let data;
  try {
    data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );
  } catch (e) {
    data = {};
  }
  order.forEach((name, idx) => {
    if (data[name]) data[name].order = idx;
  });
  try {
    writeFileWithSudo(DATA_FILE, JSON.stringify(data, null, 2), "Failed to save metadata");
  } catch (e) {
    return res.status(500).json({ error: "Failed to save order" });
  }
  scriptOrder = order;
  audit("jobs.reordered", { user: req.session.username, ip: req.ip, jobs: order.length });

  res.json({ success: true });
});

app.post("/update", requiresAuth, requireCsrf, (req, res) => {
  try {
    fs.writeFileSync(updateRequestFile, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
    audit("dashboard.update_requested", { user: req.session.username, ip: req.ip });
    res.redirect("/?updated=true");
  } catch (e) {
    flash(req, "error", `❌ Failed to run update script: ${e}`);
    res.redirect("/");
  }
});

app.get("/update-status", requiresAuth, (req, res) => {
  const updating = fs.existsSync(lockFile);
  res.json({ updating });
});

app.use((req, res) => res.status(404).send("Not found."));
app.use((error, req, res, next) => {
  audit("request.error", { user: req.session && req.session.username, ip: req.ip, method: req.method, path: req.path, status: error.status || 500 });
  if (res.headersSent) return next(error);
  res.status(error.status || 500).send(error.status === 413 ? "Request is too large." : "The request could not be completed.");
});

const port = Number(process.env.PORT || 8080);
if (require.main === module) {
  app.listen(port, "127.0.0.1", () => console.log("Server running on 127.0.0.1:" + port));
}

module.exports = { app };
