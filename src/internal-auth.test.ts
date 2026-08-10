import { strict as assert } from "node:assert";
import test from "node:test";
import { decideInternalAuth, secretsMatch } from "./internal-auth.js";

const SECRET = "s3cret-value";
const VALID = `Bearer ${SECRET}`;

test("fails CLOSED when no secret is configured", () => {
  // The original bug: an empty secret skipped the check and every internal
  // endpoint became public. It must deny instead, and with 503 rather than 401
  // because no credential the caller could present would help.
  for (const header of [undefined, "", VALID, "Bearer anything"]) {
    const d = decideInternalAuth(header, "");
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.status, 503);
  }
});

test("rejects missing, malformed, and wrong credentials with 401", () => {
  for (const header of [
    undefined,
    "",
    SECRET, // raw secret without the Bearer scheme
    "Bearer ",
    "Bearer wrong",
    `Basic ${SECRET}`,
    `bearer ${SECRET}`, // scheme is case-sensitive here by design
    `Bearer ${SECRET} `, // trailing whitespace must not pass
    `Bearer ${SECRET}x`, // prefix of a valid credential must not pass
  ]) {
    const d = decideInternalAuth(header, SECRET);
    assert.equal(d.ok, false, `should reject: ${JSON.stringify(header)}`);
    assert.equal(d.ok === false && d.status, 401);
  }
});

test("accepts the exact credential", () => {
  assert.equal(decideInternalAuth(VALID, SECRET).ok, true);
});

test("secretsMatch is total and does not throw on length mismatch", () => {
  // Hashing before comparing is what makes this safe; a raw timingSafeEqual
  // would throw on differing lengths and leak the expected length.
  assert.equal(secretsMatch("", "x"), false);
  assert.equal(secretsMatch("short", "a much longer secret value"), false);
  assert.equal(secretsMatch("same", "same"), true);
});
