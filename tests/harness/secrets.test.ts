// Secret redaction is private to Harness, so drive its failure causes through
// the Claude Code Adapter with the scripted Process. The real in-process bridge
// registers a bearer without a child; Check's semantic Test step runs these
// cases on Windows x64, macOS arm64, and Linux x64 (#332).

import assert from "node:assert/strict";
import test from "node:test";
import {
  createClaudeCodeAdapter,
  startPermissionBridge,
  translateCause,
} from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

const REDACTED = "«redacted-bearer-token»";

async function launchFailure(cause: unknown): Promise<unknown> {
  const process = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commands: [
      {
        trigger: "immediate",
        result: {
          kind: "exited",
          status: 0,
          text: new TextEncoder().encode("2.1.234 (Claude Code)"),
        },
      },
    ],
    ownedProcesses: [
      {
        kind: "launch-failure",
        failure: { ok: false, failure: { kind: "spawn-error", cause } },
      },
    ],
  });
  const prepared = await createClaudeCodeAdapter({ env: {} }).prepare({
    workspace: makeTempDir("secant-secret-ws-"),
    process,
  });
  assert.ok(prepared.ok);
  try {
    const turn = prepared.harness.startTurn({
      session: "s",
      origin: "managed",
      correlationKey: { opaque: "failure" },
      input: { text: "unused" },
      recorder: {
        admit: () => Promise.resolve({ recorded: true }),
        checkpoint: () => Promise.resolve({ recorded: true }),
      },
    });
    const result = await turn.result();
    assert.equal(result.kind, "not-started");
    if (result.kind !== "not-started") throw new Error("unreachable");
    assert.equal(result.detail.failure.category, "spawn-error");
    return result.detail.failure.cause;
  } finally {
    await prepared.harness.close();
  }
}

async function withBearer(
  body: (token: string) => Promise<void>,
): Promise<void> {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  try {
    await body(bridge.session("test").bearer);
  } finally {
    await bridge.close();
  }
}

test("a Claude Code failure keeps its type and nested cause while redacting every link", async () => {
  await withBearer(async (token) => {
    const inner = Object.assign(new RangeError(`inner ${token}`), {
      code: token,
      syscall: `spawn ${token}`,
    });
    inner.stack = `RangeError: inner ${token}`;
    const outer = new TypeError(`outer ${token}`, { cause: inner });
    outer.stack = `TypeError: outer ${token}`;
    const cause = await launchFailure(outer);
    assert.ok(cause instanceof Error);
    assert.notEqual(cause, outer);
    assert.equal(cause.name, "TypeError");
    assert.equal(cause.message, `outer ${REDACTED}`);
    assert.equal(cause.stack, `TypeError: outer ${REDACTED}`);
    assert.ok(cause.cause instanceof Error);
    assert.equal(cause.cause.name, "RangeError");
    assert.equal(cause.cause.message, `inner ${REDACTED}`);
    assert.deepEqual(translateCause(cause), {
      type: "TypeError",
      message: `outer ${REDACTED}`,
      stack: `TypeError: outer ${REDACTED}`,
      cause: {
        type: "RangeError",
        message: `inner ${REDACTED}`,
        code: REDACTED,
        syscall: `spawn ${REDACTED}`,
        stack: `RangeError: inner ${REDACTED}`,
      },
    });
    assert.equal(JSON.stringify(cause).includes(token), false);
    assert.equal(outer.cause, inner);
    assert.equal(outer.message, `outer ${token}`);
    assert.equal(inner.message, `inner ${token}`);
  });
});

test("secret-free causes cross the Claude Code Seam unchanged with a live secret registered", async () => {
  await withBearer(async () => {
    const inner = new RangeError("inner");
    let outer: Error = new TypeError("outer", { cause: inner });
    // Even a chain longer than the translation bound is unchanged when clean.
    for (let index = 0; index < 6; index += 1) {
      outer = new Error("wrapper", { cause: outer });
    }
    Object.assign(outer, { spawnargs: ["--version", 42] });
    assert.equal(await launchFailure(outer), outer);
    const array = ["safe", 42];
    const object = { message: "opaque" };
    for (const value of [array, object, "safe", 42, null, undefined]) {
      assert.equal(await launchFailure(value), value);
    }
  });
});

test("native launch fields and Error names are scrubbed even when non-enumerable", async () => {
  await withBearer(async (token) => {
    const error = new Error("safe message");
    const safeArgs = ["--version", 42];
    const spawnargs = ["--mcp-config", `Bearer ${token}`, 42];
    Object.defineProperties(error, {
      name: { value: `NativeError ${token}` },
      spawnargs: { value: spawnargs },
      cmd: { value: `claude ${token}` },
      path: { value: `path ${token}` },
      syscall: { value: `spawn ${token}` },
    });
    Object.assign(error, { safeArgs, code: "EACCES", errno: -13 });
    const cause = await launchFailure(error);
    assert.ok(cause instanceof Error);
    const fields = cause as unknown as Record<string, unknown>;
    assert.equal(cause.name, `NativeError ${REDACTED}`);
    assert.equal(cause.message, "safe message");
    assert.equal(cause.stack, error.stack?.replaceAll(token, REDACTED));
    assert.deepEqual(fields.spawnargs, [
      "--mcp-config",
      `Bearer ${REDACTED}`,
      42,
    ]);
    assert.equal(fields.cmd, `claude ${REDACTED}`);
    assert.equal(fields.path, `path ${REDACTED}`);
    assert.equal(fields.syscall, `spawn ${REDACTED}`);
    assert.equal(fields.code, "EACCES");
    assert.equal(fields.errno, -13);
    assert.equal(fields.safeArgs, safeArgs);
    assert.equal(spawnargs[1], `Bearer ${token}`);
  });
});

test("redacted cause chains keep exactly the translator's depth and mark a deeper cut", async () => {
  await withBearer(async (token) => {
    const beyond = new Error(`beyond ${token}`);
    beyond.stack = "beyond";
    const deepest = new RangeError(`deepest ${token}`);
    deepest.stack = "deepest";
    const wrap = (cause: Error) => {
      const error = new TypeError("wrapper", { cause });
      error.stack = "wrapper";
      return error;
    };
    const atBound = wrap(wrap(wrap(wrap(deepest))));
    const exact = translateCause(await launchFailure(atBound));
    assert.equal(exact.truncated, undefined);
    assert.equal(exact.cause?.cause?.cause?.cause?.type, "RangeError");
    assert.equal(
      exact.cause?.cause?.cause?.cause?.message,
      `deepest ${REDACTED}`,
    );

    deepest.cause = beyond;
    const redacted = await launchFailure(atBound);
    const record = translateCause(redacted);
    assert.equal(record.truncated, true);
    assert.equal(
      record.cause?.cause?.cause?.cause?.message,
      `deepest ${REDACTED}`,
    );
    assert.equal(record.cause?.cause?.cause?.cause?.cause, undefined);
    assert.equal(JSON.stringify(redacted).includes(token), false);
    assert.equal(deepest.cause, beyond);
  });
});

test("a cyclic Claude Code cause is bounded, redacted, and never mutates the source", async () => {
  await withBearer(async (token) => {
    const first = new TypeError(`first ${token}`);
    const second = new RangeError("second", { cause: first });
    first.cause = second;
    first.stack = "first";
    second.stack = "second";
    const redacted = await launchFailure(first);
    const record = translateCause(redacted);
    assert.equal(record.type, "TypeError");
    assert.equal(record.cause?.type, "RangeError");
    assert.equal(record.cause?.cause?.cause?.cause?.type, "TypeError");
    assert.equal(record.cause?.cause?.cause?.cause?.cause, undefined);
    assert.equal(record.truncated, true);
    assert.equal(JSON.stringify(redacted).includes(token), false);
    assert.equal(first.cause, second);
    assert.equal(second.cause, first);
  });
});

test("a string or argv array cause redacts only its registered secret", async () => {
  await withBearer(async (token) => {
    assert.equal(await launchFailure(`Bearer ${token}`), `Bearer ${REDACTED}`);
    const argv = ["--mcp-config", `Bearer ${token}`, 42];
    assert.deepEqual(await launchFailure(argv), [
      "--mcp-config",
      `Bearer ${REDACTED}`,
      42,
    ]);
    assert.equal(argv[1], `Bearer ${token}`);
    const error = new TypeError("outer", { cause: `Bearer ${token}` });
    const cause = await launchFailure(error);
    assert.ok(cause instanceof Error);
    assert.equal(cause.name, "TypeError");
    assert.equal(cause.cause, `Bearer ${REDACTED}`);
  });
});
