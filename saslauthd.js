"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_SOCKET = "/run/pi-dashboard-auth/mux";
const PAM_SERVICE = "pi-script-dashboard";
const MAX_PASSWORD_BYTES = 256;
const MAX_RESPONSE_BYTES = 1024;
const MAX_CONCURRENT = 16;
const MAX_TIMEOUT_MS = 10000;
let activeRequests = 0;

// Called at startup on the deployment host. Socket permissions and its parent
// directory must be managed by root; lstat also prevents a socket symlink.
function checkSocket(socketPath = process.env.PAM_SOCKET || DEFAULT_SOCKET) {
  if (
    typeof socketPath !== "string" ||
    !path.isAbsolute(socketPath) ||
    socketPath.includes("\0") ||
    !fs.lstatSync(socketPath).isSocket()
  ) {
    throw new Error("PAM_SOCKET must name an existing absolute Unix socket.");
  }
  return true;
}

function authenticate(username, password, options = {}) {
  const socketPath = options?.socketPath ?? (process.env.PAM_SOCKET || DEFAULT_SOCKET);
  const timeoutMs = options?.timeoutMs ?? MAX_TIMEOUT_MS;
  if (
    typeof username !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}\$?$/.test(username) ||
    Buffer.byteLength(username, "utf8") > 128 ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.includes("\0") ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES ||
    typeof socketPath !== "string" ||
    socketPath.length === 0 ||
    socketPath.length > 4096 ||
    socketPath.includes("\0") ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    activeRequests >= MAX_CONCURRENT
  ) {
    return Promise.resolve(false);
  }

  // saslauthd 2.1.28: four uint16BE-counted UTF-8 fields, without NULs.
  // The service is fixed so clients cannot select another host PAM policy.
  const fields = [username, password, PAM_SERVICE, ""];
  const request = Buffer.alloc(8 + fields.reduce((sum, field) => sum + Buffer.byteLength(field, "utf8"), 0));
  let offset = 0;
  for (const field of fields) {
    const length = Buffer.byteLength(field, "utf8");
    request.writeUInt16BE(length, offset);
    offset += 2;
    offset += request.write(field, offset, length, "utf8");
  }
  const response = Buffer.alloc(MAX_RESPONSE_BYTES + 2);
  activeRequests += 1;

  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    let received = 0;
    let expected;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      request.fill(0);
      response.fill(0);
      activeRequests -= 1;
      resolve(result);
    }

    // An absolute deadline, rather than socket inactivity, bounds drip replies.
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = new net.Socket();
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
      socket.once("connect", () => {
        if (!settled) socket.write(request, () => request.fill(0));
      });
      socket.on("data", (chunk) => {
        if (settled) return;
        if (received + chunk.length > response.length) return finish(false);
        chunk.copy(response, received);
        received += chunk.length;
        if (expected === undefined && received >= 2) {
          expected = response.readUInt16BE(0);
          if (expected < 2 || expected > MAX_RESPONSE_BYTES) return finish(false);
        }
        if (expected !== undefined && received > expected + 2) finish(false);
      });
      socket.once("end", () => {
        if (settled) return;
        if (expected === undefined || received !== expected + 2) return finish(false);
        try {
          // Actual 2.1.28 replies exclude NUL despite the protocol comment.
          // Require EOF so a valid prefix followed by extra data cannot pass.
          const message = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.subarray(2, received));
          finish(/^OK(?: [^\u0000-\u001f\u007f]*)?$/u.test(message));
        } catch {
          finish(false);
        }
      });
      socket.connect({ path: socketPath });
    } catch {
      finish(false);
    }
  });
}

module.exports = { authenticate, checkSocket };
