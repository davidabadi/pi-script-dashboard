"use strict";

const path = require("node:path");

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new Error(`Invalid ${label}.`);
  return result;
}

function readConfig(env = process.env) {
  const linux = process.platform === "linux";
  const runtimeRoot = path.resolve(env.RUNTIME_ROOT || (linux ? "/var/lib/pi-script-dashboard" : path.join(__dirname, "..", ".runtime")));
  return {
    runtimeRoot,
    scriptRoot: path.resolve(env.SCRIPT_ROOT || path.join(runtimeRoot, "scripts")),
    configRoot: path.resolve(env.CONFIG_ROOT || path.join(runtimeRoot, "configs")),
    logRoot: path.resolve(env.LOG_ROOT || (linux ? "/var/log/pi-script-dashboard" : path.join(runtimeRoot, "logs"))),
    lockRoot: path.resolve(env.LOCK_ROOT || (linux ? "/run/pi-script-dashboard" : path.join(runtimeRoot, "locks"))),
    dataFile: path.resolve(env.DATA_FILE || path.join(runtimeRoot, "scripts.json")),
    dbFile: path.resolve(env.DB_FILE || path.join(runtimeRoot, "dashboard.sqlite")),
    sessionDir: path.resolve(env.SESSION_DIR || path.join(runtimeRoot, "sessions")),
    auditLog: path.resolve(env.AUDIT_LOG || path.join(env.LOG_ROOT || (linux ? "/var/log/pi-script-dashboard" : path.join(runtimeRoot, "logs")), "audit.jsonl")),
    hookPort: positiveInteger(env.HOOK_PORT, 8081, "HOOK_PORT", 65535),
    retentionDays: positiveInteger(env.RETENTION_DAYS, 30, "RETENTION_DAYS"),
    maxLogBytes: positiveInteger(env.MAX_LOG_BYTES, 10 * 1024 * 1024, "MAX_LOG_BYTES"),
  };
}

module.exports = { readConfig };
