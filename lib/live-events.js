"use strict";

const { subscribeChanges: defaultSubscribe } = require("./change-channel");
const { readRunLog } = require("./run-logs");
const { SESSION_IDLE_MS, LIVE_IDLE_MS } = require("./session-policy");

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const LOG_PAGE_BYTES = 64 * 1024;
const LIVE_IDLE_MESSAGE = "Live updates paused after 30 minutes without navigation or actions.";

function readSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.sessionID || !req.sessionStore?.get) return resolve(null);
    req.sessionStore.get(req.sessionID, (error, value) => error ? reject(error) : resolve(value));
  });
}

function sessionDeadlines(value, now) {
  // Tests and alternative authenticated transports can supply a boolean check.
  if (value === true) return { auth: Infinity, live: Infinity };
  if (!value || !value.logged_in || !Number.isFinite(value.absoluteExpiresAt) || !Number.isFinite(value.lastActivityAt)) return null;
  const auth = Math.min(value.absoluteExpiresAt, value.lastActivityAt + SESSION_IDLE_MS);
  return auth > now ? { auth, live: value.lastActivityAt + LIVE_IDLE_MS } : null;
}

function queryIdentifier(query, key) {
  const value = query[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

/**
 * One authenticated server-sent event stream per browser view. A subscription
 * wakes the stream only after a state/log change; timers check authentication,
 * worker liveness and transport health, never refresh job history or logs.
 *
 * getSnapshot() supplies the public dashboard state, publicRun() removes private
 * run credentials. Parent middleware must authenticate the initial request.
 * Call closeSession(sessionID) on logout and close() when the server shuts down.
 */
function createLiveEvents({ store, config, getSnapshot, publicRun,
  subscribeChanges = defaultSubscribe, checkSession = readSession, readLog = readRunLog,
  authIntervalMs = 15000, keepaliveMs = 20000, slowClientMs = 30000,
  workerStaleMs = 10000, maxConnectionsPerSession = 4, maxConnections = 128,
  maxFrameBytes = 1024 * 1024 } = {}) {
  if (!store || !config || typeof getSnapshot !== "function" || typeof publicRun !== "function") {
    throw new TypeError("Live events require a store, configuration and public snapshot functions.");
  }
  const connections = new Set();
  let stopped = false;

  const handler = async (req, res, next) => {
    const jsonError = (status, error) => res.status(status).json({ error });
    if (stopped) return jsonError(503, "Live updates are restarting. Reconnect shortly.");
    const origin = req.get("origin");
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) ||
          (["http", "https"].includes(req.protocol) && parsed.protocol !== `${req.protocol}:`) ||
          parsed.host.toLowerCase() !== String(req.get("host") || "").toLowerCase()) {
          return jsonError(403, "Cross-origin event streams are rejected.");
        }
      } catch { return jsonError(403, "Invalid event stream origin."); }
    }
    if (req.get("sec-fetch-site") === "cross-site") return jsonError(403, "Cross-origin event streams are rejected.");

    let jobId, runId, cursor;
    try {
      jobId = queryIdentifier(req.query, "jobId");
      runId = queryIdentifier(req.query, "runId");
      const offset = req.query.offset;
      if (offset !== undefined && (typeof offset !== "string" || !/^\d+$/.test(offset))) throw new Error("Invalid log cursor.");
      cursor = offset === undefined ? 0 : Number(offset);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid log cursor.");
      const lastId = req.get("last-event-id");
      if (lastId && (typeof lastId !== "string" || lastId.length > 512)) throw new Error("Invalid event cursor.");
      const resumed = lastId && /^log:([A-Za-z0-9_-]{1,128}):(\d+)$/.exec(lastId);
      if (resumed && resumed[1] === runId && Number.isSafeInteger(Number(resumed[2]))) cursor = Number(resumed[2]);
      const job = jobId && store.getJob(jobId);
      if (jobId && !job) return jsonError(404, "Job not found.");
      const run = runId && store.getRun(runId);
      // A retained job can outlive its selected run. Keep the stream available
      // so EventSource can deliver history plus an explicit expiry notice;
      // HTTP 404 alone hides the reason and triggers indefinite reconnects.
      if (runId && ((!run && !jobId) || (run && jobId && run.job_id !== jobId))) return jsonError(404, "Run not found or history expired.");
      if (!jobId && run) jobId = run.job_id;
    } catch (error) {
      if (/^Invalid /.test(error.message)) return jsonError(400, error.message);
      return next ? next(error) : jsonError(500, "Live updates are temporarily unavailable.");
    }

    let deadlines;
    try { deadlines = sessionDeadlines(await checkSession(req), Date.now()); }
    catch { deadlines = null; }
    if (!deadlines) return jsonError(401, "Session expired. Sign in again.");
    if (stopped) return jsonError(503, "Live updates are restarting. Reconnect shortly.");
    function startStream() {
      // Never let ending an SSE response renew its original session snapshot.
      req.session = null;
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
      res.flushHeaders?.();
    }
    if (deadlines.live <= Date.now()) {
      startStream();
      return res.end(`event: live-idle\ndata: ${JSON.stringify({ message: LIVE_IDLE_MESSAGE })}\n\n`);
    }
    if (connections.size >= maxConnections || [...connections].filter((item) => item.sessionID === req.sessionID).length >= maxConnectionsPerSession) {
      res.set("Retry-After", "5");
      return jsonError(429, "Too many live views. Close another dashboard tab and reconnect.");
    }

    let closed = false, blocked = false, pumping = false, scheduled;
    let unsubscribe, authTimer, keepaliveTimer, workerTimer, slowTimer, drainCancel;
    let needSnapshot = true, needHistory = Boolean(jobId), needLog = Boolean(runId);
    let previousSnapshot, previousHistory, previousLog, previousPresence;
    const connection = { sessionID: req.sessionID, close, expire, change };

    function close(destroy = false) {
      if (closed) return;
      // A shutdown must not wait forever for a client that already stopped
      // draining its socket after its slow-client timer has been cleared.
      destroy ||= blocked;
      closed = true;
      connections.delete(connection);
      if (scheduled) clearImmediate(scheduled);
      clearTimeout(authTimer);
      clearTimeout(workerTimer);
      clearTimeout(slowTimer);
      clearInterval(keepaliveTimer);
      if (unsubscribe) unsubscribe();
      if (drainCancel) drainCancel();
      req.off("aborted", abort);
      res.off("close", abort);
      res.off("error", abort);
      if (destroy) res.destroy();
      else if (!res.writableEnded && !res.destroyed) res.end();
    }
    function abort() { close(true); }
    function expire() {
      if (closed) return;
      if (!blocked && !res.destroyed) res.write(`event: auth-expired\ndata: ${JSON.stringify({ error: "Session expired. Sign in again." })}\n\n`);
      close(blocked);
    }
    function pause() {
      if (closed) return;
      if (!blocked && !res.destroyed) res.write(`event: live-idle\ndata: ${JSON.stringify({ message: LIVE_IDLE_MESSAGE })}\n\n`);
      close(blocked);
    }
    async function authenticate() {
      let value;
      try { value = await checkSession(req); }
      catch { value = null; }
      if (closed) return false;
      deadlines = sessionDeadlines(value, Date.now());
      if (!deadlines) { expire(); return false; }
      if (deadlines.live <= Date.now()) { pause(); return false; }
      clearTimeout(authTimer);
      authTimer = setTimeout(() => { authenticate().catch(abort); }, Math.max(1, Math.min(authIntervalMs, 15000, deadlines.auth - Date.now(), deadlines.live - Date.now())));
      authTimer.unref?.();
      return true;
    }
    function armPresence(heartbeat) {
      clearTimeout(workerTimer);
      const remaining = heartbeat + workerStaleMs - Date.now();
      if (Number.isFinite(remaining) && remaining >= 0) {
        workerTimer = setTimeout(() => {
          if (closed) return;
          try {
            const latest = Date.parse(store.getSetting("worker_heartbeat") || "");
            const online = Date.now() - latest < workerStaleMs;
            if (online !== previousPresence) {
              previousPresence = online;
              needSnapshot = true;
              schedule();
            } else armPresence(latest);
          } catch { close(true); }
        }, Math.max(1, remaining + 1));
        workerTimer.unref?.();
      }
    }
    function schedulePresence(snapshot) {
      const heartbeat = Date.parse(store.getSetting("worker_heartbeat") || "");
      previousPresence = snapshot.worker?.online ?? (Date.now() - heartbeat < workerStaleMs);
      armPresence(heartbeat);
    }
    function change(event) {
      if (closed) return;
      if (event.type === "error") return close(true);
      if (event.type === "state") {
        needSnapshot = true;
        needHistory = Boolean(jobId);
        needLog = Boolean(runId);
      } else if (event.type === "log" && runId && (!event.runId || event.runId === runId)) needLog = true;
      else return;
      schedule();
    }
    function schedule() {
      if (closed || pumping || scheduled) return;
      scheduled = setImmediate(() => { scheduled = undefined; pump().catch(() => close(true)); });
    }
    async function frame(event, value, id) {
      if (closed) return false;
      const data = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
      if (Buffer.byteLength(data) > maxFrameBytes) { close(true); return false; }
      if (res.write(data)) return true;
      blocked = true;
      // There is no application queue: one bounded frame waits for the socket,
      // while subsequent change notifications collapse into boolean flags.
      const ready = await new Promise((resolve) => {
        const drain = () => finish(true);
        const finish = (result) => {
          clearTimeout(slowTimer);
          res.off("drain", drain);
          drainCancel = undefined;
          resolve(result);
        };
        drainCancel = () => finish(false);
        res.once("drain", drain);
        slowTimer = setTimeout(() => { finish(false); close(true); }, slowClientMs);
        slowTimer.unref?.();
      });
      blocked = false;
      return ready && !closed;
    }
    async function pump() {
      if (closed || pumping) return;
      pumping = true;
      try {
        while (!closed && (needSnapshot || needHistory || needLog)) {
          if (!(await authenticate())) return;
          if (needSnapshot) {
            needSnapshot = false;
            const snapshot = getSnapshot();
            const signature = JSON.stringify(snapshot);
            if (signature !== previousSnapshot) {
              if (!(await frame("snapshot", snapshot))) return;
              previousSnapshot = signature;
            }
            schedulePresence(snapshot);
          }
          if (closed) return;
          if (needHistory) {
            needHistory = false;
            const history = { jobId, runs: store.listRuns(jobId, { limit: 50 }).map(publicRun) };
            const signature = JSON.stringify(history);
            if (signature !== previousHistory) {
              if (!(await frame("history", history))) return;
              previousHistory = signature;
            }
          }
          if (closed) return;
          if (needLog) {
            needLog = false;
            const run = store.getRun(runId);
            const page = run && run.job_id === jobId
              ? { ...readLog(config, run, { offset: cursor, limit: LOG_PAGE_BYTES }), runId, run: publicRun(run) }
              : { runId, text: "", offset: cursor, nextOffset: cursor, complete: true, expired: true, truncated: false, captureGap: false, run: null };
            const signature = JSON.stringify(page);
            if (signature !== previousLog) {
              if (!(await frame("log", page, `log:${runId}:${page.nextOffset}`))) return;
              previousLog = signature;
            }
            // Read another bounded page only when this one advanced the byte
            // cursor. An empty page ends the batch until the next real change.
            if (page.nextOffset > cursor && page.text) needLog = true;
            cursor = page.nextOffset;
            if (needLog) await new Promise((resolve) => setImmediate(resolve));
          }
        }
      } finally {
        pumping = false;
        if (!closed && (needSnapshot || needHistory || needLog)) schedule();
      }
    }

    try {
      connections.add(connection);
      req.once("aborted", abort);
      res.once("close", abort);
      res.once("error", abort);
      // Subscribe before taking the initial snapshot, so no committed change can
      // fall between a read and registration of its notification listener.
      unsubscribe = subscribeChanges(config, change);
      // express-session otherwise saves/touches its original request snapshot
      // when this long-lived response eventually ends. That can renew an idle
      // cookie or race a logout in another request and resurrect stale data.
      // Authentication below reads the current store through the captured ID.
      startStream();
      keepaliveTimer = setInterval(() => {
        if (!closed && !blocked && !res.destroyed) {
          // Keepalive comments carry no state and never cause database/log reads.
          if (!res.write(": keepalive\n\n")) close(true);
        }
      }, keepaliveMs);
      keepaliveTimer.unref?.();
      await pump();
    } catch (error) {
      if (res.headersSent) close(true);
      else {
        // Clean up without ending the response before Express can report a
        // subscription failure as an ordinary request error.
        connections.delete(connection);
        req.off("aborted", abort);
        res.off("close", abort);
        res.off("error", abort);
        unsubscribe?.();
        closed = true;
        if (next) next(error);
        else jsonError(503, "Live updates are temporarily unavailable.");
      }
    }
  };

  return {
    handler,
    closeSession(sessionID) { for (const connection of [...connections]) if (connection.sessionID === sessionID) connection.expire(); },
    close() { stopped = true; for (const connection of [...connections]) connection.close(); },
  };
}

module.exports = { createLiveEvents };
