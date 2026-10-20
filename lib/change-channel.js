"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

const local = new EventEmitter();
local.setMaxListeners(0);
const warned = new Set();
const RUN_LOG = /^([a-zA-Z0-9_-]{1,128})\.log$/;

function signalPath(dbFile) {
  return dbFile && dbFile !== ":memory:" ? `${path.resolve(dbFile)}.changes` : null;
}

// Only a wakeup is stored here. SQLite and the captured logs remain authoritative;
// an initial/reconnection snapshot recovers changes made while no subscriber exists.
function publishStateChange(dbFile) {
  const file = signalPath(dbFile);
  if (!file) return;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("Change signal must be a private regular file.");
    fs.fchmodSync(fd, 0o600);
    const token = `${randomUUID()}\n`;
    fs.writeSync(fd, token, 0, "utf8");
    fs.ftruncateSync(fd, Buffer.byteLength(token));
  } catch (error) {
    // A committed run must never look rejected because its optional wakeup failed.
    // Same-process subscribers still receive the notification below.
    if (!warned.has(file)) {
      warned.add(file);
      process.emitWarning(`Dashboard change notifications could not be persisted: ${error.message}`);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  local.emit(file, { type: "state" });
}

function publishLogChange(config, runId) {
  local.emit(path.resolve(config.logRoot, "runs"), { type: "log", runId });
}

function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Change notification directory must not be a symbolic link.");
}

/**
 * Subscribe to committed registry changes and authoritative captured log writes.
 * callback({type: "state"}) or callback({type: "log", runId}); runId can be null
 * when the filesystem cannot identify a changed log. Watcher failure is delivered
 * as callback({type: "error", error}) so an SSE owner can disconnect/reconnect.
 * Returns an idempotent close function. Watchers are unref'ed and data is never
 * polled. Subscribe before reading the initial SQLite/log snapshot.
 */
function subscribeChanges(config, callback) {
  if (typeof callback !== "function") throw new TypeError("Change subscriber requires a callback.");
  const signal = signalPath(config.dbFile);
  const logRoot = path.resolve(config.logRoot);
  const logs = path.join(logRoot, "runs");
  if (!signal) throw new Error("Change subscriptions require a database file.");
  safeDirectory(path.dirname(signal));
  safeDirectory(logRoot);
  safeDirectory(logs);
  let closed = false;
  let scheduled = false;
  const pending = new Map();
  const watchers = new Set();
  let logWatcher;
  const enqueue = (event) => {
    if (closed) return;
    pending.set(event.type === "log" ? `log:${event.runId || "*"}` : event.type, event);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const events = [...pending.values()];
      pending.clear();
      for (const change of events) {
        if (closed) break;
        callback(change);
      }
    });
  };
  const watch = (directory, listener) => {
    const watcher = fs.watch(directory, { persistent: false }, listener);
    watcher.on("error", (error) => enqueue({ type: "error", error }));
    watcher.unref();
    watchers.add(watcher);
    return watcher;
  };
  const watchLogs = () => {
    if (logWatcher) { logWatcher.close(); watchers.delete(logWatcher); }
    safeDirectory(logs);
    logWatcher = watch(logs, (_event, filename) => {
      const match = filename && RUN_LOG.exec(String(filename));
      if (!filename || match) enqueue({ type: "log", runId: match ? match[1] : null });
    });
  };
  const stateListener = (event) => enqueue(event);
  const logListener = (event) => enqueue(event);
  try {
    watch(path.dirname(signal), (_event, filename) => {
      if (!filename || String(filename) === path.basename(signal)) enqueue({ type: "state" });
    });
    watch(logRoot, (event, filename) => {
      if (event === "rename" && (!filename || String(filename) === "runs")) {
        try { watchLogs(); enqueue({ type: "log", runId: null }); }
        catch (error) { enqueue({ type: "error", error }); }
      }
    });
    watchLogs();
    local.on(signal, stateListener);
    local.on(logs, logListener);
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return () => {
    if (closed) return;
    closed = true;
    pending.clear();
    local.off(signal, stateListener);
    local.off(logs, logListener);
    for (const watcher of watchers) watcher.close();
    watchers.clear();
  };
}

module.exports = { publishLogChange, publishStateChange, signalPath, subscribeChanges };
