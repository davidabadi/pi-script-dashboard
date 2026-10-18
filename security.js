"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = createCsrfToken();
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function requireCsrf(req, res, next) {
  const supplied = req.get("x-csrf-token") || (req.body && req.body._csrf);
  if (!timingSafeEqualText(supplied, req.session && req.session.csrfToken)) {
    return res.status(403).send("Request verification failed.");
  }
  next();
}

function requireSameOrigin(trustedHosts) {
  const allowed = new Set(trustedHosts.map((host) => host.toLowerCase()));
  return (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const host = String(req.get("host") || "").toLowerCase();
    if (allowed.size && !allowed.has(host)) return res.status(403).send("Untrusted host.");
    const origin = req.get("origin");
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { return res.status(403).send("Invalid origin."); }
      if (originHost !== host) return res.status(403).send("Cross-origin request rejected.");
    }
    next();
  };
}

function createRateLimiter({ windowMs, limit, key }) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = key(req);
    const recent = (attempts.get(id) || []).filter((time) => time > now - windowMs);
    if (recent.length >= limit) {
      res.set("Retry-After", String(Math.ceil((recent[0] + windowMs - now) / 1000)));
      return res.status(429).send("Too many attempts. Try again later.");
    }
    recent.push(now);
    attempts.set(id, recent);
    if (attempts.size > 1000) {
      for (const [entryKey, values] of attempts) {
        if (!values.some((time) => time > now - windowMs)) attempts.delete(entryKey);
      }
    }
    next();
  };
}

function validateName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(name)) {
    throw new Error("Name must be 1-80 safe characters.");
  }
  return name;
}

const CRON_MACROS = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly", "@reboot"]);
function validateCron(value) {
  const cron = String(value || "").trim();
  if (cron.includes("\n") || cron.includes("\r") || cron.length > 120) throw new Error("Invalid schedule.");
  if (CRON_MACROS.has(cron)) return cron;
  const fields = cron.split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*,/\-]+$/.test(field))) {
    throw new Error("Schedule must be a five-field cron expression or supported macro.");
  }
  return cron;
}

function validateManagedPath(value, root, extensions = []) {
  const raw = String(value || "").trim();
  if (!raw || /[\0\r\n]/.test(raw)) throw new Error("A valid path is required.");
  const rootPath = path.resolve(root);
  const resolved = path.resolve(raw);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path must remain under ${rootPath}.`);
  if (extensions.length && !extensions.includes(path.extname(resolved).toLowerCase())) {
    throw new Error(`Path must use one of: ${extensions.join(", ")}.`);
  }
  let cursor = resolved;
  while (cursor !== rootPath && cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
    cursor = path.dirname(cursor);
  }
  return resolved;
}

function stableJobId(name) {
  return crypto.createHash("sha256").update(name).digest("hex").slice(0, 16);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(18).toString("base64");
  res.locals.cspNonce = nonce;
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // no-referrer makes native form POSTs send Origin: null, which we reject.
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.removeHeader("X-Powered-By");
  next();
}

module.exports = {
  createRateLimiter,
  csrfMiddleware,
  requireCsrf,
  requireSameOrigin,
  safeJson,
  securityHeaders,
  shellQuote,
  stableJobId,
  timingSafeEqualText,
  validateCron,
  validateManagedPath,
  validateName,
};
