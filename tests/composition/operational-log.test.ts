import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  describeFatal,
  launchTui,
  withClients,
} from "../../src/composition/main.js";
import { runHeadless, runHeadlessCli } from "../../src/headless/headless.js";
import type { HarnessProfile } from "../../src/harness/harness.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  assertBase,
  home,
  io,
  readLog,
  steppingClock,
  WALL,
  type Home,
} from "./log-sink.js";

// The operational log (#318) through both client entries, read back from the
// JSONL each Secant invocation writes. Every test reaches the sink through the
// wiring overrides' log-sink Seam (folder, clock, fallback channel) and never
// sets SECANT_LOG_DIR; the compiled-binary smoke owns the environment names.
// The Process double has no script and the Harness doubles refuse to prepare, so
// any spawn or Harness launch would throw.

test("a headless Secant invocation writes its start and end records to one private JSONL file", async () => {
  const { folder, overrides, notices } = home();
  const out = io();
  const status = await withClients(
    (clients) => runHeadless(clients, ["workspace", "--json"], out.io),
    overrides,
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assert.equal(log.name, `2026-10-02T09-08-07-006Z-${process.pid}.jsonl`);
  assertBase(log.records);
  const [start, end] = log.records;
  assert.equal(log.records.length, 2);
  assert.deepEqual(start, {
    level: "info",
    time: WALL.toISOString(),
    invocationId: start!.invocationId,
    event: "invocation-start",
    client: "headless",
    version: "9.8.7",
    platform: "linux",
    pid: process.pid,
  });
  // Monotonic: the start reading is 1125 and the end reading 1250.
  assert.deepEqual(end, {
    level: "info",
    time: WALL.toISOString(),
    invocationId: start!.invocationId,
    event: "invocation-end",
    client: "headless",
    version: "9.8.7",
    platform: "linux",
    exitStatus: 0,
    elapsedMs: 125,
  });
  assert.deepEqual(notices, []);

  if (process.platform !== "win32") {
    // Owner-only where the OS supports it; Windows ignores POSIX modes.
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
  }
});

test("the end record carries the command's exit status, and no argument reaches the log", async () => {
  const { folder, overrides } = home();
  const out = io();
  const selector = "seeded-argument-6f1c2b";
  const status = await withClients(
    (clients) => runHeadless(clients, ["run", "show", selector], out.io),
    overrides,
  );
  assert.equal(status, 1);
  assert.match(out.err.join(""), /run-not-found/);

  const log = readLog(folder);
  assertBase(log.records);
  assert.deepEqual(
    log.records.map((record) => [record.event, record.exitStatus]),
    [
      ["invocation-start", undefined],
      ["invocation-end", 1],
    ],
  );
  assert.equal(log.text.includes(selector), false);
});

test("a headless fatal error writes and flushes its failure record, and the fatal text names the file", async () => {
  const { folder, overrides } = home();
  const failure = new Error("wiring exploded");
  await assert.rejects(
    withClients(() => 0, {
      ...overrides,
      process: undefined,
      processFactory: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );

  const log = readLog(folder);
  assertBase(log.records);
  assert.deepEqual(
    log.records.map((record) => [record.level, record.event]),
    [
      ["info", "invocation-start"],
      ["fatal", "invocation-failure"],
      ["info", "invocation-end"],
    ],
  );
  const cause = log.records[1]!.cause as Record<string, unknown>;
  assert.equal(cause.type, "Error");
  assert.equal(cause.message, "wiring exploded");
  assert.match(String(cause.stack), /wiring exploded/);
  assert.equal(log.records[2]!.exitStatus, 1);

  assert.equal(
    describeFatal(failure),
    `Error: wiring exploded\nThe operational log for this Secant invocation is at ${log.path}\n`,
  );
});

test("the TUI's no-terminal rejection is a Secant invocation and is logged", async () => {
  const { folder, overrides } = home();
  mkdirSync(folder);
  const old = join(folder, "2026-01-01T00-00-00-000Z-1.jsonl");
  writeFileSync(old, "old evidence");
  const written = new Date("2026-09-01T00:00:00.000Z");
  utimesSync(old, written, written);
  const status = await launchTui({
    ...overrides,
    terminal: { interactive: false, legacyConsole: () => false },
  });
  assert.equal(status, 1);
  assert.equal(existsSync(old), false);

  const log = readLog(folder);
  assertBase(log.records);
  assert.deepEqual(
    log.records.map((record) => [record.event, record.client]),
    [
      ["invocation-start", "tui"],
      ["invocation-end", "tui"],
    ],
  );
  assert.equal(log.records[1]!.exitStatus, 1);
});

test("a TUI wiring failure is recorded and named like any other fatal error", async () => {
  const { folder, overrides } = home();
  const failure = new Error("tui wiring exploded");
  await assert.rejects(
    launchTui({
      ...overrides,
      terminal: { interactive: true, legacyConsole: () => false },
      process: undefined,
      processFactory: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );

  const log = readLog(folder);
  assertBase(log.records);
  assert.deepEqual(
    log.records.map((record) => [record.event, record.client]),
    [
      ["invocation-start", "tui"],
      ["invocation-failure", undefined],
      ["invocation-end", "tui"],
    ],
  );
  assert.equal(
    (log.records[1]!.cause as { message: string }).message,
    "tui wiring exploded",
  );
  assert.equal(log.records[2]!.exitStatus, 1);
  assert.match(
    describeFatal(failure),
    new RegExp(
      `^Error: tui wiring exploded\nThe operational log for this Secant invocation is at .*${log.name}\n$`,
    ),
  );
});

test("an unwritable log folder yields one notice and an unchanged outcome, exit code, and stdout", async () => {
  // A folder beneath a regular file cannot be created on any OS, even as root.
  const blocker = join(makeTempDir("secant-oplog-blocked-"), "file");
  writeFileSync(blocker, "");
  const blocked = home(join(blocker, "logs"));
  const writable = home();

  const run = async (h: Home) => {
    const out = io();
    const status = await withClients(
      (clients) => runHeadless(clients, ["workspace", "--json"], out.io),
      { ...h.overrides, launchCwd: writable.overrides.launchCwd },
    );
    return { status, out };
  };
  const reference = await run(writable);
  const result = await run(blocked);

  assert.equal(result.status, reference.status);
  assert.equal(result.out.out.join(""), reference.out.out.join(""));
  assert.deepEqual(result.out.err, reference.out.err);
  assert.equal(blocked.notices.length, 2);
  assert.match(
    blocked.notices[0]!,
    /^Notice \[operational-log-unavailable\]: Secant could not write its operational log \(ENOTDIR\)/,
  );
  assert.match(blocked.notices[1]!, /^Remediation: .*SECANT_LOG_DIR/);
  assert.equal(existsSync(join(blocker, "logs")), false);

  // With no log, the fatal text falls back to the stack, the only record left.
  const failure = new Error("unlogged failure");
  await assert.rejects(
    withClients(() => 0, {
      ...blocked.overrides,
      process: undefined,
      processFactory: () => {
        throw failure;
      },
    }),
  );
  assert.equal(describeFatal(failure), `${failure.stack}\n`);
  assert.equal(blocked.notices.length, 4, "one notice per Secant invocation");
});

test("the TUI holds a log-failure notice until its launch has returned", async () => {
  const blocker = join(makeTempDir("secant-oplog-blocked-"), "file");
  writeFileSync(blocker, "");
  const blocked = home(join(blocker, "logs"));
  let seenDuringLaunch: number | undefined;
  const failure = new Error("held");
  await assert.rejects(
    launchTui({
      ...blocked.overrides,
      terminal: {
        interactive: true,
        // Read inside the launch, while the terminal would be held.
        legacyConsole: () => {
          seenDuringLaunch = blocked.notices.length;
          return false;
        },
      },
      process: undefined,
      processFactory: () => {
        throw failure;
      },
    }),
  );
  assert.equal(seenDuringLaunch, 0);
  assert.equal(blocked.notices.length, 2);
});

test("--help, --version, and a parse error create no log file", async () => {
  const { folder, overrides } = home();
  for (const args of [["--help"], ["--version"], ["no-such-command"]]) {
    const out = io();
    await runHeadlessCli(args, out.io, "1.2.3", (run) =>
      withClients(run, overrides),
    );
  }
  assert.equal(existsSync(folder), false);
});

test("startup prunes logs by last write, keeping the 30-day boundary and fresh files", async () => {
  const { folder, overrides, notices } = home();
  mkdirSync(folder);
  const day = 24 * 60 * 60 * 1000;
  const planted = [
    { name: "2099-01-01T00-00-00-000Z-1.jsonl", age: 31 * day, keep: false },
    { name: "2000-01-01T00-00-00-000Z-2.jsonl", age: 10 * day, keep: true },
    { name: "2026-01-01T00-00-00-000Z-3.jsonl", age: 30 * day, keep: true },
    {
      name: "2026-01-01T00-00-00-000Z-4.jsonl",
      age: 30 * day + 1000,
      keep: false,
    },
    {
      name: "2026-01-01T00-00-00-000Z-5.jsonl",
      age: 30 * day - 1000,
      keep: true,
    },
  ];
  for (const file of planted) {
    const path = join(folder, file.name);
    writeFileSync(path, "retained evidence");
    const written = new Date(WALL.getTime() - file.age);
    utimesSync(path, written, written);
  }
  const output = io();
  const status = await withClients(
    (clients) => runHeadless(clients, ["workspace", "--json"], output.io),
    overrides,
  );
  assert.equal(status, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(output.err, []);
  for (const file of planted) {
    assert.equal(existsSync(join(folder, file.name)), file.keep, file.name);
    if (file.keep) {
      assert.equal(
        readFileSync(join(folder, file.name), "utf8"),
        "retained evidence",
      );
    }
  }
  const active = join(folder, `2026-10-02T09-08-07-006Z-${process.pid}.jsonl`);
  const records = readFileSync(active, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.event),
    ["invocation-start", "invocation-end"],
  );
});

test("startup prunes only regular log files in the resolved folder, preserving shared-folder and Run Store contents", async () => {
  const { folder, overrides, notices } = home();
  mkdirSync(folder);
  const oldTime = new Date("2026-09-01T00:00:00.000Z");
  const unrelated = [
    "notes.jsonl",
    "2026-01-01T00-00-00-000Z-1.jsonl.backup",
    "copy-2026-01-01T00-00-00-000Z-1.jsonl",
    "2026-01-01T00-00Z-1.jsonl",
  ];
  // Matching names outside the override, including the default log folder and
  // Run Store tree, are untouched. Matching directories are never traversed.
  const directories = [
    makeTempDir("secant-oplog-outside-"),
    join(overrides.secantHome!, "logs"),
    join(overrides.secantHome!, "runs"),
    join(folder, "2026-01-01T00-00-00-000Z-2.jsonl"),
  ];
  const preserved = unrelated.map((name) => join(folder, name));
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
    preserved.push(join(directory, "2026-01-01T00-00-00-000Z-3.jsonl"));
  }
  for (const path of preserved) {
    writeFileSync(path, "unrelated evidence");
    utimesSync(path, oldTime, oldTime);
  }
  utimesSync(directories.at(-1)!, oldTime, oldTime);
  // A directory junction works on Windows without symlink privileges. Even a
  // matching link name must neither be removed nor expose the target to pruning.
  const link = join(folder, "2026-01-01T00-00-00-000Z-4.jsonl");
  symlinkSync(directories[0]!, link, "junction");
  const stale = join(folder, "2026-01-01T00-00-00-000Z-5.jsonl");
  writeFileSync(stale, "stale log");
  utimesSync(stale, oldTime, oldTime);
  const output = io();
  const status = await withClients(
    (clients) => runHeadless(clients, ["workspace", "--json"], output.io),
    overrides,
  );
  assert.equal(status, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(output.err, []);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(link), true);
  for (const path of preserved) {
    assert.equal(readFileSync(path, "utf8"), "unrelated evidence", path);
  }
});

test("startup prunes the default log folder before opening the active file against a future injected clock", async () => {
  const { overrides, notices } = home();
  const folder = join(overrides.secantHome!, "logs");
  mkdirSync(folder);
  const stale = join(folder, "2026-01-01T00-00-00-000Z-1.jsonl");
  writeFileSync(stale, "old evidence");
  const written = new Date("2026-09-01T00:00:00.000Z");
  utimesSync(stale, written, written);
  const future = new Date("2099-10-02T09:08:07.006Z");
  const clock = { ...steppingClock(), now: () => future };
  const status = await withClients(() => 0, {
    ...overrides,
    logSink: { ...overrides.logSink, folder: undefined, clock },
  });
  assert.equal(status, 0);
  assert.deepEqual(notices, []);
  assert.equal(existsSync(stale), false);
  const log = readLog(folder);
  assert.equal(log.name, `2099-10-02T09-08-07-006Z-${process.pid}.jsonl`);
  assert.deepEqual(
    log.records.map((record) => record.event),
    ["invocation-start", "invocation-end"],
  );
});

test("--help, --version, and parse errors leave stale operational logs untouched", async () => {
  const { folder, overrides, notices } = home();
  mkdirSync(folder);
  const stale = join(folder, "2026-01-01T00-00-00-000Z-1.jsonl");
  writeFileSync(stale, "old evidence");
  const written = new Date("2026-09-01T00:00:00.000Z");
  utimesSync(stale, written, written);
  for (const args of [["--help"], ["--version"], ["no-such-command"]]) {
    const output = io();
    await runHeadlessCli(args, output.io, "1.2.3", (run) =>
      withClients(run, overrides),
    );
  }
  assert.deepEqual(readdirSync(folder), ["2026-01-01T00-00-00-000Z-1.jsonl"]);
  assert.equal(readFileSync(stale, "utf8"), "old evidence");
  assert.deepEqual(notices, []);
});

// --- Harness records (#322) ---------------------------------------------------

const FAKE_PROFILE: HarnessProfile = {
  harness: "claude-code",
  executable: "/usr/bin/claude",
  executableVersion: "2.1.273 (Claude Code)",
  platform: "linux",
  adapterRevision: "fake-claude-1",
  configurationPosture: "user-compatible",
  recovery: { mode: "native-reattach", evidence: "scripted fake" },
  interruption: { mode: "process-only", evidence: "scripted fake" },
  approvals: { available: true, evidence: "scripted fake" },
  clarifications: { available: false, evidence: "scripted fake" },
  steer: { available: false, evidence: "scripted fake" },
  modelSelection: { at: "unavailable", evidence: "scripted fake" },
  modelObservation: { available: true, evidence: "scripted fake" },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "scripted fake",
  },
  skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
  fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
};

/** Deterministic discovery, so qualification and Preflight reach the double
 *  without resolving an executable. */
const discoverClaudeCode = () =>
  ({
    kind: "found",
    attempt: {
      source: "path",
      name: "claude",
      description: "PATH name 'claude'",
    },
  }) as const;

/** The records a Harness reported, with the base fields every record carries
 *  (already pinned by `assertBase`) dropped. */
function harnessRecords(records: readonly Record<string, unknown>[]) {
  return records
    .filter((record) => String(record.event).startsWith("harness-"))
    .map(({ time: _time, invocationId: _id, ...rest }) => rest);
}

test("a Harness qualification writes the double's phase facts and its CleanupReport, keeping only typed failure fields and a translated cause", async () => {
  const { folder, overrides } = home();
  // Every field a record must not carry is seeded, so its absence is checked.
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [],
    cleanup: {
      clean: false,
      detail: "Session detached. stderr: seeded-detail-41c7",
      failure: {
        phase: "cleanup",
        category: "cleanup-timeout",
        possibleEffects: "possible",
        nativeCode: "143",
        partialOutput: "seeded-partial-9a20",
        retryEvidence: "seeded-retry-55e1",
        diagnostics: "seeded-diagnostics-c3d8",
        cause: new Error("the child was not reaped"),
      },
      sessions: [
        {
          session: "planning",
          availability: {
            state: "detached",
            coordinate: { opaque: "seeded-coordinate-7b3f" },
          },
        },
        {
          session: "review",
          availability: { state: "unusable", reason: "seeded-reason-2e6a" },
        },
      ],
    },
  };
  const status = await withClients(
    async (clients) => {
      const opened = clients.projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      await opened.updates[Symbol.asyncIterator]().next();
      opened.close();
      return 0;
    },
    { ...overrides, discoverClaudeCode, harnessAdapter: createFake(script) },
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assertBase(log.records);
  const failure = {
    failurePhase: "cleanup",
    category: "cleanup-timeout",
    possibleEffects: "possible",
    nativeCode: "143",
  };
  const records = harnessRecords(log.records);
  const cause = (record: Record<string, unknown>) =>
    record.cause as Record<string, unknown>;
  for (const record of records.filter((r) => r.cause !== undefined)) {
    assert.equal(cause(record).type, "Error");
    assert.equal(cause(record).message, "the child was not reaped");
    assert.match(String(cause(record).stack), /the child was not reaped/);
  }
  assert.deepEqual(
    records.map(({ cause: _cause, ...rest }) => rest),
    [
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "launch",
      },
      {
        level: "info",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "launch",
        status: "ok",
        elapsedMs: 0,
      },
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "handshake",
      },
      {
        level: "info",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "handshake",
        status: "ok",
        elapsedMs: 0,
      },
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "cleanup",
      },
      {
        level: "warn",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "cleanup",
        status: "failed",
        elapsedMs: 0,
        ...failure,
      },
      {
        level: "warn",
        event: "harness-cleanup",
        harness: "claude-code",
        status: "unclean",
        sessions: [
          { session: "planning", availability: "detached" },
          { session: "review", availability: "unusable" },
        ],
        ...failure,
      },
    ],
  );
  assert.equal(
    records.filter((record) => record.cause !== undefined).length,
    2,
  );
  assert.doesNotMatch(log.text, /seeded-/);
});

test("a failed qualification handshake records the double's typed failure", async () => {
  const { folder, overrides } = home();
  await withClients(
    async (clients) => {
      const opened = clients.projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      await opened.updates[Symbol.asyncIterator]().next();
      opened.close();
      return 0;
    },
    {
      ...overrides,
      discoverClaudeCode,
      harnessAdapter: createFake({
        profile: FAKE_PROFILE,
        turns: [],
        prepareFailure: {
          phase: "prepare",
          category: "authentication",
          possibleEffects: "none",
          diagnostics: "seeded-diagnostics-0d4e",
        },
      }),
    },
  );

  const records = harnessRecords(readLog(folder).records);
  assert.deepEqual(records.at(-1), {
    level: "warn",
    event: "harness-phase-end",
    harness: "claude-code",
    phase: "handshake",
    status: "failed",
    elapsedMs: 0,
    failurePhase: "prepare",
    category: "authentication",
    possibleEffects: "none",
  });
  // A prepare that failed has no Harness to close.
  assert.equal(
    records.some((record) => record.event === "harness-cleanup"),
    false,
  );
});

/** A one-Step Bundle folder: an Agent Step of `kind` in Session `s`. */
function writeAgentBundle(kind: "agent" | "interactive-agent" = "agent"): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-oplog-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "fix.md"), "seeded-prompt-8f2a\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.oplog-agent",
      version: "1.0.0",
      name: "Oplog Agent",
      description: "One Agent Step for the operational log.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/fix.md", kind: "prompt" }],
    routing: [
      {
        id: "fix",
        kind,
        session: "s",
        prompt: { asset: "prompts/fix.md" },
      },
    ],
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return { folder, id: manifest.bundle.id };
}

test("an Agent Run records its completed Turn's usage and the Run Harness's CleanupReport", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [
      {
        events: [{ kind: "assistant-content", content: "seeded-content-6c19" }],
        result: {
          kind: "completed",
          detail: {
            finalContent: "seeded-content-6c19",
            effectiveModel: { known: true, model: "claude-opus-5" },
            session: { state: "open" },
            usage: {
              estimate: true,
              summary: "input 12, output 34 tokens; cost estimate USD 0.5",
            },
          },
        },
      },
    ],
  };
  const status = await withClients(
    async (clients) => {
      const bundle = writeAgentBundle();
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      const port = clients.projectionPort;
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await awaitSettled(port, "op-approve");
      const digest = built.report.digest;
      const admission = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: bundle.id },
          launchInputs: {},
          trustDigest: digest,
          harness: "claude-code",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      await awaitSettled(port, "op-launch");
      const run = await awaitRunRest(port, admission.runId!);
      assert.equal(run.state, "succeeded");
      return 0;
    },
    {
      ...overrides,
      process: createFakeBundleProcess(),
      discoverClaudeCode,
      harnessAdapter: createFake(script),
    },
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assertBase(log.records);
  const records = harnessRecords(log.records);
  assert.deepEqual(
    records.filter((record) => record.event === "harness-usage"),
    [
      {
        level: "info",
        event: "harness-usage",
        harness: "claude-code",
        session: "s",
        estimate: true,
        summary: "input 12, output 34 tokens; cost estimate USD 0.5",
      },
    ],
  );
  // The Run's Harness closes after the Turn, and its report is recorded.
  const usageAt = records.findIndex((r) => r.event === "harness-usage");
  assert.deepEqual(records.slice(usageAt + 1), [
    {
      level: "info",
      event: "harness-phase-start",
      harness: "claude-code",
      phase: "cleanup",
    },
    {
      level: "info",
      event: "harness-phase-end",
      harness: "claude-code",
      phase: "cleanup",
      status: "ok",
      elapsedMs: 0,
    },
    {
      level: "info",
      event: "harness-cleanup",
      harness: "claude-code",
      status: "clean",
      sessions: [],
    },
  ]);
  assert.doesNotMatch(log.text, /seeded-/);
});

test("an interactive Step's Turn usage and its driver's CleanupReport reach the log", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "acknowledged",
            effectiveModel: { known: true, model: "claude-opus-5" },
            session: { state: "detached", coordinate: { opaque: "coord-s" } },
            usage: { estimate: true, summary: "input 1, output 2 tokens" },
          },
        },
      },
    ],
  };
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      const bundle = writeAgentBundle("interactive-agent");
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await awaitSettled(port, "op-approve");
      const admission = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: bundle.id },
          launchInputs: {},
          trustDigest: built.report.digest,
          harness: "claude-code",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      const runId = admission.runId!;
      await awaitSettled(port, "op-launch");
      assert.equal((await awaitRunRest(port, runId)).state, "blocked");
      assert.ok(
        port.submit({
          operationId: "op-turn",
          operation: "send-interactive-turn",
          input: { runId, stepId: "fix", text: "seeded-human-text-3b90" },
        }).admitted,
      );
      await awaitSettled(port, "op-turn");
      await awaitRunRest(port, runId);
      assert.ok(
        port.submit({
          operationId: "op-end",
          operation: "end-interactive-step",
          input: { runId, stepId: "fix" },
        }).admitted,
      );
      await awaitSettled(port, "op-end");
      assert.equal((await awaitRunRest(port, runId)).state, "succeeded");
      return 0;
    },
    {
      ...overrides,
      supportsInteractiveTurns: true,
      process: createFakeBundleProcess(),
      discoverClaudeCode,
      harnessAdapter: createFake(script),
    },
  );

  const log = readLog(folder);
  assertBase(log.records);
  const records = harnessRecords(log.records);
  const usageAt = records.findIndex((r) => r.event === "harness-usage");
  assert.deepEqual(records[usageAt], {
    level: "info",
    event: "harness-usage",
    harness: "claude-code",
    session: "s",
    estimate: true,
    summary: "input 1, output 2 tokens",
  });
  // Ending the Step closes the driver that served the Turn: its report follows.
  assert.deepEqual(
    records.slice(usageAt + 1, usageAt + 4).map((r) => [r.event, r.phase]),
    [
      ["harness-phase-start", "cleanup"],
      ["harness-phase-end", "cleanup"],
      ["harness-cleanup", undefined],
    ],
  );
  // Every Harness prepared in this invocation recorded its report exactly once.
  const count = (event: string, phase?: string) =>
    records.filter((r) => r.event === event && r.phase === phase).length;
  assert.ok(count("harness-phase-start", "launch") >= 2);
  assert.equal(
    count("harness-cleanup"),
    count("harness-phase-start", "launch"),
  );
  assert.doesNotMatch(log.text, /seeded-/);
});
