import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fs from "fs-extra";

import { createLogger } from "../src/logger.js";

function createTempLogsDirectories() {
  return {
    repoLogsDirectory: fs.mkdtempSync(join(tmpdir(), "devflow-logs-repo-")),
    homeLogsDirectory: fs.mkdtempSync(join(tmpdir(), "devflow-logs-home-")),
  };
}

function readJsonl(logPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("logger writes JSONL entries through its public interface", () => {
  const { repoLogsDirectory, homeLogsDirectory } = createTempLogsDirectories();
  const logger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory,
    clock: { now: () => new Date("2026-05-24T10:11:12.000Z") },
  });

  logger.info("run created", {
    runId: "run-123",
    stage: "grill",
    context: { attempt: 1 },
  });

  const logPath = join(repoLogsDirectory, "devflow-2026-05-24.log");
  const entries = readJsonl(logPath);

  assert.deepEqual(entries, [
    {
      ts: "2026-05-24T10:11:12.000Z",
      level: "info",
      runId: "run-123",
      stage: "grill",
      msg: "run created",
      context: { attempt: 1 },
    },
  ]);
});

test("logger appends entries and uses null run id outside a run", () => {
  const { repoLogsDirectory, homeLogsDirectory } = createTempLogsDirectories();
  const logger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory,
    clock: { now: () => new Date("2026-05-24T10:11:12.000Z") },
  });

  logger.debug("before run");
  logger.warn("recovered", { runId: "run-123" });

  const entries = readJsonl(join(repoLogsDirectory, "devflow-2026-05-24.log"));

  assert.deepEqual(
    entries.map((entry) => ({
      level: entry.level,
      runId: entry.runId,
      msg: entry.msg,
      ref: entry.ref,
    })),
    [
      { level: "debug", runId: null, msg: "before run", ref: undefined },
      { level: "warn", runId: "run-123", msg: "recovered", ref: undefined },
    ],
  );
});

test("logger derives daily filenames from the injected clock local date", () => {
  const { repoLogsDirectory, homeLogsDirectory } = createTempLogsDirectories();
  const timestamps = [
    new Date("2026-05-24T10:11:12.000Z"),
    new Date("2026-05-25T10:11:12.000Z"),
  ];
  const logger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory,
    clock: {
      now: () => timestamps.shift() ?? new Date("2026-05-25T10:11:12.000Z"),
    },
  });

  logger.info("first day");
  logger.info("second day");

  assert.deepEqual(
    fs.readdirSync(repoLogsDirectory).sort(),
    ["devflow-2026-05-24.log", "devflow-2026-05-25.log"],
  );
});

test("logger serializes errors and critical refs only on critical entries", () => {
  const { repoLogsDirectory, homeLogsDirectory } = createTempLogsDirectories();
  const logger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory,
    clock: { now: () => new Date("2026-05-24T10:11:12.000Z") },
  });
  const error = new TypeError("bad artifact");

  logger.error("anticipated failure", { runId: "run-123", err: error });
  const ref = logger.critical("unexpected failure", {
    runId: "run-123",
    err: error,
  });

  const entries = readJsonl(join(repoLogsDirectory, "devflow-2026-05-24.log"));

  assert.equal(entries[0]?.ref, undefined);
  assert.deepEqual(entries[0]?.err, {
    name: "TypeError",
    message: "bad artifact",
    stack: error.stack,
  });
  assert.match(ref, /^err_[0-9a-f]{6}$/);
  assert.equal(entries[1]?.ref, ref);
  assert.deepEqual(entries[1]?.err, {
    name: "TypeError",
    message: "bad artifact",
    stack: error.stack,
  });
});

test("logger falls back to home logs and never throws when writes fail", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "devflow-logs-fallback-"));
  const repoLogsDirectory = join(root, "repo-logs-file");
  const homeLogsDirectory = join(root, "home-logs");
  fs.writeFileSync(repoLogsDirectory, "not a directory");
  const logger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory,
    clock: { now: () => new Date("2026-05-24T10:11:12.000Z") },
  });

  assert.doesNotThrow(() => logger.info("fallback write", { runId: "run-123" }));
  assert.deepEqual(readJsonl(join(homeLogsDirectory, "devflow-2026-05-24.log")), [
    {
      ts: "2026-05-24T10:11:12.000Z",
      level: "info",
      runId: "run-123",
      msg: "fallback write",
    },
  ]);

  const brokenHomeLogsDirectory = join(root, "home-logs-file");
  fs.writeFileSync(brokenHomeLogsDirectory, "not a directory");
  const degradedLogger = createLogger({
    repoLogsDirectory,
    homeLogsDirectory: brokenHomeLogsDirectory,
    clock: { now: () => new Date("2026-05-24T10:11:12.000Z") },
  });

  assert.doesNotThrow(() => degradedLogger.error("degraded silently"));
});
