"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Run the real browser script with controllable network responses and streams.
// The small DOM surface keeps these session-flow tests independent of browsers.
class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = new Map();
    this.attributes = new Map(); this.className = ""; this.textContent = "";
    this.disabled = false; this.hidden = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  hasAttribute(key) { return this.attributes.has(key); }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback({ currentTarget: this, target: this, ...event }); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelector(selector) {
    const matches = node => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) : node.tagName === selector;
    for (const child of this.children) { if (matches(child)) return child; const match = child.querySelector(selector); if (match) return match; }
    return null;
  }
  querySelectorAll() { return []; }
  focus() {}
}

function fixture() {
  const nodes = new Map(["app-main", "app-messages", "connection-status", "connection-label", "reconnect-button", "service-notice", "update-button", "logout-button"].map(id => [id, new Element()]));
  const document = new Element("document");
  const menu = new Element("details");
  document.getElementById = id => nodes.get(id);
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => Object.assign(new Element("text"), { textContent: text });
  document.querySelector = selector => selector === ".utility-menu" ? menu : null;
  const location = { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "" };
  const setLocation = href => { const url = new URL(href, location.href); Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search }); };
  const history = { pushState: (_state, _unused, href) => setLocation(href), replaceState: (_state, _unused, href) => setLocation(href) };
  const window = new Element("window");
  window.__DASHBOARD__ = { csrfToken: "test-token", snapshot: { jobs: [], worker: { online: true }, update: {} } };
  window.confirm = () => true; window.scrollTo = () => {};
  const streams = []; const requests = [];
  class EventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.listeners = new Map(); this.readyState = 1; this.closed = false; streams.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() { this.closed = true; this.readyState = EventSource.CLOSED; }
    emit(name, data = {}) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  }
  const fetch = (url, options) => new Promise(resolve => requests.push({ url, options,
    respond(data = { ok: true }, status = 200) { resolve({ status, ok: status >= 200 && status < 300, headers: { get: () => "application/json" }, json: async () => data }); } }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"), {
    window, document, location, history, Node: Element, URL, URLSearchParams, EventSource, fetch,
  }, { filename: "public/app.js" });
  const browse = href => {
    const anchor = new Element("a"); anchor.href = new URL(href, location.href).href;
    anchor.closest = selector => selector === "a[data-nav]" ? anchor : null;
    document.dispatch("click", { target: anchor, button: 0, preventDefault() {} });
  };
  return { nodes, streams, requests, browse, window, setLocation };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("live idle closes updates while retaining signed-in actions and ignores stale errors", () => {
  const f = fixture(); const stream = f.streams[0];
  stream.emit("live-idle");
  assert.equal(stream.closed, true);
  assert.equal(f.nodes.get("connection-label").textContent, "Live updates paused");
  assert.equal(f.nodes.get("reconnect-button").hidden, false);
  assert.equal(f.nodes.get("update-button").disabled, false);
  assert.equal(f.nodes.get("logout-button").disabled, false);
  stream.onerror();
  assert.equal(f.requests.length, 0);
  assert.equal(f.streams.length, 1);
});

test("browsing renews activity before reopening idle updates", async () => {
  const f = fixture(); f.streams[0].emit("live-idle");
  f.browse("/unavailable");
  assert.equal(f.requests[0].url, "/api/activity");
  assert.equal(f.requests[0].options.method, "POST");
  assert.equal(f.streams.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.streams.length, 2);
  assert.equal(f.streams[1].url, "/api/events");
  assert.equal(f.nodes.get("connection-label").textContent, "Connecting");
  f.streams[1].onopen();
  assert.equal(f.nodes.get("connection-label").textContent, "Connected");
});

test("Back/Forward browsing also renews activity before reopening updates", async () => {
  const f = fixture(); f.streams[0].emit("live-idle");
  f.setLocation("/unavailable"); f.window.dispatch("popstate");
  assert.equal(f.requests[0].url, "/api/activity");
  assert.equal(f.streams.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.streams.length, 2);
});

test("explicit Reconnect renews activity before opening a stream", async () => {
  const f = fixture(); f.streams[0].emit("live-idle");
  f.nodes.get("reconnect-button").dispatch("click");
  assert.equal(f.requests[0].url, "/api/activity");
  assert.equal(f.streams.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.streams.length, 2);
  assert.equal(f.nodes.get("reconnect-button").disabled, false);
});

test("successful user actions resume idle updates without an automatic activity loop", async () => {
  const f = fixture(); f.streams[0].emit("live-idle");
  f.nodes.get("update-button").dispatch("click");
  assert.equal(f.requests[0].url, "/update");
  assert.equal(f.streams.length, 1);
  f.requests[0].respond(); await settle();
  assert.equal(f.streams.length, 2);
  assert.equal(f.requests.length, 1);
});

test("out-of-order navigation responses and events cannot replace the current stream", async () => {
  const f = fixture(); const old = f.streams[0];
  f.browse("/first"); f.browse("/second");
  f.requests[1].respond(); await settle();
  assert.equal(f.streams.length, 2);
  const current = f.streams[1]; current.onopen();
  f.requests[0].respond(); await settle();
  old.emit("live-idle"); old.emit("auth-expired"); old.onerror();
  assert.equal(f.streams.length, 2);
  assert.equal(current.closed, false);
  assert.equal(f.nodes.get("connection-label").textContent, "Connected");
});

test("background reads leave idle updates paused", async () => {
  const f = fixture(); f.streams[0].emit("live-idle");
  const crontab = f.nodes.get("app-main").querySelector("details");
  crontab.open = true; crontab.dispatch("toggle");
  assert.equal(f.requests[0].url, "/api/crontab");
  f.requests[0].respond({ text: "" }); await settle();
  assert.equal(f.streams.length, 1);
  assert.equal(f.nodes.get("connection-label").textContent, "Live updates paused");
});

test("failed activity renewal keeps updates stopped and offers an explicit retry", async () => {
  const f = fixture();
  f.browse("/unavailable");
  f.requests[0].respond({ error: "Temporarily unavailable" }, 503); await settle();
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.nodes.get("connection-label").textContent, "Disconnected");
  assert.equal(f.nodes.get("reconnect-button").hidden, false);
  assert.equal(f.nodes.get("logout-button").disabled, false);
});

test("actual authentication expiry still requires sign-in", () => {
  const f = fixture(); f.streams[0].emit("auth-expired");
  assert.equal(f.nodes.get("connection-label").textContent, "Session expired");
  assert.equal(f.nodes.get("reconnect-button").hidden, true);
  assert.equal(f.nodes.get("update-button").disabled, true);
  assert.equal(f.nodes.get("logout-button").disabled, true);
});
