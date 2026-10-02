import assert from "node:assert/strict";
import test from "node:test";
import {
  BreadcrumbFold,
  formatSummary,
  parseBreadcrumbs,
  summarize,
  type Breadcrumb,
} from "./breadcrumbs.js";

// The breadcrumb fold and last-active-stage summary (#326) the supervisor and an
// unsupervised runner program share. The supervisor itself spawns, so its fixture
// scenarios run in standalone runtime conformance; this suite pins the
// process-free reading of what a scenario reported.

function fold(crumbs: readonly Breadcrumb[]): BreadcrumbFold {
  const state = new BreadcrumbFold();
  for (const crumb of crumbs) state.apply(crumb);
  return state;
}

test("a scenario that ends passed closes, and the next one opens with no stages or children", () => {
  const state = fold([
    { type: "program-start", total: 3, at: 0 },
    { type: "scenario-start", index: 0, scenario: "first", at: 1 },
    { type: "stage-start", stage: "spawn", at: 2 },
    { type: "child", fact: { kind: "spawn", role: "command", pid: 7 }, at: 3 },
    {
      type: "child",
      fact: { kind: "exit", role: "command", pid: 7, status: 0, elapsedMs: 1 },
      at: 3,
    },
    {
      type: "scenario-end",
      index: 0,
      scenario: "first",
      status: "passed",
      at: 4,
    },
    { type: "scenario-start", index: 1, scenario: "second", at: 5 },
  ]);
  assert.equal(state.total, 3);
  assert.equal(state.lastPassed, 0);
  assert.deepEqual(state.open, {
    index: 1,
    scenario: "second",
    since: 5,
    stages: [],
    children: [],
  });
  assert.equal(
    fold([
      { type: "scenario-start", index: 0, scenario: "only", at: 1 },
      {
        type: "scenario-end",
        index: 0,
        scenario: "only",
        status: "passed",
        at: 2,
      },
    ]).open,
    undefined,
  );
});

test("children settle by PID, a synchronous child by its role, and a kill only annotates", () => {
  const state = fold([
    { type: "scenario-start", index: 0, scenario: "children", at: 0 },
    {
      type: "child",
      fact: { kind: "spawn", role: "harness-runtime", pid: 10 },
      at: 1,
    },
    { type: "child", fact: { kind: "spawn", role: "command", pid: 11 }, at: 2 },
    {
      type: "child",
      fact: { kind: "timeout", role: "command", pid: 11 },
      at: 3,
    },
    // Two nested synchronous git spawns: the inner one returns first.
    { type: "child", fact: { kind: "spawn", role: "git" }, at: 4 },
    { type: "child", fact: { kind: "spawn", role: "git" }, at: 5 },
    {
      type: "child",
      fact: { kind: "exit", role: "git", pid: 90, status: 0, elapsedMs: 1 },
      at: 6,
    },
    {
      type: "child",
      fact: {
        kind: "exit",
        role: "harness-runtime",
        pid: 10,
        status: 0,
        elapsedMs: 5,
      },
      at: 7,
    },
    // An asynchronous spawn error had no start, so it closes nothing.
    {
      type: "child",
      fact: {
        kind: "spawn-error",
        role: "command",
        code: "ENOENT",
        elapsedMs: 0,
      },
      at: 8,
    },
  ]);
  assert.deepEqual(state.open?.children, [
    { role: "command", pid: 11, since: 2, kill: "timeout" },
    { role: "git", pid: undefined, since: 4 },
  ]);

  const reaped = fold([
    { type: "scenario-start", index: 0, scenario: "sync", at: 0 },
    { type: "child", fact: { kind: "spawn", role: "git" }, at: 1 },
    {
      type: "child",
      fact: {
        kind: "reap",
        role: "git",
        pid: 5,
        signal: "SIGKILL",
        elapsedMs: 1,
      },
      at: 2,
    },
    { type: "child", fact: { kind: "spawn", role: "command" }, at: 3 },
    {
      type: "child",
      fact: {
        kind: "spawn-error",
        role: "command",
        code: "ENOENT",
        elapsedMs: 0,
      },
      at: 4,
    },
  ]);
  assert.deepEqual(reaped.open?.children, []);
});

test("a stage that threw stays open until the scenario starts or ends another, and a passing scenario's open child carries over", () => {
  const caught = fold([
    { type: "scenario-start", index: 0, scenario: "catches", at: 0 },
    { type: "stage-start", stage: "outer", at: 1 },
    { type: "stage-start", stage: "probe", at: 2 },
    { type: "stage-end", stage: "probe", status: "failed", at: 3 },
    { type: "stage-start", stage: "fallback", at: 4 },
  ]);
  assert.deepEqual(
    caught.open?.stages.map((open) => open.stage),
    ["outer", "fallback"],
  );
  const closed = fold([
    { type: "scenario-start", index: 0, scenario: "catches", at: 0 },
    { type: "stage-start", stage: "outer", at: 1 },
    { type: "stage-start", stage: "probe", at: 2 },
    { type: "stage-end", stage: "probe", status: "failed", at: 3 },
    { type: "stage-end", stage: "outer", status: "passed", at: 4 },
  ]);
  assert.deepEqual(closed.open?.stages, []);

  const carried = fold([
    { type: "scenario-start", index: 0, scenario: "leaks", at: 0 },
    { type: "child", fact: { kind: "spawn", role: "command", pid: 8 }, at: 1 },
    {
      type: "scenario-end",
      index: 0,
      scenario: "leaks",
      status: "passed",
      at: 2,
    },
    { type: "scenario-start", index: 1, scenario: "next", at: 3 },
  ]);
  assert.deepEqual(carried.open?.children, [
    { role: "command", pid: 8, since: 1 },
  ]);
});

test("a failed stage and a failed scenario stay open; a passed stage closes", () => {
  const state = fold([
    { type: "scenario-start", index: 2, scenario: "failing", at: 0 },
    { type: "stage-start", stage: "outer", at: 1 },
    { type: "stage-start", stage: "done", at: 2 },
    { type: "stage-end", stage: "done", status: "passed", at: 3 },
    { type: "stage-start", stage: "assert", at: 4 },
    { type: "stage-end", stage: "assert", status: "failed", at: 5 },
    {
      type: "scenario-end",
      index: 2,
      scenario: "failing",
      status: "failed",
      at: 6,
    },
  ]);
  assert.equal(state.open?.status, "failed");
  assert.deepEqual(
    state.open?.stages.map((open) => open.stage),
    ["outer", "assert"],
  );
  assert.equal(state.lastPassed, undefined);
});

test("the summary names the scenario, the open stage, each open child's role and PID, elapsed time, and the log folder", () => {
  const state = fold([
    { type: "program-start", total: 9, at: 0 },
    { type: "scenario-start", index: 3, scenario: "blocked", at: 1_000 },
    { type: "stage-start", stage: "probe", at: 1_500 },
    {
      type: "child",
      fact: { kind: "spawn", role: "harness-runtime", pid: 42 },
      at: 2_000,
    },
    { type: "child", fact: { kind: "spawn", role: "git" }, at: 2_500 },
  ]);
  const now = 21_000;
  const summary = summarize(
    "runtime-conformance",
    state,
    { kind: "timed-out", boundMs: 20_000 },
    "/logs",
    now,
  );
  assert.equal(summary.elapsedMs, 20_000);
  assert.equal(
    formatSummary(summary),
    [
      "FAILED blocked (runtime-conformance #4 of 9): did not settle within 20 seconds",
      "  open stage:     probe, open 19.5 s",
      "  open children:  harness-runtime PID 42, open 19.0 s",
      "                  git PID unknown (synchronous spawn still blocking), open 18.5 s",
      "  elapsed:        20.0 s",
      "  log folder:     /logs",
      "",
    ].join("\n"),
  );

  const quiet = fold([
    { type: "scenario-start", index: 0, scenario: "q", at: 0 },
  ]);
  assert.equal(
    formatSummary(
      summarize(
        "p",
        quiet,
        { kind: "exited", status: 3, signal: null },
        "/l",
        500,
      ),
    ),
    [
      "FAILED q (p #1): ended its process with status 3",
      "  open stage:     none",
      "  open children:  none reported",
      "  elapsed:        0.5 s",
      "  log folder:     /l",
      "",
    ].join("\n"),
  );
  assert.equal(
    formatSummary(
      summarize(
        "p",
        new BreadcrumbFold(0),
        { kind: "exited", status: null, signal: "SIGKILL" },
        "/l",
        0,
      ),
    ),
    "FAILED p: the program ended its process by SIGKILL outside any scenario\n  program phase:  program-start\n  open stage:     none\n  open children:  none reported\n  elapsed:        0.0 s\n  log folder:     /l\n",
  );
});

test("only complete lines parse, and the consumed count is in bytes", () => {
  const first = JSON.stringify({
    type: "stage-start",
    stage: "naïve — stage",
    at: 1,
  });
  const bytes = new TextEncoder().encode(`${first}\n{"type":"stage-st`);
  const { crumbs, consumed } = parseBreadcrumbs(bytes);
  assert.deepEqual(crumbs, [
    { type: "stage-start", stage: "naïve — stage", at: 1 },
  ]);
  assert.equal(consumed, new TextEncoder().encode(`${first}\n`).length);
  assert.deepEqual(parseBreadcrumbs(new Uint8Array()), {
    crumbs: [],
    consumed: 0,
  });
});

test("setup stages and child facts survive outside scenarios and appear in the timeout summary", () => {
  const state = fold([
    { type: "program-start", at: 1_000 },
    { type: "stage-start", stage: "pre-scenario setup", at: 1_500 },
    { type: "child", fact: { kind: "spawn", role: "git" }, at: 2_000 },
  ]);
  const summary = summarize(
    "p",
    state,
    { kind: "timed-out", boundMs: 20_000 },
    "/l",
    21_000,
  );
  assert.equal(summary.scenario, undefined);
  assert.equal(summary.elapsedMs, 20_000);
  assert.equal(
    formatSummary(summary),
    [
      "FAILED p: the program did not settle within 20 seconds outside any scenario",
      "  program phase:  program-start",
      "  open stage:     pre-scenario setup, open 19.5 s",
      "  open children:  git PID unknown (synchronous spawn still blocking), open 19.0 s",
      "  elapsed:        20.0 s",
      "  log folder:     /l",
      "",
    ].join("\n"),
  );
});

test("child settlement between scenarios removes carried children and keeps new children for cleanup", () => {
  const state = fold([
    { type: "program-start", total: 2, at: 0 },
    { type: "child", fact: { kind: "spawn", role: "command", pid: 7 }, at: 1 },
    { type: "scenario-start", index: 0, scenario: "first", at: 2 },
    {
      type: "scenario-end",
      index: 0,
      scenario: "first",
      status: "passed",
      at: 3,
    },
    { type: "stage-start", stage: "between", at: 4 },
    {
      type: "child",
      fact: { kind: "exit", role: "command", pid: 7, status: 0, elapsedMs: 4 },
      at: 5,
    },
    {
      type: "child",
      fact: { kind: "spawn", role: "harness-runtime", pid: 8 },
      at: 6,
    },
  ]);
  assert.equal(state.since, 3);
  assert.deepEqual(state.children, [
    { role: "harness-runtime", pid: 8, since: 6 },
  ]);
  const summary = summarize(
    "p",
    state,
    { kind: "exited", status: 23, signal: null },
    "/l",
    10,
  );
  assert.equal(summary.gap?.phase, "between-scenarios");
  assert.equal(summary.gap?.stages[0]?.stage, "between");
  assert.equal(summary.elapsedMs, 7);
  assert.match(formatSummary(summary), /harness-runtime PID 8/);
  state.apply({ type: "scenario-start", index: 1, scenario: "last", at: 11 });
  assert.equal(state.since, 11);
  assert.deepEqual(state.open?.stages, []);
  state.apply({
    type: "scenario-end",
    index: 1,
    scenario: "last",
    status: "passed",
    at: 12,
  });
  assert.equal(state.since, 12);
  assert.equal(state.gap?.phase, "program-end");
  assert.equal(state.completed, false);
  state.apply({ type: "program-end", at: 13 });
  assert.equal(state.completed, true);
  assert.deepEqual(state.children, [
    { role: "harness-runtime", pid: 8, since: 6 },
  ]);
});

test("startup has a bound before the first breadcrumb and ready does not renew setup's bound", () => {
  const state = new BreadcrumbFold(100);
  assert.equal(state.since, 100);
  state.apply({ type: "program-start", at: 200 });
  state.apply({ type: "program-ready", total: 1, at: 300 });
  assert.equal(state.total, 1);
  assert.equal(state.since, 100);
  assert.equal(state.gap?.phase, "program-start");
  const empty = new BreadcrumbFold(100);
  empty.apply({ type: "program-ready", total: 0, at: 300 });
  assert.equal(empty.gap?.phase, "program-end");
  assert.equal(empty.since, 300);
});
