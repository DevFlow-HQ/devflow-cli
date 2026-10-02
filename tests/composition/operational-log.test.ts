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
import {
  runHeadless,
  runHeadlessCli,
  type HeadlessIO,
} from "../../src/headless/headless.js";
import type { HarnessAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The operational log (#318) through both client entries, read back from the
// JSONL each Secant invocation writes. Every test reaches the sink through the
// wiring overrides' log-sink Seam (folder, clock, fallback channel) and never
// sets SECANT_LOG_DIR; the compiled-binary smoke owns the environment names.
// The Process double has no script and the Harness doubles refuse to prepare, so
// any spawn or Harness launch would throw.

// The injected clock: a fixed wall clock, and a monotonic reading that advances
// 125 ms per read, so elapsed time is exact.
const WALL = new Date("2026-10-02T09:08:07.006Z");
function steppingClock() {
  let reading = 1000;
  return {
    now: () => WALL,
    monotonic: () => (reading += 125),
  };
}

const unpreparedHarness: HarnessAdapter = {
  prepare() {
    throw new Error("no Harness is prepared in these tests");
  },
};

interface Home {
  readonly folder: string;
  readonly notices: string[];
  readonly overrides: Parameters<typeof withClients>[1] & {};
}

function home(folder?: string): Home {
  const logFolder = folder ?? join(makeTempDir("secant-oplog-"), "logs");
  const notices: string[] = [];
  return {
    folder: logFolder,
    notices,
    overrides: {
      secantHome: makeTempDir("secant-oplog-home-"),
      launchCwd: makeTempDir("secant-oplog-ws-"),
      engineVersion: "9.8.7",
      hostPlatform: "linux",
      process: createFakeProcess({}),
      harnessAdapter: unpreparedHarness,
      codexHarnessAdapter: unpreparedHarness,
      logSink: {
        folder: logFolder,
        clock: steppingClock(),
        stderr: (text) => notices.push(text),
      },
    },
  };
}

function io(): { io: HeadlessIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: () => process.cwd(),
    },
    out,
    err,
  };
}

/** The one file in the folder, its name, raw text, and parsed records. */
function readLog(folder: string) {
  const names = readdirSync(folder);
  assert.equal(names.length, 1, `one file per Secant invocation: ${names}`);
  const name = names[0]!;
  const text = readFileSync(join(folder, name), "utf8");
  assert.ok(text.endsWith("\n"));
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { name, path: join(folder, name), text, records };
}

const INVOCATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every record carries exactly the base fields and one shared Secant invocation id. */
function assertBase(records: readonly Record<string, unknown>[]): void {
  const id = records[0]!.invocationId;
  assert.match(String(id), INVOCATION_ID);
  for (const record of records) {
    assert.equal(record.invocationId, id);
    assert.equal(record.time, WALL.toISOString());
    assert.equal("hostname" in record, false);
    assert.equal("msg" in record, false);
  }
}

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
