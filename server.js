const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const os = require("os");
const isLinux = os.platform() === "linux";
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
  pam = require("authenticate-pam");
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

const SCRIPTS = {
  "Conabadi MySQL Backup": "/usr/local/bin/backup_conabadi_db.sh",
  "Unraid Backup": "/usr/local/bin/backup_unraid.sh",
  "Update + Reboot": "/usr/local/bin/update_and_reboot.sh",
};

const LOGS = {
  "Conabadi MySQL Backup": "/var/log/custom/conabadi_db_backup.log",
  "Unraid Backup": "/var/log/custom/backup_unraid.log",
  "Update + Reboot": "/var/log/custom/update_and_reboot.log",
};

const CRON_TAGS = {
  "Conabadi MySQL Backup": "backup_conabadi_db.sh",
  "Unraid Backup": "backup_unraid.sh",
  "Update + Reboot": "update_and_reboot.sh",
};

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

  if (isLinux) {
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
    // fallback for non-Linux (e.g. Windows/macOS)
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
  const cronOutput = execSync("sudo crontab -l").toString();
  const cronLines = cronOutput.split(/\r?\n/);
  const paused = {};
  const last_status = {};
  for (const [name, tag] of Object.entries(CRON_TAGS)) {
    paused[name] = cronLines.some(
      (l) => l.includes(tag) && l.trim().startsWith("#")
    );
    const logPath = LOGS[name];
    if (logPath && fs.existsSync(logPath)) {
      try {
        const lines = fs
          .readFileSync(logPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .slice(-10);
        last_status[name] = lines.reverse().some((l) => l.includes("✅"));
      } catch (e) {
        last_status[name] = null;
      }
    } else {
      last_status[name] = null;
    }
  }
  const messages = req.session.messages || [];
  req.session.messages = [];
  res.render("index", {
    scripts: SCRIPTS,
    logs: LOGS,
    cron_output: cronOutput,
    paused,
    last_status,
    messages,
  });
});

app.get("/run/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const script = SCRIPTS[name];
  if (script) {
    try {
      spawn("sudo", ["/bin/bash", script], {
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

app.get("/toggle_cron/:name", requiresAuth, (req, res) => {
  const name = req.params.name;
  const tag = CRON_TAGS[name];
  if (!tag) {
    flash(req, "error", "❌ Unknown script tag.");
    return res.redirect("/");
  }
  const cronLines = execSync("sudo crontab -l").toString().split(/\r?\n/);
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
  execSync("sudo crontab -", { input: newCron });
  flash(
    req,
    "success",
    `${resumed ? "▶️ Resumed" : "⏸️ Paused"} cron job for '${name}'.`
  );
  res.redirect("/");
});

app.post("/update", requiresAuth, (req, res) => {
  try {
    spawn("/bin/bash", ["/home/pi/pi-script-dashboard/update_dashboard.sh"], {
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
