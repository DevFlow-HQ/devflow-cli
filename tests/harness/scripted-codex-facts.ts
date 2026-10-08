// Recorded Codex protocol replies behind the scripted Process. Extra frames are
// synthetic semantic overlays of already-qualified native shapes.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createCodexAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { replayRecordedLine } from "./codex-replay-path.js";
import type { TestHarnessAdapter } from "./test-adapters.js";

export function scriptedCodexFacts(
  extra: readonly object[] = [],
  workspace = makeTempDir("secant-observed-codex-"),
  summaryCase?: {
    provider: string;
    model: string;
    reroute?: string;
    complete?: boolean;
    afterSummary?: (target: {
      threadId: string;
      turnId: string;
      summaryId: string;
    }) => readonly object[];
  },
): TestHarnessAdapter {
  const traffic = z
    .object({
      traffic: z.array(
        z.object({ direction: z.string(), line: z.string().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/codex/test-repair/case.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const envelope = z.looseObject({
    id: z.number().optional(),
    method: z.string().optional(),
  });
  const requests = new Map<number, string>();
  const replies = new Map<string, z.infer<typeof envelope>>();
  const notifications: object[] = [];
  let running = false;
  for (const entry of traffic.traffic) {
    if (
      entry.line === undefined ||
      !["stdin", "stdout"].includes(entry.direction)
    )
      continue;
    const value = envelope.parse(
      JSON.parse(replayRecordedLine(entry.line, workspace)),
    );
    if (entry.direction === "stdin") {
      if (value.id !== undefined && value.method !== undefined)
        requests.set(value.id, value.method);
      if (value.method === "turn/start") running = true;
    } else if (value.id !== undefined) {
      const method = requests.get(value.id);
      assert.ok(method);
      replies.set(method, value);
    } else if (running) notifications.push(value);
  }
  const encoder = new TextEncoder();
  const process = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (command) => {
      if (command.args.includes("generate-json-schema")) {
        const out = command.args[command.args.indexOf("--out") + 1];
        assert.ok(out);
        copyFileSync(
          new URL(
            "./fixtures/codex/codex-qualification/stable-schema.generated.json",
            import.meta.url,
          ),
          join(out, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: encoder.encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request = envelope.parse(
            JSON.parse(new TextDecoder().decode(bytes)),
          );
          if (request.id === undefined) return [];
          const reply = replies.get(request.method ?? "");
          assert.ok(reply, `reply for ${request.method}`);
          const frames: z.infer<typeof envelope>[] = [
            { ...reply, id: request.id },
          ];
          if (summaryCase !== undefined && request.method === "thread/read") {
            const native = z
              .object({
                result: z.object({ thread: z.looseObject({ id: z.string() }) }),
              })
              .parse(reply);
            const started = z
              .object({
                params: z.object({
                  threadId: z.string(),
                  turn: z.object({ id: z.string() }),
                }),
              })
              .parse(
                notifications.find(
                  (value) => envelope.parse(value).method === "turn/started",
                ),
              );
            const correlation = {
              threadId: started.params.threadId,
              turnId: started.params.turn.id,
            };
            // Admit the read first, then replay display facts in the same Turn.
            frames[0] = {
              id: request.id,
              result: {
                thread: {
                  ...native.result.thread,
                  modelProvider: summaryCase.provider,
                  model: summaryCase.model,
                },
              },
            };
            if (summaryCase.reroute !== undefined)
              frames.push({
                method: "model/rerouted",
                params: {
                  ...correlation,
                  toModel: summaryCase.reroute,
                  fromModel: summaryCase.model,
                  reason: "test",
                },
              });
            frames.push(
              {
                method: "item/reasoning/summaryTextDelta",
                params: {
                  ...correlation,
                  itemId: "summary",
                  summaryIndex: 0,
                  delta: "Qualified summary",
                },
              },
              ...(summaryCase.complete === false
                ? []
                : [
                    {
                      method: "item/completed",
                      params: {
                        ...correlation,
                        item: {
                          id: "summary",
                          type: "reasoning",
                          summary: ["Qualified summary"],
                        },
                      },
                    },
                  ]),
              ...(
                summaryCase.afterSummary?.({
                  ...correlation,
                  summaryId: "summary",
                }) ?? []
              ).map((value) => envelope.parse(value)),
              ...notifications
                .filter(
                  (value) => envelope.parse(value).method === "turn/completed",
                )
                .map((value) => envelope.parse(value)),
            );
          }
          if (request.method === "turn/start") {
            const terminal = notifications.findIndex(
              (value) => envelope.parse(value).method === "turn/completed",
            );
            frames.push(
              ...notifications
                .slice(0, terminal)
                .map((value) => envelope.parse(value)),
              ...extra.map((value) => {
                const extra = z
                  .looseObject({
                    method: z.string().optional(),
                    params: z
                      .looseObject({
                        threadId: z.unknown().optional(),
                        turnId: z.unknown().optional(),
                        item: z.unknown().optional(),
                        itemId: z.string().optional(),
                      })
                      .optional(),
                  })
                  .parse(value);
                if (
                  (extra.params?.item !== undefined ||
                    extra.params?.itemId !== undefined) &&
                  extra.params.threadId === undefined
                ) {
                  const correlated = z
                    .object({
                      params: z.object({
                        threadId: z.string(),
                        turn: z.object({ id: z.string() }),
                      }),
                    })
                    .parse(
                      notifications.find(
                        (value) =>
                          envelope.parse(value).method === "turn/started",
                      ),
                    );
                  return {
                    ...extra,
                    params: {
                      ...extra.params,
                      threadId: correlated.params.threadId,
                      turnId: correlated.params.turn.id,
                    },
                  };
                }
                return envelope.parse(value);
              }),
              ...(summaryCase === undefined
                ? notifications
                    .slice(terminal)
                    .map((value) => envelope.parse(value))
                : []),
            );
          }
          return [
            {
              kind: "stdout",
              bytes: encoder.encode(
                frames.map((value) => JSON.stringify(value) + "\n").join(""),
              ),
            },
          ];
        },
      },
    ],
  });
  const adapter = createCodexAdapter({ env: {} });
  return {
    prepare: (options) => adapter.prepare({ ...options, workspace, process }),
    close: (options) => adapter.close(options),
  };
}
