import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createCodexAdapter,
  type HarnessContainmentObserver,
} from "../../src/harness/harness.js";
import type {
  ProcessAdapter,
  ProcessLaunchContainment,
} from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The recorded qualification replies are delivered only after their request,
// through an in-process owned child. No external Harness or process runs.
function codexProcess(
  containment: ProcessLaunchContainment | undefined,
): ProcessAdapter {
  const fixture = join(
    import.meta.dirname,
    "fixtures/codex/codex-qualification",
  );
  const recording: { traffic: { direction: string; line: string }[] } =
    JSON.parse(readFileSync(join(fixture, "case.json"), "utf8"));
  const replies = recording.traffic
    .filter((frame) => frame.direction === "stdout")
    .map((frame) => frame.line);
  return createFakeProcess({
    resolutionHandler: () => ({
      kind: "found",
      executable: process.execPath,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      if (options.args.includes("generate-json-schema")) {
        const directory = options.args[options.args.indexOf("--out") + 1];
        assert.ok(directory);
        copyFileSync(
          join(fixture, "stable-schema.generated.json"),
          join(directory, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: new TextEncoder().encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: [
      {
        kind: "launched",
        containment: containment?.kind,
        containmentCause:
          containment?.kind === "fallback" ? containment.cause : undefined,
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request: { id?: number } = JSON.parse(
            new TextDecoder().decode(bytes),
          );
          if (request.id === undefined) return [];
          const reply = replies.find(
            (line) => JSON.parse(line).id === request.id,
          );
          assert.ok(reply, `recorded reply for ${request.id}`);
          return [{ kind: "stdout", bytes: new TextEncoder().encode(reply) }];
        },
      },
    ],
  });
}

for (const kind of ["contained", "fallback", undefined] as const) {
  test(`Codex reports ${kind ?? "no Windows"} evidence at prepare without native causes`, async (t) => {
    const facts: Parameters<HarnessContainmentObserver>[0][] = [];
    const containment =
      kind === undefined
        ? undefined
        : kind === "contained"
          ? { kind }
          : { kind, cause: new Error("forced job acquisition failure") };
    const prepared = await createCodexAdapter({ env: {} }).prepare({
      workspace: makeTempDir("secant-containment-ws-"),
      process: codexProcess(containment),
      containment: (fact) => facts.push(fact),
    });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    t.after(() => prepared.harness.close());
    assert.deepEqual(facts, kind === undefined ? [] : [{ kind }]);
  });
}

test("a throwing containment observer cannot fail Codex preparation", async (t) => {
  const prepared = await createCodexAdapter({ env: {} }).prepare({
    workspace: makeTempDir("secant-containment-ws-"),
    process: codexProcess({
      kind: "fallback",
      cause: new Error("forced failure"),
    }),
    containment: () => {
      throw new Error("observer failure");
    },
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  t.after(() => prepared.harness.close());
});
