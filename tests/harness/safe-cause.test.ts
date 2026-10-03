// The safe cause translator at the Harness Interface (#316, ADR 0041). Its known
// fields, bounds, and redaction are Interface facts M11's Detailed diagnostics rely
// on, so they are pinned here as literal numbers rather than read back from the
// implementation. A registered secret is seeded the one way production seeds one:
// by starting the real in-process permission bridge, which spawns no child.

import assert from "node:assert/strict";
import test from "node:test";
import {
  startPermissionBridge,
  translateCause,
  type SafeCause,
} from "../../src/harness/harness.js";

const MESSAGE_BOUND = 1024;
const STACK_BOUND = 4096;
const CAUSE_DEPTH = 4;
const TOTAL_BOUND = 16 * 1024;
const REDACTED = "«redacted-bearer-token»";

const bytes = (text: string) => new TextEncoder().encode(text).length;

const denyAll = async () => ({
  decision: "deny" as const,
  message: "unused",
});

/** The translated message of an Error naming `token`. */
const translatedMessage = (token: string) =>
  translateCause(new Error(`token ${token}`)).message;

/** Run `body` with a live bridge whose bearer is registered, closing it after. */
async function withBearer(
  body: (token: string) => void | Promise<void>,
): Promise<void> {
  const bridge = await startPermissionBridge(denyAll);
  try {
    await body(bridge.bearer);
  } finally {
    await bridge.close();
  }
}

/** The nested cause chain as a list, outermost first. */
function chain(record: SafeCause): SafeCause[] {
  const links: SafeCause[] = [];
  for (let link: SafeCause | undefined = record; link; link = link.cause) {
    links.push(link);
  }
  return links;
}

test("an Error's known fields are copied and its other fields are dropped", () => {
  const error = Object.assign(new TypeError("spawn failed"), {
    code: "ENOENT",
    errno: -2,
    syscall: "spawn claude",
    signal: "SIGTERM",
    spawnargs: ["--secret-argv"],
    env: { HOME: "/home/someone" },
  });
  const record = translateCause(error);

  assert.deepEqual(
    { ...record, stack: undefined },
    {
      type: "TypeError",
      message: "spawn failed",
      code: "ENOENT",
      errno: -2,
      syscall: "spawn claude",
      signal: "SIGTERM",
      stack: undefined,
    },
  );
  assert.equal(record.stack, error.stack);
  assert.equal(record.truncated, undefined);
  assert.equal(JSON.stringify(record).includes("--secret-argv"), false);
  assert.equal(JSON.stringify(record).includes("/home/someone"), false);
});

test("a numeric code is kept as text and ill-typed known fields are dropped", () => {
  const error = Object.assign(new Error("db"), {
    code: 19,
    errno: "not a number",
    syscall: { nested: true },
    signal: 9,
  });
  const record = translateCause(error);

  assert.equal(record.code, "19");
  assert.equal("errno" in record, false);
  assert.equal("syscall" in record, false);
  assert.equal("signal" in record, false);
});

test("a non-finite numeric code is dropped and an empty name falls back to Error", () => {
  const error = Object.assign(new Error("odd"), { code: Number.NaN });
  error.name = "";
  const record = translateCause(error);

  assert.equal(record.type, "Error");
  assert.equal("code" in record, false);
});

test("a throwing getter or a revoked Proxy never makes the translator throw", () => {
  const error = new Error("kept");
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("getter ran");
    },
  });
  const getter = translateCause(error);
  assert.equal(getter.message, "kept");
  assert.equal("code" in getter, false);

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.deepEqual(translateCause(revocable.proxy), { type: "object" });
});

test("a non-Error value reduces to its type label and nothing else", () => {
  assert.deepEqual(translateCause("a thrown prompt"), { type: "string" });
  assert.deepEqual(translateCause(42), { type: "number" });
  assert.deepEqual(translateCause(undefined), { type: "undefined" });
  assert.deepEqual(translateCause(null), { type: "null" });
  assert.deepEqual(translateCause(["argv"]), { type: "array" });
  // An error-shaped object is still an arbitrary object: never serialized.
  assert.deepEqual(
    translateCause({ message: "user text", stack: "at secret", code: "X" }),
    { type: "object" },
  );
});

test("a nested cause chain is translated and cut at its depth with the mark", () => {
  let error = new Error("cause 6");
  for (let index = 5; index >= 0; index -= 1) {
    error = new Error(`cause ${index}`, { cause: error });
  }
  const record = translateCause(error);
  const links = chain(record);

  assert.equal(links.length, 1 + CAUSE_DEPTH);
  assert.deepEqual(
    links.map((link) => link.message),
    ["cause 0", "cause 1", "cause 2", "cause 3", "cause 4"],
  );
  assert.equal(record.truncated, true);
  assert.equal(
    links.slice(1).some((link) => "truncated" in link),
    false,
    "only the top-level record carries the mark",
  );
});

test("a chain that ends exactly at the depth bound is not marked", () => {
  let error = new Error("cause 4");
  for (let index = 3; index >= 0; index -= 1) {
    error = new Error(`cause ${index}`, { cause: error });
  }
  const record = translateCause(error);

  assert.equal(chain(record).length, 1 + CAUSE_DEPTH);
  assert.equal(record.truncated, undefined);
});

test("a non-Error nested cause becomes its type label", () => {
  const record = translateCause(new Error("outer", { cause: { token: "x" } }));

  assert.deepEqual(record.cause, { type: "object" });
});

test("a cyclic cause ends at the depth bound and is marked", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  (first as { cause?: unknown }).cause = second;
  const record = translateCause(first);

  assert.equal(chain(record).length, 1 + CAUSE_DEPTH);
  assert.equal(record.truncated, true);
});

test("message and stack are cut to their bounds with the truncation mark", () => {
  const error = new Error("m".repeat(MESSAGE_BOUND + 10));
  error.stack = "s".repeat(STACK_BOUND + 10);
  const record = translateCause(error);

  assert.equal(record.message, "m".repeat(MESSAGE_BOUND));
  assert.equal(record.stack, "s".repeat(STACK_BOUND));
  assert.equal(record.truncated, true);
});

test("the string bound counts UTF-8 bytes and never splits a character", () => {
  // Each "é" is two bytes: 1023 bytes of "a" leave no room for a whole "é".
  const record = translateCause(new Error(`${"a".repeat(1023)}é`));

  assert.equal(record.message, "a".repeat(1023));
  assert.equal(record.truncated, true);
});

test("the string bound counts the bytes the string serializes to", () => {
  // Each backslash escapes to two bytes, each control character to six.
  const slashes = translateCause(new Error("\\".repeat(MESSAGE_BOUND)));
  const controls = translateCause(new Error("\u0001".repeat(MESSAGE_BOUND)));

  assert.equal(slashes.message, "\\".repeat(MESSAGE_BOUND / 2));
  assert.equal(
    controls.message,
    "\u0001".repeat(Math.floor(MESSAGE_BOUND / 6)),
  );
  assert.equal(slashes.truncated, true);
});

test("a lone record with every field at its escaped worst stays within the total", () => {
  const worst = "\u0001".repeat(STACK_BOUND);
  const error = Object.assign(new Error(worst), {
    code: worst,
    syscall: worst,
    signal: worst,
  });
  error.name = worst;
  error.stack = worst;
  const record = translateCause(error);

  assert.ok(bytes(JSON.stringify(record)) <= TOTAL_BOUND);
  assert.equal(record.stack?.length, Math.floor(STACK_BOUND / 6));
  assert.equal(record.message?.length, Math.floor(MESSAGE_BOUND / 6));
  assert.equal(record.truncated, true);
});

test("a string exactly at its bound is kept whole and unmarked", () => {
  const record = translateCause(new Error("m".repeat(MESSAGE_BOUND)));

  assert.equal(record.message, "m".repeat(MESSAGE_BOUND));
  assert.equal(record.truncated, undefined);
});

test("over the total bound the deepest causes go first and the top message survives", () => {
  const big = (label: string, cause?: Error) => {
    const error = new Error(`${label}:${"m".repeat(MESSAGE_BOUND)}`, { cause });
    error.stack = "s".repeat(STACK_BOUND);
    return error;
  };
  const record = translateCause(
    big("0", big("1", big("2", big("3", big("4"))))),
  );
  const links = chain(record);

  assert.ok(bytes(JSON.stringify(record)) <= TOTAL_BOUND);
  assert.equal(record.truncated, true);
  assert.ok(links.length < 1 + CAUSE_DEPTH, "deep causes were dropped");
  assert.ok(links.length >= 2, "the nearest cause survives the deepest");
  assert.deepEqual(
    links.map((link) => link.message?.slice(0, 2)),
    ["0:", "1:", "2:"].slice(0, links.length),
  );
  assert.equal(record.stack, "s".repeat(STACK_BOUND));
});

test("a registered secret is redacted in message, stack, and a nested cause", async () => {
  await withBearer((token) => {
    const inner = Object.assign(new Error(`inner Bearer ${token}`), {
      code: token,
      syscall: `spawn ${token}`,
    });
    const outer = new Error(`outer ${token}`, { cause: inner });
    outer.stack = `Error: outer\n    at launch (${token})`;
    const record = translateCause(outer);

    assert.equal(JSON.stringify(record).includes(token), false);
    assert.equal(record.message, `outer ${REDACTED}`);
    assert.equal(record.stack, `Error: outer\n    at launch (${REDACTED})`);
    assert.equal(record.cause?.message, `inner Bearer ${REDACTED}`);
    assert.equal(record.cause?.code, REDACTED);
    assert.equal(record.cause?.syscall, `spawn ${REDACTED}`);
  });
});

test("a secret split across a truncation boundary leaves no fragment", async () => {
  await withBearer((token) => {
    // The token starts 24 bytes before the message bound, so a cut before
    // redaction would keep its first 24 characters.
    const lead = "x".repeat(MESSAGE_BOUND - 24);
    const record = translateCause(new Error(`${lead}${token}`));

    assert.equal(record.truncated, true);
    assert.equal(record.message?.includes(token.slice(0, 24)), false);
    assert.equal(record.message?.startsWith(lead), true);
  });
});

test("a bearer stays redacted while its bridge is live and after it closes", async () => {
  const bridge = await startPermissionBridge(denyAll);
  try {
    assert.equal(translatedMessage(bridge.bearer), `token ${REDACTED}`);
  } finally {
    await bridge.close();
  }
  // Teardown stays idempotent and never evicts the bearer.
  await bridge.close();
  assert.equal(translatedMessage(bridge.bearer), `token ${REDACTED}`);
});

test("both bearers stay redacted after two bridges in one invocation close", async () => {
  const first = await startPermissionBridge(denyAll);
  const second = await startPermissionBridge(denyAll);
  await first.close();
  await second.close();

  assert.notEqual(first.bearer, second.bearer);
  assert.equal(translatedMessage(first.bearer), `token ${REDACTED}`);
  assert.equal(translatedMessage(second.bearer), `token ${REDACTED}`);
});
