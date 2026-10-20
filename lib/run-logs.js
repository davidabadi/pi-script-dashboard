"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { publishLogChange } = require("./change-channel");

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const DEFAULT_LIMIT = 64 * 1024;

function runLogPath(config, run) {
  const id = typeof run === "string" ? run : run.id;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id || ""))) throw new Error("Invalid run ID.");
  return path.join(config.logRoot, "runs", `${id}.log`);
}

function ensureLogDirectory(config) {
  const directory = path.join(config.logRoot, "runs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Run log directory cannot be a symbolic link.");
  return directory;
}

// Do not expose a partially written character, or split one at a byte limit.
function completeUtf8Length(buffer) {
  if (!buffer.length) return 0;
  let start = buffer.length - 1;
  while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
  if (start < 0) return buffer.length;
  const lead = buffer[start];
  const width = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return buffer.length - start < width ? start : buffer.length;
}

class RunLogWriter {
  constructor(config, run, onFlags = () => {}) {
    ensureLogDirectory(config);
    this.file = runLogPath(config, run);
    this.config = config;
    this.runId = run.id;
    this.maximum = Math.max(0, Number(config.maxLogBytes ?? 10 * 1024 * 1024));
    this.onFlags = onFlags;
    this.truncated = Boolean(run.log_truncated);
    this.captureGap = Boolean(run.capture_gap);
    this.fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }

  append(value) {
    if (this.fd === null || this.truncated) return;
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const available = Math.max(0, this.maximum - this.size);
    let count = Math.min(available, data.length);
    if (count < data.length) count = completeUtf8Length(data.subarray(0, count));
    if (count) {
      fs.writeSync(this.fd, data, 0, count);
      this.size += count;
      publishLogChange(this.config, this.runId);
    }
    if (count < data.length && !this.truncated) {
      this.truncated = true;
      this.onFlags({ log_truncated: 1 });
    }
  }

  markCaptureGap() {
    if (this.captureGap) return;
    this.captureGap = true;
    this.onFlags({ capture_gap: 1 });
  }

  close() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

function readRunLog(config, run, { offset = 0, limit = DEFAULT_LIMIT } = {}) {
  const complete = !ACTIVE_STATUSES.has(run.status);
  const requestedOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
  const requestedLimit = Math.min(256 * 1024, Math.max(4, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  let fd;
  try {
    fd = fs.openSync(runLogPath(config, run), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const size = fs.fstatSync(fd).size;
    let start = Math.min(requestedOffset, size);
    const buffer = Buffer.alloc(Math.min(size - start, requestedLimit));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    let skip = 0;
    while (skip < bytesRead && (buffer[skip] & 0xc0) === 0x80) skip++;
    start += skip;
    const body = buffer.subarray(skip, bytesRead);
    const bytes = completeUtf8Length(body);
    return {
      text: body.subarray(0, bytes).toString("utf8"),
      offset: start,
      nextOffset: start + bytes,
      complete,
      truncated: Boolean(run.log_truncated),
      captureGap: Boolean(run.capture_gap),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { text: "", offset: 0, nextOffset: 0, complete, truncated: Boolean(run.log_truncated), captureGap: Boolean(run.capture_gap) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeRunLog(config, run) {
  try { fs.unlinkSync(runLogPath(config, run)); publishLogChange(config, typeof run === "string" ? run : run.id); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Existing scripts remain owners of their logs. Capture only bytes written after
// this watcher starts, restarting at zero when a replacement/truncation is seen.
class FileLogCapture {
  constructor(file, writer) {
    this.file = file;
    this.writer = writer;
    this.offset = 0;
    this.identity = null;
    this.lastMtime = null;
    this.fingerprint = null;
    try {
      const stats = this.stat();
      this.identity = `${stats.dev}:${stats.ino}`;
      this.offset = stats.size;
      this.lastMtime = stats.mtimeMs;
      this.fingerprint = this.readFingerprint(this.offset);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  stat() {
    const stats = fs.lstatSync(this.file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Configured log must be a regular file.");
    return stats;
  }

  readFingerprint(offset, existingFd) {
    if (!offset) return Buffer.alloc(0);
    const fd = existingFd ?? fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const buffer = Buffer.alloc(Math.min(offset, 64));
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset - buffer.length);
      return buffer.subarray(0, read);
    } finally { if (existingFd === undefined) fs.closeSync(fd); }
  }

  flush() {
    let fd;
    try {
      const stats = this.stat();
      const identity = `${stats.dev}:${stats.ino}`;
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (`${opened.dev}:${opened.ino}` !== identity) { this.writer.markCaptureGap(); return; }
      // A script can truncate and regrow past the old size between polls. Check
      // the bytes preceding our cursor as well as size/inode before appending.
      const overwritten = this.fingerprint && this.offset && stats.size >= this.offset && !this.readFingerprint(this.offset, fd).equals(this.fingerprint);
      if ((this.identity && identity !== this.identity) || stats.size < this.offset || overwritten) {
        this.offset = 0;
        this.writer.markCaptureGap();
      } else if (this.identity && stats.size === this.offset && stats.mtimeMs !== this.lastMtime && stats.size) {
        // A same-size rewrite cannot be attributed safely to this run.
        this.writer.markCaptureGap();
      }
      this.identity = identity;
      this.lastMtime = stats.mtimeMs;
      if (stats.size <= this.offset) return;
      if (this.writer.truncated) { this.offset = stats.size; return; }
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < stats.size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stats.size - this.offset), this.offset);
        if (!read) break;
        this.offset += read;
        this.writer.append(buffer.subarray(0, read));
        if (this.writer.truncated) { this.offset = stats.size; break; }
      }
      this.fingerprint = this.readFingerprint(this.offset, fd);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (this.identity) this.writer.markCaptureGap();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

module.exports = { FileLogCapture, RunLogWriter, readRunLog, removeRunLog, runLogPath };
