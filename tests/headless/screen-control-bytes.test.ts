import {
  UNTRUSTED_TERMINAL_TEXT as unsafe,
  UNSAFE_TERMINAL_CHARACTERS as bad,
} from "../helpers/terminalText.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type * as App from "../../src/application/projection-port.js";
import { runHeadless, runHeadlessCli } from "../../src/headless/headless.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { writeCommandBundle } from "../helpers/commandBundle.js";

test("m10-audit-screen-control-bytes: Bundle list and inspect screen text while JSON retains original values", async (t) => {
  const h = openHeadlessHarness(t);
  const bundle = writeCommandBundle();
  const manifest = JSON.parse(
    readFileSync(join(bundle.folder, "manifest.json"), "utf8"),
  );
  manifest.bundle.name = unsafe;
  manifest.bundle.description = unsafe + "\rSECOND\r\nTHIRD\tTAB";
  writeFileSync(join(bundle.folder, "manifest.json"), JSON.stringify(manifest));
  assert.equal(await h.run(["bundle", "build", bundle.folder]), 0, h.output());
  for (const args of [
    ["bundle", "list"],
    ["bundle", "inspect", bundle.id],
  ]) {
    h.reset();
    assert.equal(await h.run(args), 0, h.output());
    assert.doesNotMatch(h.output(), bad);
    assert.match(h.stdout(), /ABC/);
    assert.doesNotMatch(h.stdout(), /example\.com|31m/);
  }
  assert.match(h.stdout(), /SECOND\nTHIRD\tTAB/);
  h.reset();
  assert.equal(await h.run(["bundle", "inspect", bundle.id, "--json"]), 0);
  assert.doesNotMatch(h.stdout(), bad);
  assert.equal(JSON.parse(h.stdout()).name, unsafe);
  assert.equal(JSON.parse(h.stdout()).description, manifest.bundle.description);
});

test("m10-audit-screen-control-bytes: parse errors screen stderr", async (t) => {
  const h = openHeadlessHarness(t);
  assert.equal(await h.run(["UNKNOWN" + unsafe]), 1);
  assert.doesNotMatch(h.stderr(), bad);
  assert.match(h.stderr(), /UNKNOWNABC\n/);
});

function scriptedRun(t: TestContext) {
  const h = openHeadlessHarness(t);
  const inner = h.clients.projectionPort;
  const snapshot: App.RunSnapshot = {
    family: "run",
    runId: "run-1",
    result: {
      found: true,
      run: {
        runId: "run-1",
        bundle: {
          id: "dev.test",
          version: "1.0.0",
          name: unsafe,
          digest: "abc",
        },
        workspacePath: unsafe,
        launchedAt: "2026-10-08T00:00:00Z",
        state: "running",
        liveness: { state: "live-here", ownerPid: 1 },
        progress: [{ id: "step", kind: "command", status: "running" }],
        position: 0,
        timeline: [{ at: "T1", event: "request-raised", detail: unsafe }],
        outputs: [
          {
            name: "log",
            type: "text",
            reference: {
              runId: "run-1",
              artifactName: "log",
              versionId: "v1",
              type: "text",
            },
          },
        ],
        sessions: [
          {
            session: "s",
            name: "Conversation",
            availability: "open",
            transcriptPage: {
              type: "transcript-page",
              runId: "run-1",
              session: "s",
            },
            transcriptExport: {
              type: "transcript-export",
              runId: "run-1",
              session: "s",
            },
          },
        ],
        actionOffers: [],
      },
    },
  };
  function open(selector: {
    readonly family: "session-history";
    readonly runId: string;
    readonly session: string;
  }): App.OpenedProjection<App.SessionHistorySnapshot>;
  function open(selector: {
    readonly family: "preferences";
  }): App.OpenedProjection<App.PreferencesSnapshot>;
  function open(selector: {
    readonly family: "workspace";
  }): App.OpenedProjection<App.WorkspaceSnapshot>;
  function open(selector: {
    readonly family: "operation";
    readonly operationId: string;
  }): App.OpenedProjection<App.OperationSnapshot>;
  function open(selector: {
    readonly family: "bundle-catalog";
    readonly focus: App.BundleFocusSelector;
  }): App.OpenedProjection<App.BundleFocusSnapshot>;
  function open(selector: {
    readonly family: "bundle-catalog";
    readonly focus?: undefined;
  }): App.OpenedProjection<App.BundleCatalogSnapshot>;
  function open(selector: {
    readonly family: "harness-catalog";
    readonly focus: App.HarnessFocusSelector;
  }): App.OpenedProjection<App.HarnessFocusSnapshot>;
  function open(selector: {
    readonly family: "harness-catalog";
    readonly focus?: undefined;
  }): App.OpenedProjection<App.HarnessCatalogSnapshot>;
  function open(selector: {
    readonly family: "launch-preparation";
    readonly draft: App.LaunchRunInput;
  }): App.OpenedProjection<App.LaunchPreparationSnapshot>;
  function open(selector: {
    readonly family: "run";
    readonly runId: string;
    /** Explicitly request Model choice Offers through bounded qualification.
     * Ordinary Run reads never prepare or close a Harness. */
    readonly prepareModelChoice?: true;
  }): App.OpenedProjection<App.RunSnapshot>;
  function open(selector: {
    readonly family: "run-list";
    readonly resumable?: boolean;
    readonly before?: string;
  }): App.OpenedProjection<App.RunListSnapshot>;
  function open(selector: App.ProjectionSelector): App.OpenedProjection;

  function open(selector: App.ProjectionSelector): App.OpenedProjection {
    if (selector.family !== "run") return inner.openProjection(selector);
    return {
      snapshot,
      catchUp: "fresh",
      updates: (async function* () {
        yield {
          kind: "live",
          overlay: {
            runId: "run-1",
            generation: 1,
            phase: "awaiting-approval",
            outstanding: [
              {
                requestId: "r",
                tool: unsafe,
                input: unsafe + "\rSECOND\r\nTHIRD\tTAB",
                decisions: ["allow", "deny"],
              },
            ],
            offers: [],
          },
        } satisfies App.ProjectionUpdate<App.RunSnapshot>;
      })(),
      close() {},
    };
  }
  const content = unsafe + "\rSECOND\r\nTHIRD\tTAB";
  const port: App.ProjectionPort = {
    ...inner,
    openProjection: open,
    readResource: () => ({ found: true, type: "text", content }),
    readTranscript: (ref) => ({
      found: true,
      type: ref.type,
      entries: [{ id: "entry", session: "s", role: "assistant", content }],
    }),
  };
  return {
    ...h,
    content,
    snapshot,
    port,
    run: (args: string[]) =>
      runHeadless({ ...h.clients, projectionPort: port }, args, h.io),
  };
}

test("m10-audit-screen-control-bytes: Run show and ephemeral Request output screen all displayed text", async (t) => {
  const h = scriptedRun(t);
  assert.equal(await h.run(["run", "show", "run-1"]), 0);
  assert.doesNotMatch(h.output(), bad);
  assert.match(h.stdout(), /tool: ABC/);
  assert.match(h.stdout(), /input: ABC\n{2}SECOND\nTHIRD\tTAB/);
  assert.match(h.stdout(), /name: ABC|ABC/);
  assert.doesNotMatch(h.stdout(), /example\.com|31m/);
  h.reset();
  assert.equal(await h.run(["run", "show", "run-1", "--json"]), 0);
  assert.doesNotMatch(h.stdout(), bad);
  assert.deepEqual(JSON.parse(h.stdout()), h.snapshot);
});

for (const args of [
  ["run", "read", "run-1/log"],
  ["run", "read", "run-1/s", "--transcript"],
]) {
  test(`m10-audit-screen-control-bytes: ${args.join(" ")} screens Resource text and preserves escaped JSON`, async (t) => {
    const h = scriptedRun(t);
    assert.equal(await h.run(args), 0);
    assert.doesNotMatch(h.stdout(), bad);
    assert.match(h.stdout(), /ABC\n{2}SECOND\nTHIRD\tTAB/);
    h.reset();
    assert.equal(await h.run([...args, "--json"]), 0);
    assert.doesNotMatch(h.stdout(), bad);
    const value = JSON.parse(h.stdout());
    assert.equal(
      args.includes("--transcript")
        ? value.page.entries[0].content
        : value.content,
      h.content,
    );
  });
}

test("m10-audit-screen-control-bytes: CLI host, startup notices and refusal fields screen at the same output boundary", async (t) => {
  const h = scriptedRun(t);
  const notice: App.Problem = {
    code: "notice",
    explanation: unsafe,
    remediation: unsafe,
    possibleEffects: "none",
  };
  assert.equal(
    await runHeadlessCli(["run", "show", "run-1"], h.io, "1.0.0", (run) =>
      run({ ...h.clients, projectionPort: h.port, startupNotices: [notice] }),
    ),
    0,
  );
  assert.doesNotMatch(h.output(), bad);
  assert.match(h.stderr(), /Notice \[notice\]: ABC/);
  assert.match(h.stderr(), /Remediation: ABC/);
});
