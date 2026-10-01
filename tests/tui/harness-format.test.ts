import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessFocus,
  HarnessObservationView,
  HarnessQualificationView,
} from "../../src/application/projection-port.js";
import { harnessFocusStatus, harnessModelLine } from "../../src/tui/tui.js";

// The Harness catalog row's model line (#285): an unqualified Harness has not
// shown its models yet, a qualified one names what it observed, and a qualified
// Harness without model selection gets no line at all. Start a Run's focus
// status (#286): a focus not yet opened or still `not-checked` is being checked,
// and a settled one reads as its catalog row does.

const OBSERVATION: HarnessObservationView = {
  executable: "PATH name 'codex' -> /tools/codex",
  executableVersion: "1.2.3",
  platform: "linux",
  checkedAt: "2026-09-22T00:00:00.000Z",
};
const QUALIFIED: HarnessQualificationView = {
  state: "qualified",
  observation: OBSERVATION,
};
const LIST = { kind: "list", models: ["gpt-5", "gpt-5-mini"] } as const;

test("an unqualified Harness has not observed its models, whatever it declares", () => {
  const unqualified: HarnessQualificationView[] = [
    { state: "not-checked" },
    { state: "not-ready", checkedAt: "2026-09-22T00:00:00.000Z" },
  ];
  for (const qualification of unqualified) {
    assert.equal(
      harnessModelLine(qualification, undefined),
      "Models not yet observed",
    );
    assert.equal(
      harnessModelLine(qualification, { kind: "free-text" }),
      "Models not yet observed",
    );
    assert.equal(
      harnessModelLine(qualification, LIST),
      "Models not yet observed",
    );
  }
});

test("a qualified Harness counts a model list, with or without limits", () => {
  assert.equal(harnessModelLine(QUALIFIED, LIST), "2 models observed");
  assert.equal(
    harnessModelLine(
      { state: "qualified-with-limits", observation: OBSERVATION },
      { kind: "list", models: [] },
    ),
    "0 models observed",
  );
});

test("a qualified free-text Harness reads as free-text model entry", () => {
  assert.equal(
    harnessModelLine(QUALIFIED, { kind: "free-text" }),
    "Free-text model entry",
  );
});

test("a qualified Harness without model selection shows no model line", () => {
  assert.equal(harnessModelLine(QUALIFIED, undefined), undefined);
});

function focusWith(
  qualification: HarnessQualificationView,
  discovery: HarnessFocus["discovery"] = {
    state: "found",
    source: "path",
    description: "PATH name 'codex' -> /tools/codex",
  },
): HarnessFocus {
  return {
    id: "codex",
    name: "Codex",
    discovery,
    qualification,
    capabilities: [],
  };
}

test("a focus not yet opened or still not checked is checking its models", () => {
  assert.equal(harnessFocusStatus(undefined), "Checking models…");
  assert.equal(
    harnessFocusStatus(focusWith({ state: "not-checked" })),
    "Checking models…",
  );
});

test("a settled focus reads as its catalog row does", () => {
  assert.equal(harnessFocusStatus(focusWith(QUALIFIED)), "Qualified");
  assert.equal(
    harnessFocusStatus(
      focusWith({ state: "qualified-with-limits", observation: OBSERVATION }),
    ),
    "Qualified with limits",
  );
  assert.equal(
    harnessFocusStatus(
      focusWith({ state: "not-ready", checkedAt: OBSERVATION.checkedAt }),
    ),
    "Not ready",
  );
  assert.equal(
    harnessFocusStatus(
      focusWith(
        { state: "not-ready", checkedAt: OBSERVATION.checkedAt },
        {
          state: "not-found",
          searched: ["/usr/bin"],
          executableEnvironmentVariable: "SECANT_CODEX",
        },
      ),
    ),
    "Unavailable · not found on PATH",
  );
});
