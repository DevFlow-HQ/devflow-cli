import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { withClients } from "../../src/composition/main.js";
import type { HeadlessIO } from "../../src/headless/headless.js";
import type { HarnessAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The log-sink Seam (#318) the operational-log suites share: a temporary home
// whose log folder, clock, and fallback channel come from the wiring overrides,
// and readers for the one JSONL file a Secant invocation writes. Tests never set
// SECANT_LOG_DIR; the compiled-binary smoke owns the environment names.

// The injected clock: a fixed wall clock, and a monotonic reading that advances
// 125 ms per read, so elapsed time is exact.
export const WALL = new Date("2026-10-02T09:08:07.006Z");
export function steppingClock() {
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

export interface Home {
  readonly folder: string;
  readonly notices: string[];
  readonly overrides: Parameters<typeof withClients>[1] & {};
}

export function home(folder?: string): Home {
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

export function io(): { io: HeadlessIO; out: string[]; err: string[] } {
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
export function readLog(folder: string) {
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
export function assertBase(records: readonly Record<string, unknown>[]): void {
  const id = records[0]!.invocationId;
  assert.match(String(id), INVOCATION_ID);
  for (const record of records) {
    assert.equal(record.invocationId, id);
    assert.equal(record.time, WALL.toISOString());
    assert.equal("hostname" in record, false);
    assert.equal("msg" in record, false);
  }
}
