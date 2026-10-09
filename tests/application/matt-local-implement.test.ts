import { readRun, findOffer, requireOffer } from "./run-test-helpers.js";
import { MATT_FOLDER, wireMatt } from "./matt-wiring.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { type Wiring } from "../../src/composition/main.js";
import type { HarnessAdapter } from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";

import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
  type FakeTurnScript,
} from "../harness/fake-adapter.js";
import { call } from "../helpers/agentCompletion.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

// [matt-local-implement] The maintained Matt Bundle implements one Local ticket per
// fresh Session (#224), over the shared Projection Port with the real Application
// and Run Store on a temporary home and a fake Harness under each v1 Harness
// selection. After the tickets are published, every implementation iteration opens
// a fresh Session whose Entry Turn tells the agent to read the Local tracker again,
// choose one unblocked ready ticket and state its path, and follow the original
// implement folder with tdd, code-review and codebase-design beside it. Questions
// stay in that Session; Continue opens the next one without closing a ticket, and
// the human can end the stage when the agent makes no call. Secant never edits a ticket file or
// keeps a ticket list, and a no-work, interrupted or lost Turn never moves on to
// another ticket.

const MATT_ID = "dev.secant.matt-front";
const IDEA = "Add a dark-mode toggle that follows me across devices.";
const RECEIPT_LINE =
  /Write the required output "spec-ref" as UTF-8 text to (.+) before you finish;/;
const TICKETS_RECEIPT_LINE =
  /Write the required output "tickets-ref" as UTF-8 text to (.+) before you finish;/;
const IMPLEMENT_HEADING = "# Implement one ticket";
const IMPLEMENTATION_SKILLS = [
  "implement",
  "tdd",
  "code-review",
  "codebase-design",
] as const;
const TICKETS = [
  ["01-store-preference.md", "None (can start immediately)"],
  ["02-toggle-ui.md", "01"],
] as const;

type HarnessId = "claude-code" | "codex";
type TurnScript = FakeScript["turns"][number];

function completed(content: string): TurnScript {
  return {
    events: [{ kind: "assistant-content", content }],
    result: {
      kind: "completed",
      detail: {
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "detached", coordinate: { opaque: "coord" } },
      },
    },
  };
}

const BLOCKS: TurnScript = { block: true, result: completed("unused").result };

const LOST: TurnScript = {
  result: {
    kind: "lost",
    detail: {
      unknown: "completion",
      lastObservation: "the producer closed before a result",
      session: { state: "detached", coordinate: { opaque: "coord" } },
    },
  },
};

/** An Adapter playing the whole Matt agent. Planning Turns write the Local spec
 *  and tickets as the maintained prompts ask. Each implementation Turn plays the
 *  next queued script (a completed Turn when the queue is empty), after running
 *  the queued action that stands in for the agent's own work in the tracker. */
function mattAgent(
  harness: HarnessId,
  planningCalls = false,
  tickets: readonly (readonly [string, string])[] = TICKETS,
) {
  const granted: (string | undefined)[] = [];
  const turns: { text: string; session: string }[] = [];
  const implementation: { script: TurnScript; act?: (area: string) => void }[] =
    [];
  const adapter: HarnessAdapter = ownPreparations({
    async prepare(options) {
      granted.push(options.writableDirectory);
      // The fake reads its scripted Turns by index as each Turn starts, so this
      // prepare's list grows with the Turns it actually serves.
      const served: FakeTurnScript[] = [];
      const prepared = await createFake({
        profile: fakeHarnessProfile({
          harness: harness === "codex" ? "codex" : "Claude Code",
          executable: harness === "codex" ? "codex" : "fake-claude",
          agentCalls: {
            available: true,
            evidence: "Scripted agent calls.",
          },
          steer: { available: harness === "codex", evidence: "scripted fake" },
        }),
        turns: served,
      })().prepare(options);
      if (!prepared.ok) return prepared;
      const inner = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: inner.profile,
          readDefaults: () => inner.readDefaults(),
          startTurn(request) {
            const text = request.input.text;
            turns.push({ text, session: request.session });
            const area = options.writableDirectory;
            assert.ok(area, "every Matt Turn is granted the working area");
            const specReceipt = RECEIPT_LINE.exec(text)?.[1];
            if (specReceipt !== undefined) {
              const spec = join(area, "spec.md");
              writeFileSync(spec, "# Dark mode\n");
              writeFileSync(specReceipt, `${spec}\n`);
            }
            const ticketsReceipt = TICKETS_RECEIPT_LINE.exec(text)?.[1];
            if (ticketsReceipt !== undefined) {
              const issues = join(area, "issues");
              mkdirSync(issues, { recursive: true });
              for (const [file, blockedBy] of tickets) {
                writeFileSync(
                  join(issues, file),
                  `# ${file}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ready-for-agent\n`,
                );
              }
              writeFileSync(ticketsReceipt, `${issues}\n`);
            }
            const next = request.session.startsWith("implement")
              ? implementation.shift()
              : undefined;
            next?.act?.(area);
            const planning =
              planningCalls &&
              (text.startsWith("# Grill my idea") ||
                text.startsWith("# Plan the tickets"))
                ? {
                    ...completed("Approved in conversation."),
                    agentCalls: [call("Approved in conversation.")],
                  }
                : completed("ok");
            served.push(next?.script ?? planning);
            return inner.startTurn(request);
          },
          close: () => inner.close(),
        },
      };
    },
  });
  return { adapter, granted, turns, implementation };
}

function submit(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
): void {
  const admission = wired.projectionPort.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
}

async function settle(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
): Promise<void> {
  submit(wired, submission);
  const outcome = await awaitSettled(
    wired.projectionPort,
    submission.operationId,
  );
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

async function awaitInterruptOffer(wired: Wiring, runId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const interrupt = findOffer(
      readRun(wired.projectionPort, runId),
      "interrupt-turn",
    );
    if (interrupt !== undefined) return interrupt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the implementation Turn never exposed its interrupt Offer");
}

/** Launch, end the grill, choose Local, and take the ticket review up to the
 *  approving End Step, whose publish Turn is followed by the first implementation
 *  Entry Turn. The End Step Operation is submitted, not awaited: it settles only
 *  once that Entry Turn does. */
async function publishLocalTickets(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
): Promise<string> {
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: MATT_ID },
      launchInputs: { idea: IDEA },
      trustDigest: digest,
      harness,
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted && admission.runId);
  const runId = admission.runId;
  await awaitSettled(wired.projectionPort, "op-launch");
  await settle(wired, {
    operationId: "op-end-grill",
    operation: "end-interactive-step",
    input: { runId, stepId: "grill" },
  });
  const gate = readRun(wired.projectionPort, runId).pendingGate?.gate;
  assert.equal(gate?.stepId, "choose-tracker");
  await settle(wired, {
    operationId: "op-tracker",
    operation: "answer-human-gate",
    input: { runId, gate: gate!, text: "Local" },
  });
  submit(wired, {
    operationId: "op-approve-tickets",
    operation: "end-interactive-step",
    input: { runId, stepId: "plan-tickets" },
  });
  return runId;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Every file's bytes under `dir`, keyed by relative path. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    filesUnder(dir).map((file) => [
      file,
      readFileSync(join(dir, file), "utf8"),
    ]),
  );
}

/** The prompt names the skill's SKILL.md by a bundled path whose folder is the
 *  original one, complete and byte-identical. */
function assertBundledSkill(prompt: string, skill: string): void {
  const match = new RegExp(`(\\S*[\\\\/]${skill}[\\\\/]SKILL\\.md)`).exec(
    prompt,
  );
  assert.ok(match, prompt);
  const bundled = dirname(match[1]!);
  const source = join(MATT_FOLDER, "skills", skill);
  assert.deepEqual(filesUnder(bundled), filesUnder(source));
  for (const file of filesUnder(source)) {
    assert.deepEqual(
      readFileSync(join(bundled, file)),
      readFileSync(join(source, file)),
    );
  }
}

/** The working area's tracker files, without the Store-named receipt directory. */
function trackerFiles(area: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(area)).filter(
      ([file]) => !file.startsWith(".receipts"),
    ),
  );
}

/** The durable Turns, read through an owner once nothing is live in-process. */
function durableTurns(wired: Wiring, runId: string) {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    return owner.turns().map((turn) => ({
      origin: turn.origin,
      session: turn.session,
      resultKind: turn.resultKind,
    }));
  } finally {
    owner.close();
  }
}

for (const harness of ["claude-code", "codex"] as const) {
  test(`m12-wiring-test-helpers: [matt-local-implement] [${harness}] each ticket gets a fresh Session that reads the Local tracker; questions stay in it, and Continue opens the next without closing a ticket (#224)`, async (t) => {
    const agent = mattAgent(harness);
    // The first ticket's agent marks it done in its own file, as the prompt asks.
    agent.implementation.push({
      script: completed("I chose issues/01-store-preference.md."),
      act: (area) =>
        writeFileSync(
          join(area, "issues", TICKETS[0][0]),
          `# ${TICKETS[0][0]}\n\n**Blocked by:** ${TICKETS[0][1]}\n\n**Status:** done\n`,
        ),
    });
    const { wired, workspace, digest } = wireMatt(t, {
      harness,
      adapter: agent.adapter,
    });
    const runId = await publishLocalTickets(wired, digest, harness);
    await awaitSettled(wired.projectionPort, "op-approve-tickets");
    const area = agent.granted.at(-1)!;
    const issues = join(area, "issues");

    // Publishing leads straight into the implementation stage's first Entry Turn,
    // in a fresh Session of its own, and the Run rests there for the human.
    const first = readRun(wired.projectionPort, runId);
    assert.equal(first.state, "blocked", JSON.stringify(first.progress));
    assert.deepEqual(
      first.progress.map((step) => [step.id, step.status]),
      [
        ["grill", "succeeded"],
        ["choose-tracker", "succeeded"],
        ["write-spec", "succeeded"],
        ["plan-tickets", "succeeded"],
        ["publish-tickets", "succeeded"],
        ["implement", "blocked"],
      ],
    );
    const entry = agent.turns.at(-1)!;
    assert.ok(entry.text.startsWith(IMPLEMENT_HEADING), entry.text);
    assert.notEqual(entry.session, "spec");
    // The prompt names the tracker, the spec, and the exact Local directories, and
    // asks for one unblocked ready ticket stated by its path before any work.
    assert.ok(entry.text.includes("the tracker I chose: Local."), entry.text);
    assert.ok(entry.text.includes(join(area, "spec.md")), entry.text);
    assert.ok(entry.text.includes(issues), entry.text);
    assert.ok(entry.text.includes(`\`${area}\``), entry.text);
    assert.match(entry.text, /Read the tracker now/);
    assert.match(entry.text, /Choose exactly one of them/);
    assert.match(
      entry.text,
      /Never choose a ticket with an\s+unfinished blocker/,
    );
    assert.match(entry.text, /absolute path/);
    assert.match(
      entry.text,
      /Update the chosen ticket's status in the tracker/,
    );
    for (const skill of IMPLEMENTATION_SKILLS) {
      assertBundledSkill(entry.text, skill);
    }
    // At the Turn boundary: a question, Continue, or End Stage — never End Step.
    assert.ok(requireOffer(first, "send-interactive-turn"));
    assert.match(
      requireOffer(first, "continue-repeat").consequence,
      /does not close the ticket/,
    );
    assert.match(
      requireOffer(first, "end-stage").consequence,
      /Secant has not checked the tracker/,
    );
    assert.equal(findOffer(first, "end-interactive-step"), undefined);

    // A later question goes verbatim into the same ticket Session.
    await settle(wired, {
      operationId: "op-question",
      operation: "send-interactive-turn",
      input: { runId, stepId: "implement", text: "Which test covers this?" },
    });
    await awaitRunRest(wired.projectionPort, runId);
    assert.deepEqual(agent.turns.at(-1), {
      text: "Which test covers this?",
      session: entry.session,
    });
    assert.equal(readRun(wired.projectionPort, runId).state, "blocked");
    const afterFirst = trackerFiles(area);
    assert.match(
      afterFirst[join("issues", TICKETS[0][0])]!,
      /Status:\*\* done/,
    );

    // Continue opens a fresh Session whose Entry Turn reads the tracker again. The
    // tracker is exactly as the agent left it: Secant closed and moved nothing.
    await settle(wired, {
      operationId: "op-continue",
      operation: "continue-repeat",
      input: { runId, stepId: "implement" },
    });
    const second = agent.turns.at(-1)!;
    assert.equal(second.text, entry.text);
    assert.notEqual(second.session, entry.session);
    assert.notEqual(second.session, "spec");
    assert.deepEqual(trackerFiles(area), afterFirst);
    const iteration1 = readRun(wired.projectionPort, runId);
    assert.equal(iteration1.state, "blocked");
    assert.equal(iteration1.progress[iteration1.position]?.id, "implement");

    // The human fallback ends the Run with a human declaration.
    await settle(wired, {
      operationId: "op-end-stage",
      operation: "end-stage",
      input: { runId, stepId: "implement" },
    });
    const done = readRun(wired.projectionPort, runId);
    assert.equal(done.state, "succeeded");
    assert.equal(done.completion, "human-declared");
    assert.deepEqual(
      done.timeline
        .map((event) => event.event)
        .filter(
          (event) => event === "repeat-continued" || event === "stage-ended",
        ),
      ["repeat-continued", "stage-ended"],
    );
    // History keeps the spec, ticket planning, and implementation Sessions apart.
    assert.deepEqual(
      durableTurns(wired, runId).map((turn) => [turn.origin, turn.session]),
      [
        // The grill and spec Turns, then ticket review and publish.
        ["managed", "spec"],
        ["managed", "spec"],
        ["managed", "tickets"],
        ["managed", "tickets"],
        ["managed", entry.session],
        ["human", entry.session],
        ["managed", second.session],
      ],
    );
    // No ticket-status mirror: the outputs are still only the three references,
    // the working area holds only the agent's tracker files, and the Workspace
    // holds no planning file.
    assert.deepEqual(done.outputs.map((output) => output.name).sort(), [
      "spec-ref",
      "tickets-ref",
      "tracker",
    ]);
    assert.deepEqual(trackerFiles(area), afterFirst);
    assert.deepEqual(readdirSync(workspace), []);
  });
}

test("[matt-local-implement] a no-work, interrupted or lost implementation Turn stays in the same ticket Session; only the lost Turn halts (#224, #353)", async (t) => {
  const agent = mattAgent("claude-code");
  agent.implementation.push(
    // The Entry Turn runs until the human interrupts it.
    { script: BLOCKS },
    // The human's next Turn is lost.
    { script: LOST },
    // The agent then finds no ready ticket and says so.
    { script: completed("No ticket is ready: every open ticket is blocked.") },
  );
  const { wired, digest } = wireMatt(t, {
    harness: "claude-code",
    adapter: agent.adapter,
  });
  const runId = await publishLocalTickets(wired, digest, "claude-code");
  const area = agent.granted.at(-1)!;

  const interrupt = await awaitInterruptOffer(wired, runId);
  await settle(wired, {
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interrupt.turnId },
  });
  await awaitSettled(wired.projectionPort, "op-approve-tickets");
  const published = trackerFiles(area);
  const entry = agent.turns.at(-1)!;
  assert.ok(entry.text.startsWith(IMPLEMENT_HEADING), entry.text);

  // The interrupted Entry Turn waits at the ticket's Turn boundary, not re-sent.
  const atBoundary = (run: RunView) => {
    assert.equal(run.state, "blocked");
    assert.equal(run.progress[run.position]?.id, "implement");
    assert.ok(requireOffer(run, "continue-repeat"));
  };
  const sentBefore = agent.turns.length;
  atBoundary(readRun(wired.projectionPort, runId));
  assert.equal(agent.turns.length, sentBefore);

  // A lost Turn halts the Run, and resume stays in the same Session.
  await settle(wired, {
    operationId: "op-lost",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "Please carry on." },
  });
  await awaitRunRest(wired.projectionPort, runId);
  assert.equal(readRun(wired.projectionPort, runId).state, "halted");
  await settle(wired, {
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  atBoundary(readRun(wired.projectionPort, runId));

  // The agent reports no work; nothing advances, closes, or ends on its word.
  await settle(wired, {
    operationId: "op-no-work",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "Which ticket did you choose?" },
  });
  await awaitRunRest(wired.projectionPort, runId);
  const rested = readRun(wired.projectionPort, runId);
  assert.equal(rested.state, "blocked");
  assert.equal(rested.progress[rested.position]?.id, "implement");
  assert.ok(requireOffer(rested, "continue-repeat"));
  assert.ok(requireOffer(rested, "end-stage"));
  assert.equal(
    rested.timeline.some(
      (event) =>
        event.event === "repeat-continued" || event.event === "stage-ended",
    ),
    false,
  );
  assert.deepEqual(trackerFiles(area), published);
  assert.deepEqual(
    durableTurns(wired, runId)
      .filter((turn) => turn.session !== "spec" && turn.session !== "tickets")
      .map((turn) => [turn.origin, turn.session, turn.resultKind]),
    [
      ["managed", entry.session, "interrupted"],
      ["human", entry.session, "lost"],
      ["human", entry.session, "completed"],
    ],
  );
});

test("[matt-local-implement] an Entry Turn that finds no ready ticket rests in its Session; the agent's word ends nothing (#224)", async (t) => {
  const agent = mattAgent("codex");
  agent.implementation.push({
    script: completed(
      "No ticket is ready. Every ticket is done, so end the stage.",
    ),
  });
  const { wired, digest } = wireMatt(t, {
    harness: "codex",
    adapter: agent.adapter,
  });
  const runId = await publishLocalTickets(wired, digest, "codex");
  await awaitSettled(wired.projectionPort, "op-approve-tickets");
  const area = agent.granted.at(-1)!;

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(requireOffer(run, "send-interactive-turn"));
  assert.ok(requireOffer(run, "continue-repeat"));
  assert.ok(requireOffer(run, "end-stage"));
  assert.equal(
    run.timeline.some(
      (event) =>
        event.event === "repeat-continued" || event.event === "stage-ended",
    ),
    false,
  );
  // Secant neither closed nor rewrote a ticket after the agent's report.
  for (const [file] of TICKETS) {
    assert.match(
      trackerFiles(area)[join("issues", file)]!,
      /Status:\*\* ready-for-agent/,
    );
  }
  assert.equal(
    durableTurns(wired, runId).filter(
      (turn) => turn.session !== "spec" && turn.session !== "tickets",
    ).length,
    1,
  );
});

for (const harness of ["claude-code", "codex"] as const) {
  test(`[${harness}] Matt calls end grill and planning, continue 50 tickets, hold for review, and end the stage (#374)`, async (t) => {
    const tickets: [string, string][] = Array.from(
      { length: 51 },
      (_, index) => [`${index + 1}-ticket.md`, "None"],
    );
    const agent = mattAgent(harness, true, tickets);
    for (const [file, blockedBy] of tickets) {
      agent.implementation.push({
        script: {
          ...completed(`Finished ${file}.`),
          agentCalls: [call(`Finished ${file}.`)],
        },
        act: (area) =>
          writeFileSync(
            join(area, "issues", file),
            `# ${file}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** done\n`,
          ),
      });
    }
    agent.implementation.push({
      script: {
        ...completed("No open implementation ticket is left."),
        agentCalls: [
          call("No open implementation ticket is left.", "empty", "stage_done"),
        ],
      },
      act: (area) => {
        for (const [file] of tickets)
          assert.match(
            readFileSync(join(area, "issues", file), "utf8"),
            /Status:\*\* done/,
          );
      },
    });
    const { wired, workspace, digest } = wireMatt(t, {
      harness,
      adapter: agent.adapter,
    });
    const admission = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: {
        bundle: { id: MATT_ID },
        launchInputs: { idea: IDEA },
        trustDigest: digest,
        harness,
        requestedModel: "fake-model",
      },
    });
    assert.ok(admission.admitted && admission.runId);
    const runId = admission.runId;
    await awaitSettled(wired.projectionPort, "op-launch");
    const grilled = readRun(wired.projectionPort, runId);
    assert.equal(grilled.pendingGate?.gate.stepId, "choose-tracker");
    assert.equal(
      grilled.timeline.find((event) => event.event === "interactive-step-ended")
        ?.endedBy,
      "agent",
    );
    assert.ok(
      agent.turns[0]?.text.endsWith(
        "When the frontier is empty, asked whether I have any questions or concerns left or whether you may end the interview, and I have told you to end it, call step done with a one-line reason.",
      ),
    );
    assert.doesNotMatch(
      agent.turns[0]?.text ?? "",
      /nothing\s+either of us says/,
    );
    assert.ok(grilled.pendingGate);
    await settle(wired, {
      operationId: "op-tracker",
      operation: "answer-human-gate",
      input: { runId, gate: grilled.pendingGate.gate, text: "Local" },
    });
    const held = await awaitRunRest(wired.projectionPort, runId);
    assert.equal(held.state, "blocked");
    assert.deepEqual(held.heldForReview, {
      interval: 50,
      message:
        "The agent has continued 50 tickets in a row on its own. Look over the work and the tracker, then Continue.",
      reason: "Finished 51-ticket.md.",
    });
    assert.deepEqual(
      held.timeline
        .filter((event) => event.event === "interactive-step-ended")
        .map((event) => event.endedBy),
      ["agent", "agent"],
    );
    const planned = agent.turns.find((turn) =>
      turn.text.startsWith("# Plan the tickets"),
    );
    assert.ok(planned);
    assert.ok(
      planned.text.endsWith(
        "When the work this step asked of you is finished, call step done with a one-line reason.",
      ),
    );
    assert.match(planned.text, /Do not publish any ticket in this Step/);
    assert.match(
      planned.text,
      /finished when I approve the\s+final breakdown in the conversation/,
    );
    assert.doesNotMatch(planned.text, /End Step/);
    const published = agent.turns.find((turn) =>
      turn.text.startsWith("# Publish the tickets"),
    );
    assert.ok(published);
    assert.equal(planned.session, published.session);
    assert.notEqual(planned.session, agent.turns[0]?.session);
    assert.match(
      published.text,
      /The breakdown we settled on in this conversation is approved/,
    );
    const implementations = agent.turns.filter((turn) =>
      turn.text.startsWith(IMPLEMENT_HEADING),
    );
    assert.equal(implementations.length, 51);
    assert.equal(new Set(implementations.map((turn) => turn.session)).size, 51);
    const entry = implementations[0]?.text;
    assert.ok(entry);
    assert.ok(
      entry.endsWith(
        "When the work this step asked of you is finished, call step done with a one-line reason.\nWhen you read the tracker and no open implementation ticket is left, call stage done with a one-line reason instead. If tickets are open but none is ready, or you cannot read the tracker, do not call stage done; say so plainly and stop.",
      ),
    );
    assert.match(entry, /mark it done when you finish/);
    assert.equal(
      held.timeline.filter(
        (event) =>
          event.event === "repeat-continued" && event.endedBy === "agent",
      ).length,
      50,
    );
    assert.deepEqual(
      held.timeline.filter((event) => event.agentCall !== undefined).at(-1)
        ?.agentCall?.answer,
      { outcome: "held-for-review" },
    );
    for (const action of [
      "send-interactive-turn",
      "continue-repeat",
      "end-stage",
    ])
      assert.ok(held.actionOffers.some((offer) => offer.action === action));
    const area = agent.granted.at(-1)!;
    const before = trackerFiles(area);
    await settle(wired, {
      operationId: "op-reviewed",
      operation: "continue-repeat",
      input: { runId, stepId: "implement" },
    });
    const done = await awaitRunRest(wired.projectionPort, runId);
    assert.equal(done.state, "succeeded");
    assert.equal(done.completion, "agent-declared");
    assert.equal(done.heldForReview, undefined);
    const ended = done.timeline.find((event) => event.event === "stage-ended");
    assert.equal(ended?.endedBy, "agent");
    assert.equal(ended?.reason, "No open implementation ticket is left.");
    assert.notEqual(
      agent.turns.at(-1)?.session,
      implementations.at(-1)?.session,
    );
    assert.deepEqual(trackerFiles(area), before);
    assert.deepEqual(readdirSync(workspace), []);
    assert.deepEqual(done.outputs.map((output) => output.name).sort(), [
      "spec-ref",
      "tickets-ref",
      "tracker",
    ]);
  });
}
