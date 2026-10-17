"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { authenticate, checkSocket } = require("../saslauthd");

function encodeResponse(message) {
  const body = Buffer.from(message);
  const frame = Buffer.alloc(body.length + 2);
  frame.writeUInt16BE(body.length);
  body.copy(frame, 2);
  return frame;
}

async function daemon(t, onRequest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-pam-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\dashboard-pam-${crypto.randomUUID()}`
    : path.join(directory, "mux");
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    let incoming = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      const fields = [];
      let offset = 0;
      for (let index = 0; index < 4; index += 1) {
        if (offset + 2 > incoming.length) return;
        const length = incoming.readUInt16BE(offset);
        offset += 2;
        if (offset + length > incoming.length) return;
        fields.push(incoming.subarray(offset, offset + length).toString("utf8"));
        offset += length;
      }
      socket.removeAllListeners("data");
      onRequest(socket, fields, incoming.subarray(offset));
    });
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return socketPath;
}

test("PAM client sends the fixed service and UTF-8 byte lengths", async (t) => {
  const socketPath = await daemon(t, (socket, fields, remainder) => {
    assert.deepEqual(fields, ["pi", "päss🔐", "pi-script-dashboard", ""]);
    assert.equal(remainder.length, 0);
    socket.end(encodeResponse("OK"));
  });
  assert.equal(await authenticate("pi", "päss🔐", { socketPath }), true);
});

test("PAM client accepts a complete fragmented success response", async (t) => {
  const socketPath = await daemon(t, (socket) => {
    const frame = encodeResponse("OK authenticated");
    let offset = 0;
    const interval = setInterval(() => {
      if (socket.destroyed) return clearInterval(interval);
      socket.write(frame.subarray(offset, offset + 1));
      offset += 1;
      if (offset === frame.length) {
        clearInterval(interval);
        socket.end();
      }
    }, 1);
    t.after(() => clearInterval(interval));
  });
  assert.equal(await authenticate("pi", "correct", { socketPath }), true);
});

test("PAM denial and malformed replies fail closed", async (t) => {
  const cases = [
    ["wrong password", encodeResponse("NO authentication failed")],
    ["almost OK", encodeResponse("OKAY")],
    ["lowercase", encodeResponse("ok")],
    ["NUL suffix", encodeResponse("OK\0")],
    ["newline suffix", encodeResponse("OK\n")],
    ["invalid UTF-8", encodeResponse(Buffer.from([0x4f, 0x4b, 0x20, 0xff]))],
    ["BOM prefix", encodeResponse("\ufeffOK")],
    ["empty frame", Buffer.from([0, 0])],
    ["one-character frame", encodeResponse("O")],
    ["oversize length", Buffer.from([0x04, 0x01])],
    ["truncated body", Buffer.from([0, 3, 0x4f, 0x4b])],
    ["truncated header", Buffer.from([0])],
    ["extra data", Buffer.concat([encodeResponse("OK"), Buffer.from("extra")])],
    ["empty reply", Buffer.alloc(0)],
  ];
  for (const [name, frame] of cases) {
    await t.test(name, async (t) => {
      const socketPath = await daemon(t, (socket) => socket.end(frame));
      assert.equal(await authenticate("pi", "password", { socketPath }), false);
    });
  }
});

test("PAM client rejects trailing data arriving after a valid frame", async (t) => {
  const socketPath = await daemon(t, (socket) => {
    socket.write(encodeResponse("OK"));
    const timer = setTimeout(() => socket.end("extra"), 10);
    t.after(() => clearTimeout(timer));
  });
  assert.equal(await authenticate("pi", "password", { socketPath }), false);
});

test("PAM client fails closed when the daemon is missing or disconnects", async (t) => {
  const socketPath = await daemon(t, (socket) => socket.destroy());
  assert.equal(await authenticate("pi", "password", { socketPath }), false);
  assert.equal(await authenticate("pi", "password", { socketPath: `${socketPath}-missing` }), false);
});

test("PAM client deadline expires even while reply bytes keep arriving", async (t) => {
  const socketPath = await daemon(t, (socket) => {
    socket.write(Buffer.from([0x03, 0xff]));
    const interval = setInterval(() => socket.write("x"), 5);
    socket.once("close", () => clearInterval(interval));
    t.after(() => clearInterval(interval));
  });
  const started = performance.now();
  assert.equal(await authenticate("pi", "password", { socketPath, timeoutMs: 40 }), false);
  assert.ok(performance.now() - started < 1000);
});

test("PAM client requires the complete reply to end before its deadline", async (t) => {
  const socketPath = await daemon(t, (socket) => socket.write(encodeResponse("OK")));
  assert.equal(await authenticate("pi", "password", { socketPath, timeoutMs: 25 }), false);
});

test("PAM client rejects invalid inputs before contacting the daemon", async (t) => {
  let requests = 0;
  const socketPath = await daemon(t, (socket) => {
    requests += 1;
    socket.end(encodeResponse("OK"));
  });
  for (const username of ["", "root\0other", "pi\n", "../pi", "pi;id", "a".repeat(129), 123]) {
    assert.equal(await authenticate(username, "password", { socketPath }), false);
  }
  for (const password of ["", "pass\0word", "p".repeat(257), "é".repeat(129), undefined]) {
    assert.equal(await authenticate("pi", password, { socketPath }), false);
  }
  for (const timeoutMs of [0, -1, 10001, Infinity, NaN, 1.5, "100"]) {
    assert.equal(await authenticate("pi", "password", { socketPath, timeoutMs }), false);
  }
  assert.equal(requests, 0);
  assert.equal(await authenticate("pi", "é".repeat(128), { socketPath }), true);
});

test("PAM client bounds simultaneous requests and releases slots after failures", async (t) => {
  const socketPath = await daemon(t, () => {});
  const pending = Array.from({ length: 16 }, () => authenticate("pi", "password", { socketPath, timeoutMs: 50 }));
  assert.equal(await authenticate("pi", "password", { socketPath, timeoutMs: 1000 }), false);
  assert.deepEqual(await Promise.all(pending), Array(16).fill(false));
  const succeedingSocket = await daemon(t, (socket) => socket.end(encodeResponse("OK")));
  assert.equal(await authenticate("pi", "password", { socketPath: succeedingSocket }), true);
});

test("startup socket check rejects files and relative paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-pam-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mux");
  fs.writeFileSync(file, "not a socket");
  assert.throws(() => checkSocket(file));
  assert.throws(() => checkSocket("relative/mux"));
  assert.throws(() => checkSocket(path.join(directory, "missing")));
});

test("startup socket check accepts an actual socket and rejects a symlink", { skip: process.platform === "win32" }, async (t) => {
  const socketPath = await daemon(t, () => {});
  assert.equal(checkSocket(socketPath), true);
  const link = `${socketPath}-link`;
  fs.symlinkSync(socketPath, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.throws(() => checkSocket(link));
});
