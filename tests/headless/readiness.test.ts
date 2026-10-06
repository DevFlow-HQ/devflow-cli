import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  HarnessCatalogSnapshot,
  HarnessFocusSnapshot,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  ObserverEnd,
  OpenedProjection,
  OperationSnapshot,
  Problem,
  ProjectionPort,
  ProjectionSelector,
  ProjectionSnapshot,
  ProjectionUpdate,
  RunListSnapshot,
  RunSnapshot,
  Submission,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { runHeadless } from "../../src/headless/headless.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";

type Script<S extends ProjectionSnapshot> = {
  readonly snapshot: S;
  readonly updates: readonly ProjectionUpdate<S>[];
};

const unresolved: LaunchRunInput = {
  bundle: { id: "test.readiness", version: "1.0.0" },
  harness: "codex",
  launchInputs: {},
};
const assessing: LaunchPreparationSnapshot = {
  family: "launch-preparation",
  status: "assessing",
  draft: unresolved,
  findings: [],
  actionOffers: [],
};
const offeredDraft: LaunchRunInput = {
  ...unresolved,
  requestedModel: "resolved-model",
  requestedEffort: "high",
};
const ready: LaunchPreparationSnapshot = {
  ...assessing,
  status: "ready",
  draft: {
    ...unresolved,
    modelChoice: {
      model: "resolved-model",
      effort: "high",
      source: { kind: "reported" },
    },
  },
  actionOffers: [
    {
      action: "launch-run",
      draft: offeredDraft,
      trustRequired: false,
      consequence: "Launch the assessed draft.",
    },
  ],
};
const finding: Problem = {
  code: "model-not-supported",
  explanation: "The requested model is unavailable.",
  remediation: "Choose a supported model.",
  possibleEffects: "none",
};
const notReady: LaunchPreparationSnapshot = {
  ...assessing,
  status: "not-ready",
  findings: [finding],
};
const unchecked: HarnessFocusSnapshot = {
  family: "harness-catalog",
  view: "focus",
  selection: { id: "codex" },
  result: {
    found: true,
    harness: {
      id: "codex",
      name: "Codex",
      discovery: { state: "found", source: "path", description: "codex" },
      qualification: { state: "not-checked" },
      capabilities: [],
    },
  },
};
assert.ok(unchecked.result.found);
const qualified: HarnessFocusSnapshot = {
  ...unchecked,
  result: {
    found: true,
    harness: {
      ...unchecked.result.harness,
      qualification: {
        state: "qualified",
        observation: {
          executable: "codex",
          executableVersion: "1.0.0",
          platform: "linux",
          checkedAt: "2026-10-05T00:00:00.000Z",
        },
      },
    },
  },
};

// Legal Port scripts stop at their closed update. The fixture records handle
// disposal and refuses every submit so client readiness is tested independently
// of Application admission and Run execution.
function scriptedReadiness(
  t: TestContext,
  scripts: {
    launch?: readonly Script<LaunchPreparationSnapshot>[];
    harness?: readonly Script<HarnessFocusSnapshot>[];
  },
) {
  const h = openHeadlessHarness(t, { runSupport: false });
  const opened: ProjectionSelector[] = [];
  const closed: number[] = [];
  const submissions: Submission[] = [];
  let launchIndex = 0;
  let harnessIndex = 0;
  function view<S extends ProjectionSnapshot>(
    script: Script<S>,
  ): OpenedProjection<S> {
    const handle = opened.length;
    let disposed = false;
    return {
      snapshot: script.snapshot,
      catchUp: "fresh",
      updates: (async function* () {
        for (const update of script.updates) {
          assert.equal(disposed, false);
          yield update;
        }
      })(),
      close() {
        if (disposed) return;
        disposed = true;
        closed.push(handle);
      },
    };
  }
  function open(selector: {
    family: "preferences";
  }): OpenedProjection<
    import("../../src/application/projection-port.js").PreferencesSnapshot
  >;
  function open(selector: {
    family: "workspace";
  }): OpenedProjection<WorkspaceSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "operation" }>,
  ): OpenedProjection<OperationSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "bundle-catalog" }> & {
      focus: NonNullable<
        Extract<ProjectionSelector, { family: "bundle-catalog" }>["focus"]
      >;
    },
  ): OpenedProjection<BundleFocusSnapshot>;
  function open(selector: {
    family: "bundle-catalog";
    focus?: undefined;
  }): OpenedProjection<BundleCatalogSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "harness-catalog" }> & {
      focus: NonNullable<
        Extract<ProjectionSelector, { family: "harness-catalog" }>["focus"]
      >;
    },
  ): OpenedProjection<HarnessFocusSnapshot>;
  function open(selector: {
    family: "harness-catalog";
    focus?: undefined;
  }): OpenedProjection<HarnessCatalogSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "launch-preparation" }>,
  ): OpenedProjection<LaunchPreparationSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "session-history" }>,
  ): OpenedProjection<
    import("../../src/application/projection-port.js").SessionHistorySnapshot
  >;
  function open(
    selector: Extract<ProjectionSelector, { family: "run" }>,
  ): OpenedProjection<RunSnapshot>;
  function open(
    selector: Extract<ProjectionSelector, { family: "run-list" }>,
  ): OpenedProjection<RunListSnapshot>;
  function open(selector: ProjectionSelector): OpenedProjection;
  function open(selector: ProjectionSelector): OpenedProjection {
    assert.equal(
      closed.length,
      opened.length,
      "close the previous view before reopening",
    );
    opened.push(selector);
    if (selector.family === "launch-preparation") {
      const script = scripts.launch?.[launchIndex++];
      assert.ok(script, "unexpected launch reopen");
      return view(script);
    }
    if (selector.family === "harness-catalog" && selector.focus !== undefined) {
      const script = scripts.harness?.[harnessIndex++];
      assert.ok(script, "unexpected Harness reopen");
      return view(script);
    }
    throw new Error(`Unexpected Projection ${selector.family}`);
  }
  const port: ProjectionPort = {
    ...h.clients.projectionPort,
    openProjection: open,
    submit(submission) {
      submissions.push(submission);
      return { admitted: false, problem: finding };
    },
  };
  return {
    ...h,
    opened,
    closed,
    submissions,
    run: (args: string[]) =>
      runHeadless({ ...h.clients, projectionPort: port }, args, h.io),
  };
}

const launchArgs = [
  "run",
  "launch",
  "test.readiness@1.0.0",
  "--harness",
  "codex",
];

test("headless-launch-readiness-observer-end: lagged assessment waits for the exact ready Offer draft", async (t) => {
  const h = scriptedReadiness(t, {
    launch: [
      {
        snapshot: assessing,
        updates: [{ kind: "closed", reason: "observer-lagged" }],
      },
      {
        snapshot: assessing,
        updates: [
          { kind: "durable", snapshot: assessing },
          { kind: "durable", snapshot: ready },
        ],
      },
    ],
  });
  assert.equal(await h.run(launchArgs), 1); // Authoritative admission refuses.
  assert.equal(h.opened.length, 2);
  assert.deepEqual(h.closed, [1, 2]);
  assert.equal(h.submissions.length, 1);
  const submission = h.submissions[0];
  assert.ok(submission?.operation === "launch-run");
  assert.equal(submission.input, offeredDraft);
  assert.deepEqual(submission.input, {
    bundle: { id: "test.readiness", version: "1.0.0" },
    harness: "codex",
    launchInputs: {},
    requestedModel: "resolved-model",
    requestedEffort: "high",
  });
  assert.equal(h.stdout(), "");
  assert.equal(
    h.stderr(),
    "Error [model-not-supported]: The requested model is unavailable.\nRemediation: Choose a supported model.\n",
  );
});

test("headless-harness-readiness-observer-end: lagged qualification waits past not-checked updates", async (t) => {
  const h = scriptedReadiness(t, {
    harness: [
      {
        snapshot: unchecked,
        updates: [{ kind: "closed", reason: "observer-lagged" }],
      },
      {
        snapshot: unchecked,
        updates: [
          { kind: "durable", snapshot: unchecked },
          { kind: "durable", snapshot: qualified },
        ],
      },
    ],
  });
  assert.equal(await h.run(["harness", "inspect", "codex", "--json"]), 0);
  assert.equal(h.opened.length, 2);
  assert.deepEqual(h.closed, [1, 2]);
  assert.deepEqual(h.submissions, []);
  assert.ok(qualified.result.found);
  assert.deepEqual(JSON.parse(h.stdout()), qualified.result.harness);
  assert.equal(h.stderr(), "");
});

test("headless-launch-readiness-observer-end: lagged assessment can settle not-ready in text and JSON", async (t) => {
  for (const json of [false, true]) {
    const h = scriptedReadiness(t, {
      launch: [
        {
          snapshot: assessing,
          updates: [{ kind: "closed", reason: "observer-lagged" }],
        },
        {
          snapshot: assessing,
          updates: [{ kind: "durable", snapshot: notReady }],
        },
      ],
    });
    assert.equal(await h.run([...launchArgs, ...(json ? ["--json"] : [])]), 1);
    assert.deepEqual(h.closed, [1, 2]);
    assert.deepEqual(h.submissions, []);
    if (json) {
      assert.deepEqual(JSON.parse(h.stdout()), {
        status: "not-ready",
        findings: [finding],
      });
      assert.equal(h.stderr(), "");
    } else {
      assert.equal(h.stdout(), "");
      assert.equal(
        h.stderr(),
        "Error [model-not-supported]: The requested model is unavailable.\nRemediation: Choose a supported model.\n",
      );
    }
  }
});

const terminalEnds: readonly (ObserverEnd | undefined)[] = [
  "subject-gone",
  "temporarily-unavailable",
  "application-shutdown",
  undefined,
];
for (const reason of terminalEnds) {
  for (const json of [false, true]) {
    const updates: readonly ProjectionUpdate<never>[] =
      reason === undefined ? [] : [{ kind: "closed", reason }];
    test(`headless-launch-readiness-observer-end: ${reason ?? "stream ended"} refuses before submit (${json ? "JSON" : "text"})`, async (t) => {
      const h = scriptedReadiness(t, {
        launch: [{ snapshot: assessing, updates }],
      });
      assert.equal(
        await h.run([...launchArgs, ...(json ? ["--json"] : [])]),
        1,
      );
      assert.equal(h.opened.length, 1);
      assert.deepEqual(h.closed, [1]);
      assert.deepEqual(h.submissions, []);
      const explanation = `Launch preparation observation ended before assessment completed (${reason ?? "stream ended"}).`;
      if (json) {
        assert.deepEqual(JSON.parse(h.stdout()), {
          code: "launch-observation-ended",
          explanation,
          remediation: "Try the launch again.",
          possibleEffects: "none",
        });
        assert.equal(h.stderr(), "");
      } else {
        assert.equal(h.stdout(), "");
        assert.equal(
          h.stderr(),
          `Error [launch-observation-ended]: ${explanation}\nRemediation: Try the launch again.\n`,
        );
      }
    });
    test(`headless-harness-readiness-observer-end: ${reason ?? "stream ended"} fails inspection (${json ? "JSON" : "text"})`, async (t) => {
      const h = scriptedReadiness(t, {
        harness: [{ snapshot: unchecked, updates }],
      });
      assert.equal(
        await h.run([
          "harness",
          "inspect",
          "codex",
          ...(json ? ["--json"] : []),
        ]),
        1,
      );
      assert.equal(h.opened.length, 1);
      assert.deepEqual(h.closed, [1]);
      assert.deepEqual(h.submissions, []);
      const explanation = `Harness codex observation ended before qualification completed (${reason ?? "stream ended"}).`;
      if (json) {
        assert.deepEqual(JSON.parse(h.stdout()), {
          code: "harness-observation-ended",
          explanation,
          remediation: "Try the inspection again.",
          possibleEffects: "none",
        });
        assert.equal(h.stderr(), "");
      } else {
        assert.equal(h.stdout(), "");
        assert.equal(
          h.stderr(),
          `Error [harness-observation-ended]: ${explanation}\nRemediation: Try the inspection again.\n`,
        );
      }
    });
  }
}

test("headless-launch-readiness-observer-end: already-settled and reopened ready drafts preserve notices and locks", async (t) => {
  const settled: LaunchPreparationSnapshot = {
    ...ready,
    draft: {
      ...ready.draft,
      preferenceNotice:
        "The saved choice was unavailable; using the reported settings.",
      modelChoice: {
        model: "resolved-model",
        effort: "high",
        source: { kind: "reported" },
        effortLock: { effort: "high", source: "CLAUDE_CODE_EFFORT_LEVEL" },
      },
    },
  };
  for (const recover of [false, true]) {
    const h = scriptedReadiness(t, {
      launch: [
        ...(recover
          ? [
              {
                snapshot: assessing,
                updates: [
                  {
                    kind: "closed",
                    reason: "observer-lagged",
                  } satisfies ProjectionUpdate<LaunchPreparationSnapshot>,
                ],
              },
            ]
          : []),
        {
          snapshot: settled,
          updates: [{ kind: "closed", reason: "application-shutdown" }],
        },
      ],
    });
    assert.equal(await h.run([...launchArgs, "--json"]), 1);
    assert.equal(h.opened.length, recover ? 2 : 1);
    assert.deepEqual(h.closed, recover ? [1, 2] : [1]);
    assert.equal(h.submissions.length, 1);
    const submission = h.submissions[0];
    assert.ok(submission?.operation === "launch-run");
    assert.equal(submission.input, offeredDraft);
    assert.deepEqual(JSON.parse(h.stdout()), finding);
    assert.equal(
      h.stderr(),
      "The saved choice was unavailable; using the reported settings.\nLocked by CLAUDE_CODE_EFFORT_LEVEL. Change that setting outside Secant.\n",
    );
  }
});

test("headless-launch-readiness-observer-end: settled not-ready and missing ready Offer never submit", async (t) => {
  for (const snapshot of [notReady, { ...ready, actionOffers: [] }]) {
    const h = scriptedReadiness(t, { launch: [{ snapshot, updates: [] }] });
    assert.equal(await h.run([...launchArgs, "--json"]), 1);
    assert.deepEqual(h.submissions, []);
    assert.deepEqual(h.closed, [1]);
    assert.deepEqual(
      JSON.parse(h.stdout()),
      snapshot.status === "not-ready"
        ? { status: "not-ready", findings: [finding] }
        : {
            code: "launch-offer-missing",
            explanation:
              "The settled launch assessment has no ready launch Offer.",
            remediation: "Try the launch again; if it persists, report it.",
            possibleEffects: "none",
          },
    );
  }
});

test("headless-harness-readiness-observer-end: settled negative qualifications remain successful inspections", async (t) => {
  assert.ok(qualified.result.found);
  const harness = qualified.result.harness;
  assert.ok(harness.qualification.state === "qualified");
  const snapshots: HarnessFocusSnapshot[] = [
    qualified,
    {
      ...qualified,
      result: {
        found: true,
        harness: {
          ...harness,
          qualification: {
            ...harness.qualification,
            state: "qualified-with-limits",
          },
        },
      },
    },
    {
      ...unchecked,
      result: {
        found: true,
        harness: {
          ...harness,
          qualification: {
            state: "not-ready",
            checkedAt: "2026-10-05T00:00:00.000Z",
          },
          harnessDefaults: {
            kind: "unavailable",
            reason: "Qualification failed.",
          },
          unavailable: finding,
        },
      },
    },
  ];
  for (const snapshot of snapshots) {
    for (const immediate of [false, true]) {
      const h = scriptedReadiness(t, {
        harness: [
          {
            snapshot: immediate ? snapshot : unchecked,
            updates: immediate ? [] : [{ kind: "durable", snapshot }],
          },
        ],
      });
      assert.equal(await h.run(["harness", "inspect", "codex", "--json"]), 0);
      assert.ok(snapshot.result.found);
      assert.deepEqual(JSON.parse(h.stdout()), snapshot.result.harness);
      assert.equal(h.stderr(), "");
      assert.deepEqual(h.closed, [1]);
      assert.deepEqual(h.submissions, []);
    }
  }
});

test("headless-harness-readiness-observer-end: a missing Harness stays a refusal before or after qualification", async (t) => {
  const missing: HarnessFocusSnapshot = {
    ...unchecked,
    result: { found: false, problem: finding },
  };
  for (const immediate of [false, true]) {
    const h = scriptedReadiness(t, {
      harness: [
        {
          snapshot: immediate ? missing : unchecked,
          updates: immediate ? [] : [{ kind: "durable", snapshot: missing }],
        },
      ],
    });
    assert.equal(await h.run(["harness", "inspect", "codex", "--json"]), 1);
    assert.deepEqual(JSON.parse(h.stdout()), finding);
    assert.deepEqual(h.closed, [1]);
    assert.deepEqual(h.submissions, []);
  }
});

test("headless readiness stops if recovery subsequently loses the Application", async (t) => {
  const h = scriptedReadiness(t, {
    launch: [
      {
        snapshot: assessing,
        updates: [{ kind: "closed", reason: "observer-lagged" }],
      },
      {
        snapshot: assessing,
        updates: [{ kind: "closed", reason: "application-shutdown" }],
      },
    ],
  });
  assert.equal(await h.run(launchArgs), 1);
  assert.equal(h.opened.length, 2);
  assert.deepEqual(h.closed, [1, 2]);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.stdout(), "");
  assert.equal(
    h.stderr(),
    "Error [launch-observation-ended]: Launch preparation observation ended before assessment completed (application-shutdown).\nRemediation: Try the launch again.\n",
  );
});
