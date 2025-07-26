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
const lockFile = "/tmp/dashboard-update.lock";

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

const scriptsData = require("./scripts.json");

const SCRIPTS = {};
const LOGS = {};
const CRON_TAGS = {};
const LOCKS = {};
const CRON_TIMERS = {};


for (const [name, info] of Object.entries(scriptsData)) {
  SCRIPTS[name] = info.script;
  LOGS[name] = info.log;
  CRON_TAGS[name] = info.cron_tag;
  LOCKS[name] = info.lock;
}

function loadCronTimers() {
  let lines = [];
  try {
    lines = safeExecSync("sudo crontab -l").toString().split(/\r?\n/);
  } catch (e) {
    lines = [];
  }
  for (const [name, tag] of Object.entries(CRON_TAGS)) {
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
  res.render("login", { messages });
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
  for (const [name, tag] of Object.entries(CRON_TAGS)) {
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
        lastRun[name] = stats.mtime.toLocaleString();
        const lines = fs
          .readFileSync(logPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .slice(-10);
        status[name] = lines.reverse().some((l) => l.includes("✅"))
          ? "success"
          : "failed";
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
    logs: LOGS,
    cron_output: cronOutput,
    paused,
    status,
    messages,
    last_run: lastRun,
  });
});

app.get("/run/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const script = SCRIPTS[name];
  if (script) {
    try {
      safeSpawn("sudo", ["/bin/bash", script], {
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
    res.render("log", { name, content });
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
    cron_tag: "",
    lock: "/etc/",
    timer: "* * * * *",
    content: "",
  };
  res.render("form", { isNew: true, data, messages });
});

app.post("/new", requiresAuth, (req, res) => {
  const { name, script, log, cron_tag, lock, timer, content } = req.body;
  const normalized = (content || "").replace(/\r/g, "");
  try {
    safeSpawnSync("sudo", ["tee", script], {
      input: normalized,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
    safeSpawnSync("sudo", ["chmod", "+x", script]);
  } catch (e) {
    flash(req, "error", `❌ Failed to write script: ${e.message}`);
    return res.redirect("/");
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts.json"), "utf8"));
  } catch (e) {
    data = {};
  }
  data[name] = { script, log, cron_tag, lock };
  try {
    fs.writeFileSync(path.join(__dirname, "scripts.json"), JSON.stringify(data, null, 2));
    safeSpawnSync("git", ["add", "scripts.json", script]);
    safeSpawnSync("git", ["commit", "-m", `Add script ${name}`]);
    safeSpawnSync("git", ["push"]);
  } catch (e) {
    console.warn("Git commit/push failed:", e.message);
  }
  SCRIPTS[name] = script;
  LOGS[name] = log;
  CRON_TAGS[name] = cron_tag;
  LOCKS[name] = lock;

  let cronContent = "";
  try {
    cronContent = safeExecSync("sudo crontab -l").toString();
  } catch (e) {
    cronContent = "";
  }
  cronContent += `\n${timer} /bin/bash ${script} >> ${log} 2>&1 # ${cron_tag}\n`;
  try {
    safeExecSync("sudo crontab -", { input: cronContent });
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  loadCronTimers();

  flash(req, "success", `✅ Added script '${name}'.`);
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
    cron_tag: CRON_TAGS[name] || "",
    lock: LOCKS[name] || "",
    timer: CRON_TIMERS[name] || "",
    content,
  };
  res.render("form", { isNew: false, data, messages });
});

app.post("/edit/:name", requiresAuth, (req, res) => {
  const oldName = req.params.name;
  const { name, script, log, cron_tag, lock, timer, content } = req.body;
  const scriptPath = script;
  const oldTag = CRON_TAGS[oldName];
  if (!scriptPath) {
    flash(req, "error", "❌ Script path required.");
    return res.redirect("/");
  }
  const normalized = (content || "").replace(/\r/g, "");
  try {
    safeSpawnSync("sudo", ["tee", scriptPath], {
      input: normalized,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
    safeSpawnSync("sudo", ["chmod", "+x", scriptPath]);
  } catch (e) {
    flash(req, "error", `❌ Failed to write script: ${e.message}`);
    return res.redirect("/");
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "scripts.json"), "utf8"));
  } catch (e) {
    data = {};
  }
  delete data[oldName];
  data[name] = { script, log, cron_tag, lock };
  try {
    fs.writeFileSync(path.join(__dirname, "scripts.json"), JSON.stringify(data, null, 2));
    safeSpawnSync("git", ["add", "scripts.json", scriptPath]);
    safeSpawnSync("git", ["commit", "-m", `Update script ${name}`]);
    safeSpawnSync("git", ["push"]);
  } catch (e) {
    console.warn("Git commit/push failed:", e.message);
  }

  delete SCRIPTS[oldName];
  delete LOGS[oldName];
  delete CRON_TAGS[oldName];
  delete LOCKS[oldName];
  delete CRON_TIMERS[oldName];

  SCRIPTS[name] = script;
  LOGS[name] = log;
  CRON_TAGS[name] = cron_tag;
  LOCKS[name] = lock;

  let cronLines = [];
  try {
    cronLines = safeExecSync("sudo crontab -l").toString().split(/\r?\n/);
  } catch (e) {
    cronLines = [];
  }
  const filtered = cronLines.filter((l) => l && !l.includes(oldTag));
  filtered.push(`${timer} /bin/bash ${script} >> ${log} 2>&1 # ${cron_tag}`);
  const newCron = filtered.join("\n") + "\n";
  try {
    safeExecSync("sudo crontab -", { input: newCron });
  } catch (e) {
    flash(req, "error", `❌ Failed to update cron: ${e.message}`);
    return res.redirect("/");
  }

  loadCronTimers();

  flash(req, "success", `✅ Saved '${name}' successfully.`);
  res.redirect("/");
});

app.get("/toggle_cron/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const tag = CRON_TAGS[name];
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
