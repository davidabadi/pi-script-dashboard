"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { backup } = require("node:sqlite");
const { shellQuote, stableJobId, validateCron, validateManagedPath, validateName } = require("../security");

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const MARKER = new RegExp(`# pi-dashboard:(${UUID}|[a-f0-9]{16})\\s*$`, "i");

function readCrontab() {
  if (process.platform !== "linux") throw new Error("Cron scheduling requires Linux.");
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (!result.error && result.status === 1 && /no crontab for/i.test(result.stderr || "")) return "";
  if (result.error || result.status !== 0) throw new Error(`Could not read the service-user crontab: ${result.error ? result.error.message : String(result.stderr || "crontab failed").trim()}`);
  return result.stdout;
}

function writeCrontab(content) {
  if (process.platform !== "linux") throw new Error("Cron scheduling requires Linux.");
  const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (result.error || result.status !== 0) throw new Error(`Could not write the service-user crontab: ${result.error ? result.error.message : String(result.stderr || "crontab failed").trim()}`);
}

function commandWords(command) {
  const words = [];
  let current = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = ""; else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "$" || char === "`") throw new Error("Shell expansion is not allowed in managed cron commands.");
      else if (char === "\\" && /[\\"$`]/.test(command[index + 1] || "")) current += command[++index];
      else current += char;
    } else if (/\s/.test(char)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      if (index + 1 === command.length) throw new Error("Incomplete cron command escape.");
      current += command[++index];
      started = true;
    } else {
      if (/[;$`|&<>()[\]{}#%\r\n]/.test(char)) throw new Error("Managed cron commands must contain only literal arguments.");
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in managed cron command.");
  if (started) words.push(current);
  return words;
}

function parseEntry(line) {
  let content = line.trim();
  const paused = content.startsWith("#");
  if (paused) content = content.replace(/^#\s*/, "");
  const match = /^(?:(@\w+)|((?:\S+\s+){4}\S+))\s+(.+)$/.exec(content);
  if (!match) throw new Error("Managed cron entry has an invalid schedule.");
  const marker = MARKER.exec(match[3]);
  const command = marker ? match[3].slice(0, marker.index).trim() : match[3].trim();
  if (/(^|[^\\])%/.test(command)) throw new Error("Unescaped percent signs are not allowed in managed cron commands.");
  return { schedule: validateCron(match[1] || match[2]), paused, command, marker: marker ? marker[1].toLowerCase() : null };
}

function enqueueArguments(jobId, config, options = {}) {
  return [options.nodePath || (process.platform === "linux" ? "/usr/local/bin/node" : process.execPath), options.enqueuePath || path.resolve(__dirname, "..", "bin", "enqueue.js"), "--db", config.dbFile, "--job", jobId];
}

function quoteCronArgument(value) {
  // Cron processes percent signs before invoking the shell, even inside quotes.
  if (/[\r\n\0%]/.test(String(value))) throw new Error("Cron arguments cannot contain line breaks, NUL, or percent signs.");
  return shellQuote(value);
}

function renderCron(job, config, options = {}) {
  if (!job.schedule) return "";
  const schedule = validateCron(job.schedule);
  return `${job.paused ? "# " : ""}${schedule} ${enqueueArguments(job.id, config, options).map(quoteCronArgument).join(" ")} # pi-dashboard:${job.id}`;
}

function equalWords(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function linesOf(content) {
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function syncSchedules(store, config, options = {}) {
  store.setSetting("scheduler_pending", true);
  if (store.getSetting("content_recovery")) throw new Error("Recover the interrupted file edit before synchronizing schedules.");
  const read = options.readCrontab || readCrontab;
  const write = options.writeCrontab || writeCrontab;
  const original = read();
  const jobs = store.listJobs();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const legacyMap = options.legacyMap || {};
  const seen = new Set();
  const preserved = [];
  for (const line of linesOf(original)) {
    const marker = MARKER.exec(line);
    const id = marker && marker[1].toLowerCase();
    const job = byId.get(id) || (legacyMap[id] && byId.get(legacyMap[id]));
    if (!job) { preserved.push(line); continue; }
    if (seen.has(job.id)) throw new Error(`Duplicate managed cron entries for ${job.name}; resolve them before retrying.`);
    seen.add(job.id);
    const entry = parseEntry(line);
    const expected = id === job.id ? enqueueArguments(job.id, config, options) : ["/bin/bash", job.script, ...(job.config_path ? [job.config_path] : [])];
    if (!equalWords(commandWords(entry.command), expected)) throw new Error(`Managed cron marker for ${job.name} is attached to an unexpected command; refusing to replace it.`);
  }
  for (const job of jobs) {
    const rendered = renderCron(job, config, options);
    if (rendered) preserved.push(rendered);
  }
  const desired = preserved.length ? preserved.join("\n") + "\n" : "";
  if (read() !== original) throw new Error("The crontab changed during synchronization; retry after reviewing it.");
  if (desired !== original) write(desired);
  if (linesOf(read()).join("\n") !== linesOf(desired).join("\n")) throw new Error("Cron synchronization could not be verified.");
  store.setSetting("scheduler_pending", false);
  return desired;
}

async function createBackup(store, config, output, options = {}) {
  if (!output) throw new Error("A new backup output directory is required.");
  if (store.getSetting("content_recovery")) throw new Error("Recover the interrupted file edit before creating an application backup.");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  try {
    const cron = options.crontab === undefined ? (options.readCrontab || readCrontab)() : options.crontab;
    const manifest = { created_at: new Date().toISOString(), database: config.dbFile, legacy_file: config.dataFile, files: [] };
    await backup(store.db, path.join(output, "dashboard.sqlite"));
    manifest.files.push("dashboard.sqlite");
    if (fs.existsSync(config.dataFile)) {
      if (fs.lstatSync(config.dataFile).isSymbolicLink()) throw new Error("Legacy registry must not be a symbolic link.");
      fs.copyFileSync(config.dataFile, path.join(output, "scripts.json"), fs.constants.COPYFILE_EXCL);
      manifest.files.push("scripts.json");
    }
    fs.writeFileSync(path.join(output, "crontab.txt"), cron, { mode: 0o600, flag: "wx" });
    manifest.files.push("crontab.txt");
    for (const name of manifest.files) fs.chmodSync(path.join(output, name), 0o600);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return output;
  } catch (error) {
    // Retain partial backups for diagnosis; their absence from completed metadata
    // ensures they are never accepted as a migration rollback point.
    throw new Error(`Backup incomplete (${output}): ${error.message}`);
  }
}

function validateLegacy(legacy, config) {
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("Legacy registry must be a JSON object.");
  const resources = new Set();
  return Object.entries(legacy).sort((a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0)).map(([name, info], position) => {
    validateName(name);
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`Invalid registry entry: ${name}.`);
    const script = validateManagedPath(info.script, config.scriptRoot, [".sh"]);
    const log = validateManagedPath(info.log, config.logRoot, [".log"]);
    const lock = validateManagedPath(info.lock, config.lockRoot);
    const configPath = info.config_path ? validateManagedPath(info.config_path, config.configRoot, [".conf", ".json", ".yaml", ".yml"]) : "";
    for (const resource of [log, lock]) {
      if (resources.has(resource)) throw new Error(`Jobs share a log or lock path (${resource}); give each job its own path before migration.`);
      resources.add(resource);
    }
    return { name, script, log, lock, config_path: configPath, log_mode: "file", schedule: "", paused: true, position, legacy_marker: stableJobId(name) };
  });
}

async function migrateLegacy(store, config, options = {}) {
  const read = options.readCrontab || readCrontab;
  const existingMap = store.getSetting("migration_mapping");
  if (existingMap) {
    if (store.getSetting("migration_source_hash") !== crypto.createHash("sha256").update(fs.readFileSync(config.dataFile)).digest("hex")) throw new Error("Legacy registry changed after migration began; restore its backed-up source before resuming.");
    syncSchedules(store, config, { ...options, legacyMap: existingMap });
    store.markReady();
    return { imported: 0, resumed: true, backup: store.getSetting("migration_backup") };
  }
  if (store.listJobs().length) throw new Error("Database already contains jobs; legacy import will not overwrite them.");
  if (!fs.existsSync(config.dataFile) || fs.lstatSync(config.dataFile).isSymbolicLink()) throw new Error("An existing regular legacy registry is required.");
  const source = fs.readFileSync(config.dataFile);
  const jobs = validateLegacy(JSON.parse(source.toString("utf8")), config);
  const originalCron = read();
  const markers = new Map(jobs.map((job) => [job.legacy_marker, job]));
  const seen = new Set();
  for (const line of linesOf(originalCron)) {
    const marker = MARKER.exec(line);
    const job = marker && markers.get(marker[1].toLowerCase());
    if (job) {
      if (seen.has(job.name)) throw new Error(`Duplicate legacy cron entries for ${job.name}; resolve them before migration.`);
      seen.add(job.name);
      const entry = parseEntry(line);
      if (!equalWords(commandWords(entry.command), ["/bin/bash", job.script, ...(job.config_path ? [job.config_path] : [])])) throw new Error(`Legacy cron command for ${job.name} does not match its registry paths.`);
      job.schedule = entry.schedule;
      job.paused = entry.paused;
    } else if (line.trim() && !line.trim().startsWith("#")) {
      // A direct invocation without its owned marker could otherwise keep
      // executing alongside the new worker after import.
      let words;
      try { words = commandWords(parseEntry(line).command); } catch { continue; }
      if (jobs.some((candidate) => words.includes(candidate.script))) throw new Error("An unrecognized cron entry directly launches a managed script; review it before migration.");
    }
  }
  const backupParent = options.backupDir || path.join(config.runtimeRoot, "backups");
  fs.mkdirSync(backupParent, { recursive: true, mode: 0o700 });
  const backupDir = path.join(backupParent, `migration-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  await createBackup(store, config, backupDir, { ...options, crontab: originalCron });
  if (read() !== originalCron || !fs.readFileSync(config.dataFile).equals(source)) throw new Error("Registry or crontab changed while creating the backup; retry without changing the source.");
  const mapping = {};
  store.transaction(() => {
    const insert = store.db.prepare("INSERT INTO jobs(id,name,script,log,lock,config_path,log_mode,schedule,paused,position) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const job of jobs) {
      const id = crypto.randomUUID();
      insert.run(id, job.name, job.script, job.log, job.lock, job.config_path, job.log_mode, job.schedule, Number(job.paused), job.position);
      mapping[job.legacy_marker] = id;
    }
    store.setSetting("migration_mapping", mapping);
    store.setSetting("migration_backup", backupDir);
    store.setSetting("migration_source_hash", crypto.createHash("sha256").update(source).digest("hex"));
    store.setSetting("ready", false);
    store.setSetting("scheduler_pending", true);
  });
  syncSchedules(store, config, { ...options, legacyMap: mapping });
  store.markReady();
  return { imported: jobs.length, resumed: false, backup: backupDir };
}

module.exports = { commandWords, createBackup, migrateLegacy, parseEntry, readCrontab, renderCron, syncSchedules, writeCrontab };
