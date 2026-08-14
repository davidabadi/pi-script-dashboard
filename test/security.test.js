"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  safeJson,
  shellQuote,
  stableJobId,
  timingSafeEqualText,
  validateCron,
  validateManagedPath,
  validateName,
} = require("../security");

test("safeJson prevents script-tag breakout", () => {
  const output = safeJson("</script><script>alert(1)</script>&\u2028");
  assert.equal(output.includes("</script>"), false);
  assert.match(output, /\\u003c\/script\\u003e/);
  assert.match(output, /\\u0026/);
});

test("constant-time text comparison accepts only exact tokens", () => {
  assert.equal(timingSafeEqualText("token", "token"), true);
  assert.equal(timingSafeEqualText("token", "other"), false);
  assert.equal(timingSafeEqualText("token", "token-longer"), false);
});

test("names reject control characters and shell syntax", () => {
  assert.equal(validateName("Nightly Backup"), "Nightly Backup");
  for (const value of ["", "../job", "job\nnext", "job; reboot", "$(id)"]) {
    assert.throws(() => validateName(value));
  }
});

test("cron validation rejects extra commands and malformed schedules", () => {
  assert.equal(validateCron("0 2 * * *"), "0 2 * * *");
  assert.equal(validateCron("@daily"), "@daily");
  for (const value of ["* * * * * root reboot", "* * * * *\n@reboot bad", "@unknown", "0 0 * JAN *"]) {
    assert.throws(() => validateCron(value));
  }
});

test("managed paths stay under their root and reject symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  assert.equal(validateManagedPath(path.join(scripts, "backup.sh"), scripts, [".sh"]), path.join(scripts, "backup.sh"));
  assert.throws(() => validateManagedPath(path.join(root, "outside.sh"), scripts, [".sh"]));
  assert.throws(() => validateManagedPath(path.join(scripts, "backup.txt"), scripts, [".sh"]));
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  const link = path.join(scripts, "linked");
  try {
    fs.symlinkSync(target, link, "dir");
    assert.throws(() => validateManagedPath(path.join(link, "backup.sh"), scripts, [".sh"]));
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
});

test("cron identifiers are stable and shell arguments are quoted", () => {
  assert.equal(stableJobId("Backup"), stableJobId("Backup"));
  assert.notEqual(stableJobId("Backup"), stableJobId("Other"));
  assert.equal(shellQuote("it's safe"), "'it'\"'\"'s safe'");
});
