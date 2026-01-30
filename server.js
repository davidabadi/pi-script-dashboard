const path = require("path");
const fs = require("fs");
const { execSync, spawn, spawnSync } = require("child_process");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const os = require("os");
const isLinux = os.platform() === "linux";

function safeExecSync(cmd, options = {}) {
  if (!isLinux) {
    console.warn(`⚠️ Skipping execSync on non-Linux: ${cmd}`);
    return Buffer.from("");
  }
  return execSync(cmd, options);
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
  if (!isLinux) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  const result = safeSpawnSync("sudo", ["mkdir", "-p", dir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status && result.status !== 0) {
    throw new Error(formatSpawnError(result, "Failed to create directory."));
  }
}

function writeFileWithSudo(filePath, content, label) {
  ensureParentDir(filePath);
  if (!isLinux) {
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }
  const result = safeSpawnSync("sudo", ["tee", filePath], {
    input: content,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (result.status && result.status !== 0) {
    throw new Error(`${label}: ${formatSpawnError(result, "Write failed.")}`);
  }
}

function runSudoCommand(args, label) {
  if (!isLinux) return;
  const result = safeSpawnSync("sudo", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status && result.status !== 0) {
    throw new Error(`${label}: ${formatSpawnError(result, "Command failed.")}`);
  }
}

function hasGitIdentity() {
  try {
    const name = safeExecSync("git config user.name").toString().trim();
    const email = safeExecSync("git config user.email").toString().trim();
    return Boolean(name && email);
  } catch {
    return false;
  }
}
const lockFile = "/tmp/dashboard-update.lock";

function commitScriptsUpdate(message, extraPaths = []) {
  const files = ["scripts.json", ...extraPaths].filter(Boolean);
  try {
    safeExecSync(`git add ${files.map((file) => `"${file}"`).join(" ")}`);
  } catch (e) {
    console.warn("⚠️ Failed to stage scripts.json update:", e.message);
    return;
  }

  if (!hasGitIdentity()) {
    console.warn("⚠️ Git user.name/email not set; skipping commit.");
    return;
  }

  try {
    safeExecSync(`git commit -m "${message.replace(/"/g, '\\"')}"`);
  } catch (e) {
    console.warn("⚠️ Failed to commit scripts.json update:", e.message);
    return;
  }

  try {
    const remotes = safeExecSync("git remote").toString().trim();
    if (remotes) {
      safeExecSync("git push");
    } else {
      console.warn("⚠️ No git remote configured; skipping push.");
    }
  } catch (e) {
    console.warn("⚠️ Failed to push scripts.json update:", e.message);
  }
}

if (fs.existsSync(lockFile)) {
  try {
    fs.unlinkSync(lockFile);
    console.log("🧹 Removed stale update lock.");
  } catch (err) {
    console.warn("⚠️ Failed to remove update lock:", err.message);
  }
}

let pam;
if (isLinux) {
  try {
    pam = require("authenticate-pam");
  } catch (e) {
    console.warn("⚠️ 'authenticate-pam' not available. Using test login.");
  }
} else {
  console.warn("⚠️ PAM is disabled — using test login for development.");
}

require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    store: new FileStore({
      path: "/tmp/dashboard-sessions",
      retries: 1,
    }),
    secret: process.env.SECRET_KEY || "changeme",
    resave: false,
    saveUninitialized: false,
  })
);

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

const scriptsData = require("./scripts.json");

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
  const base = (cronTag || name || "").trim();
  const suffix = (configPath || "").trim() ? path.basename(configPath.trim()) : "";
  return suffix ? `${base}:${suffix}` : base;
}

function buildCronCommand(script, configPath) {
  const commandParts = ["/bin/bash", script];
  if (configPath) {
    commandParts.push(configPath);
  }
  return commandParts.join(" ");
}

function loadCronTimers() {
  let lines = [];
  try {
    lines = safeExecSync("sudo crontab -l").toString().split(/\r?\n/);
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

function writeLogrotateConfig(logPath, timer) {
  if (!isLinux || !logPath) return;
  const freq = cronToFrequency(timer);
  const base = path.basename(logPath).replace(/\.log$/, "");
  const dest = `/etc/logrotate.d/${base}`;
  const content = `${logPath} {\n    ${freq}\n    rotate 7\n    compress\n    missingok\n    notifempty\n    create 640 pi adm\n}\n`;
  try {
    safeSpawnSync("sudo", ["tee", dest], {
      input: content,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (e) {
    console.warn("⚠️ Failed to write logrotate config:", e.message);
  }
}

function removeLogrotateConfig(logPath) {
  if (!isLinux || !logPath) return;
  const base = path.basename(logPath).replace(/\.log$/, "");
  const dest = `/etc/logrotate.d/${base}`;
  try {
    safeSpawnSync("sudo", ["rm", "-f", dest]);
  } catch (e) {
    console.warn("⚠️ Failed to remove logrotate config:", e.message);
  }
}

function flash(req, category, text) {
  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ category, text });
}

function requiresAuth(req, res, next) {
  if (!req.session.logged_in) return res.redirect("/login");
  next();
}

app.get("/login", (req, res) => {
  const messages = req.session.messages || [];
  req.session.messages = [];
  res.render("login", { messages, cacheBust: getCacheBust() });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (isLinux && pam) {
    pam.authenticate(username, password, (err) => {
      if (!err) {
        req.session.logged_in = true;
        req.session.username = username;
        return res.redirect("/");
      } else {
        flash(req, "error", "Invalid credentials");
        return res.redirect("/login");
      }
    });
  } else {
    // fallback when PAM is unavailable or on non-Linux platforms
    const TEST_USER = process.env.TEST_USER || "pi";
    const TEST_PASS = process.env.TEST_PASS || "raspberry";

    if (username === TEST_USER && password === TEST_PASS) {
      req.session.logged_in = true;
      req.session.username = username;
      return res.redirect("/");
    } else {
      flash(req, "error", "Invalid credentials");
      return res.redirect("/login");
    }
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requiresAuth, (req, res) => {
  const cronOutput = safeExecSync("sudo crontab -l").toString();
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

app.get("/run/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const script = SCRIPTS[name];
  if (script) {
    try {
      const configPath = CONFIG_PATHS[name];
      const args = ["/bin/bash", script];
      if (configPath) {
        args.push(configPath);
      }
      safeSpawn("sudo", args, {
        detached: true,
        stdio: "ignore",
      }).unref();
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
    const content = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-100);
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
    script: "/usr/local/bin/",
    log: "/var/log/custom/",
    lock: "/etc/",
    timer: "* * * * *",
    content: "",
    config_path: "",
    config_content: "",
  };
  res.render("form", { isNew: true, data, messages, cacheBust: getCacheBust() });
});

app.post("/new", requiresAuth, (req, res) => {
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
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts.json"), "utf8"));
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
    fs.writeFileSync(path.join(__dirname, "scripts.json"), JSON.stringify(data, null, 2));
    commitScriptsUpdate(`Add script ${name}`, [script, configPath]);
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
    cronContent = safeExecSync("sudo crontab -l").toString();
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
    safeExecSync("sudo crontab -", { input: cronContent });
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  if (existing && existing.log && existing.log !== log) {
    removeLogrotateConfig(existing.log);
  }
  writeLogrotateConfig(log, timer);

  loadCronTimers();

  flash(req, "success", `✅ ${existing ? "Updated" : "Added"} script '${name}'.`);
  res.redirect("/");
});

app.get("/edit/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const scriptPath = SCRIPTS[name];
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

app.post("/edit/:name", requiresAuth, (req, res) => {
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
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts.json"), "utf8"));
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
    fs.writeFileSync(path.join(__dirname, "scripts.json"), JSON.stringify(data, null, 2));
    commitScriptsUpdate(`Update script ${name}`, [scriptPath, configPath]);
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
    cronLines = safeExecSync("sudo crontab -l").toString().split(/\r?\n/);
  } catch (e) {
    cronLines = [];
  }
  const filtered = cronLines.filter((l) => l && !l.includes(oldKey));
  filtered.push(`${timer} ${buildCronCommand(script, configPath)} # ${cronKey}`);
  const newCron = filtered.join("\n") + "\n";
  try {
    safeExecSync("sudo crontab -", { input: newCron });
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  removeLogrotateConfig(oldLog);
  writeLogrotateConfig(log, timer);
  if (oldConfigPath && oldConfigPath !== configPath && !configPath) {
    CONFIG_PATHS[name] = "";
  }

  loadCronTimers();

  flash(req, "success", `✅ Saved '${name}' successfully.`);
  res.redirect("/");
});

app.get("/toggle_cron/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const tag = CRON_KEYS[name];
  if (!tag) {
    flash(req, "error", "❌ Unknown script tag.");
    return res.redirect("/");
  }
  const cronLines = safeExecSync("sudo crontab -l").toString().split(/\r?\n/);
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
  safeExecSync("sudo crontab -", { input: newCron });
  flash(
    req,
    "success",
    `${resumed ? "▶️ Resumed" : "⏸️ Paused"} cron job for '${name}'.`
  );
  res.redirect("/");
});

app.post("/reorder", requiresAuth, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "Invalid order" });
  }
  let data;
  try {
    data = JSON.parse(
      fs.readFileSync(path.join(__dirname, "scripts.json"), "utf8")
    );
  } catch (e) {
    data = {};
  }
  order.forEach((name, idx) => {
    if (data[name]) data[name].order = idx;
  });
  try {
    fs.writeFileSync(
      path.join(__dirname, "scripts.json"),
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    return res.status(500).json({ error: "Failed to save order" });
  }
  scriptOrder = order;
  commitScriptsUpdate("chore: update script order");

  res.json({ success: true });
});

app.post("/update", requiresAuth, (req, res) => {
  try {
    safeSpawn("/bin/bash", ["/home/pi/pi-script-dashboard/update_dashboard.sh"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    res.redirect("/?updated=true");
  } catch (e) {
    flash(req, "error", `❌ Failed to run update script: ${e}`);
    res.redirect("/");
  }
});

app.get("/update-status", requiresAuth, (req, res) => {
  const updating = fs.existsSync("/tmp/dashboard-update.lock");
  res.json({ updating });
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () =>
  console.log("Server running on port " + port)
);
