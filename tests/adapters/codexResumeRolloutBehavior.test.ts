import assert from "node:assert/strict";
import { basename, join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

type JsonRecord = {
  type?: unknown;
  payload?: unknown;
};

const fixtureRoot = join(
  process.cwd(),
  "tests/fixtures/codex-resume-appends-same-rollout/sessions/2026/05/31",
);

test("Codex resume appends to the same rollout whose filename carries session_meta.payload.id", async () => {
  const rolloutFiles = (await fs.readdir(fixtureRoot))
    .filter((fileName) => fileName.startsWith("rollout-"))
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort();

  assert.deepEqual(
    rolloutFiles,
    [
      "rollout-2026-05-31T19-31-13-019e7e56-baeb-7142-b6a7-c3a7a5ee4d13.jsonl",
    ],
    "fixture must contain exactly the original rollout; if Codex starts forking resume rollouts, update the resume architecture or this explicit regression pin",
  );

  const rolloutPath = join(fixtureRoot, rolloutFiles[0]);
  const records = (await fs.readFile(rolloutPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRecord);

  const sessionMeta = records.find(
    (record): record is { type: "session_meta"; payload: { id: string } } =>
      record.type === "session_meta" &&
      typeof record.payload === "object" &&
      record.payload !== null &&
      "id" in record.payload &&
      typeof record.payload.id === "string",
  );

  assert.ok(sessionMeta, "fixture must include Codex session_meta payload");
  assert.ok(
    basename(rolloutPath).endsWith(`-${sessionMeta.payload.id}.jsonl`),
    "Codex rollout filename must end with the session_meta.payload.id used for resume lookup",
  );

  const completedMessages = records
    .filter(
      (
        record,
      ): record is {
        type: "event_msg";
        payload: { type: "task_complete"; last_agent_message: string };
      } =>
        record.type === "event_msg" &&
        typeof record.payload === "object" &&
        record.payload !== null &&
        "type" in record.payload &&
        record.payload.type === "task_complete" &&
        "last_agent_message" in record.payload &&
        typeof record.payload.last_agent_message === "string",
    )
    .map((record) => record.payload.last_agent_message);

  assert.deepEqual(completedMessages, [
    "fresh launch completed INITIAL_DONE",
    "resume appended to original rollout RESUME_DONE",
  ]);
});
