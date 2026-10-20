"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateManagedPath } = require("../security");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function durableFile(file, content, mode) {
  const fd = fs.openSync(file, "wx", mode);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Edit recovery directories must be real directories.");
  fs.chmodSync(directory, 0o700);
}

function writeAtomic(file, content, mode) {
  privateDirectory(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    durableFile(temp, content, mode);
    fs.renameSync(temp, file);
    fs.chmodSync(file, mode);
    syncDirectory(path.dirname(file));
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function validateFile(file, config) {
  let validated;
  try { validated = validateManagedPath(file, config.scriptRoot, [".sh"]); }
  catch { validated = validateManagedPath(file, config.configRoot, [".conf", ".json", ".yaml", ".yml"]); }
  if (fs.existsSync(validated) && !fs.lstatSync(validated).isFile()) throw new Error("Script and config paths must be regular files.");
  return validated;
}

function synchronous(callback, label) {
  if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") throw new Error(`${label} must be synchronous.`);
  return () => {
    const result = callback();
    if (result && typeof result.then === "function") throw new Error(`${label} must not return a Promise.`);
    return result;
  };
}

function journalDirectory(config, id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid edit recovery record; inspect the protected recovery directory.");
  const root = path.resolve(config.runtimeRoot, "edit-recovery");
  const directory = path.resolve(root, id);
  if (path.dirname(directory) !== root) throw new Error("Invalid edit recovery directory.");
  return { root, directory };
}

function removeJournal(config, id) {
  const { root, directory } = journalDirectory(config, id);
  // The UUID and exact parent check above keep recursive removal confined to
  // this operation's recovery directory, including on Windows.
  fs.rmSync(directory, { recursive: true, force: true });
  syncDirectory(root);
}

function createJournal(config, writes) {
  const id = crypto.randomUUID();
  const { root, directory } = journalDirectory(config, id);
  privateDirectory(root);
  privateDirectory(directory);
  const manifest = { version: 1, created_at: new Date().toISOString(), files: [] };
  for (let index = 0; index < writes.length; index += 1) {
    const file = validateFile(writes[index].file, config);
    const existed = fs.existsSync(file);
    const content = existed ? fs.readFileSync(file) : null;
    const entry = { file, existed, mode: existed ? fs.statSync(file).mode & 0o777 : 0o600, backup: `${index}.bin`, sha256: content === null ? null : digest(content) };
    if (content !== null) durableFile(path.join(directory, entry.backup), content, 0o600);
    manifest.files.push(entry);
  }
  durableFile(path.join(directory, "manifest.json"), JSON.stringify(manifest) + "\n", 0o600);
  syncDirectory(directory);
  syncDirectory(root);
  return { id, directory, manifest };
}

function readJournal(config, id) {
  const { root, directory } = journalDirectory(config, id);
  for (const dir of [root, directory]) {
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Recovery journal directory is invalid.");
  }
  const manifestPath = path.join(directory, "manifest.json");
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("Recovery manifest must not be a symbolic link.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 2) throw new Error("Invalid edit recovery manifest.");
  const seen = new Set();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const file = validateFile(entry.file, config);
    if (seen.has(file) || typeof entry.existed !== "boolean" || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || entry.backup !== `${index}.bin`) throw new Error("Invalid recovery file record.");
    seen.add(file);
    entry.file = file;
    if (entry.existed) {
      const backupFile = path.join(directory, entry.backup);
      const stats = fs.lstatSync(backupFile);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Recovery backup must be a regular file.");
      entry.content = fs.readFileSync(backupFile);
      if (digest(entry.content) !== entry.sha256) throw new Error("Recovery backup checksum failed; preserve the journal for manual review.");
    }
  }
  return manifest;
}

function restoreFiles(manifest, attempted = null) {
  for (const entry of [...manifest.files].reverse()) {
    if (attempted && !attempted.has(entry.file)) continue;
    if (entry.existed) writeAtomic(entry.file, entry.content, entry.mode);
    else if (fs.existsSync(entry.file)) {
      if (!fs.lstatSync(entry.file).isFile()) throw new Error("Refusing to remove a non-file during edit recovery.");
      fs.unlinkSync(entry.file);
      syncDirectory(path.dirname(entry.file));
    }
  }
}

function editJobFiles(store, config, { writes, check, save }) {
  const checkSync = synchronous(check, "Edit guard");
  const saveSync = synchronous(save, "Metadata save");
  if (store.getSetting("content_recovery")) throw new Error("Recover the interrupted file edit before saving more changes.");
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 2) throw new Error("An edit must contain one script and at most one config file.");
  const normalized = writes.map((write) => {
    if (!write || !(typeof write.content === "string" || Buffer.isBuffer(write.content)) || ![0o600, 0o700].includes(write.mode)) throw new Error("Invalid private file update.");
    return { ...write, file: validateFile(write.file, config) };
  });
  if (new Set(normalized.map((write) => write.file)).size !== normalized.length) throw new Error("An edit cannot write the same file twice.");
  const previousPending = store.getSetting("scheduler_pending") || false;
  store.setSetting("scheduler_pending", true);
  const journal = createJournal(config, normalized);
  store.setSetting("content_recovery", journal.id);
  const attempted = new Set();
  let saved;
  try {
    saved = store.transaction(() => {
      checkSync();
      for (const write of normalized) {
        attempted.add(write.file);
        writeAtomic(write.file, write.content, write.mode);
      }
      const result = saveSync();
      // The recovery marker and metadata commit together. A journal that is
      // still referenced therefore always describes uncommitted disk changes.
      store.setSetting("content_recovery", null);
      return result;
    });
  } catch (error) {
    try {
      const manifest = readJournal(config, journal.id);
      store.transaction(() => {
        restoreFiles(manifest, attempted);
        store.setSetting("content_recovery", null);
        store.setSetting("scheduler_pending", previousPending);
      });
      try { removeJournal(config, journal.id); } catch {}
    } catch (restoreError) {
      store.setSetting("scheduler_pending", true);
      const failed = new Error(`${error.message} File recovery could not finish; use Recover interrupted edit before synchronizing schedules.`);
      failed.cause = restoreError;
      failed.recoveryRequired = true;
      throw failed;
    }
    throw error;
  }
  // A cleanup problem after commit must never roll back committed file data.
  try { removeJournal(config, journal.id); } catch {}
  return saved;
}

function recoverJobFiles(store, config) {
  const id = store.getSetting("content_recovery");
  if (!id) return false;
  const manifest = readJournal(config, id);
  store.transaction(() => {
    if (store.db.prepare("SELECT id FROM runs WHERE status='running' LIMIT 1").get()) throw new Error("Wait for running jobs to finish before recovering an interrupted edit.");
    restoreFiles(manifest);
    store.setSetting("content_recovery", null);
    store.setSetting("scheduler_pending", true);
  });
  try { removeJournal(config, id); } catch {}
  return true;
}

module.exports = { editJobFiles, recoverJobFiles };
