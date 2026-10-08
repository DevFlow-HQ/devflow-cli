import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { createApplication } from "../../src/application/application.js";
import type { SessionHistoryValue } from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";

const fixture = new URL(
  "../fixtures/previous-release-turn-order/",
  import.meta.url,
);
const { runId } = z
  .object({ runId: z.string() })
  .parse(JSON.parse(readFileSync(new URL("expected.json", fixture), "utf8")));

function completed(n: number): SessionHistoryValue[] {
  return [
    { kind: "message", role: "user", content: n === 0 ? "" : `input ${n}` },
    { kind: "activity", description: `Read started · file ${n}` },
    {
      kind: "request",
      description: `Harness Request raised · Read · file ${n}`,
    },
    {
      kind: "request",
      description: "Harness Request answered · answered by human (allow)",
    },
    { kind: "activity", description: `Read completed · file ${n}` },
    {
      kind: "message",
      role: "assistant",
      content: n === 0 ? "" : `transcript ${n}`,
    },
    {
      kind: "turn-result",
      origin: "human",
      result: "completed",
      harness: "claude-code",
      model: "fixture-model",
      durationMs: 0,
    },
  ];
}

test("m10-audit-legacy-turn-order: migrated input precedes write-ordered activity, authoritative reply and closing line across interleaved Sessions before and after loss", async () => {
  const home = makeTempDir("secant-legacy-history-");
  cpSync(fixture, home, { recursive: true });
  for (let pass = 0; pass < 3; pass++) {
    const lost = pass !== 0;
    const catalog = openCatalog(home);
    const group = openFakeRunGroup(home, "/fixture/conversation", {
      ...(lost ? {} : { selfPid: -1 }),
      isOwnerAlive: () => !lost,
    });
    if (!lost) {
      const owner = group.acquireRun(runId, { takeover: true });
      assert.ok(owner);
      owner.close();
    }
    const app = createApplication({
      catalog,
      runGroup: group,
      process: createFakeProcess({}),
      launchWorkspacePath: home,
      hostPlatform: hostPlatform(),
    });
    try {
      for (const [session, expected] of [
        ["shared", [...completed(0), ...completed(2)]],
        [
          "other",
          [
            ...completed(1),
            { kind: "message", role: "user", content: "input 3" },
            { kind: "activity", description: "Read started · file 3" },
            {
              kind: "request",
              description: "Harness Request raised · Read · file 3",
            },
            ...(lost
              ? [
                  {
                    kind: "turn-result",
                    origin: "human",
                    result: "lost",
                    harness: "claude-code",
                    model: "fixture-model",
                  },
                ]
              : []),
          ],
        ],
      ] as const) {
        const opened = app.projectionPort.openProjection({
          family: "session-history",
          runId,
          session,
        });
        try {
          assert.ok(opened.snapshot.result.found);
          const { rows, hasEarlier } = opened.snapshot.result.history;
          assert.deepEqual(
            rows.map((row) => row.value),
            expected,
          );
          assert.equal(hasEarlier, false);
          assert.ok(rows.every((row) => row.source === "stored"));
          assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
        } finally {
          opened.close();
        }
      }
    } finally {
      await app.shutdown();
      group.close();
      catalog.close();
    }
  }
});
