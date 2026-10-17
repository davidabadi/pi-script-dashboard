"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const test = require("node:test");
const express = require("express");

// Resolve the same copy Express uses, including if npm nests its dependency.
const proxyaddr = createRequire(require.resolve("express"))("proxy-addr");
const app = express();
app.set("trust proxy", "loopback");

function requestFrom(remoteAddress, forwardedFor) {
  const request = Object.create(app.request);
  request.socket = { remoteAddress };
  request.headers = { "x-forwarded-for": forwardedFor };
  return request;
}

test("Express trusts only loopback proxy addresses", () => {
  const trust = app.get("trust proxy fn");
  for (const address of ["127.0.0.1", "127.0.0.42", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(trust(address, 0), true, address);
  }
  for (const address of ["203.0.113.11", "::ffff:203.0.113.11", "2001:db8::1", "10.0.0.1"]) {
    assert.equal(trust(address, 0), false, address);
  }
});

test("Express stops forwarded IP chains at the closest untrusted hop", () => {
  for (const loopback of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    // The farther claimed client must not bypass the untrusted public proxy.
    const request = requestFrom(loopback, "198.51.100.42, 203.0.113.11");
    assert.equal(request.ip, "203.0.113.11", loopback);
    assert.deepEqual(request.ips, ["203.0.113.11"], loopback);
  }
});

test("Express ignores forwarded client claims from an untrusted direct peer", () => {
  const request = requestFrom("203.0.113.11", "198.51.100.42");
  assert.equal(request.ip, "203.0.113.11");
  assert.deepEqual(request.ips, []);
});

test("IPv4-mapped trust prefixes cannot accidentally trust every IPv4 peer", () => {
  // GHSA-jqcg-44mw-7w3h: /8 does not cover the IPv4-mapped marker.
  const trust = proxyaddr.compile("::ffff:10.0.0.0/8");
  assert.equal(trust("203.0.113.11"), false);
});
