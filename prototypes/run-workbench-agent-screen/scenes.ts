// PROTOTYPE — throwaway (#247). Scripted, in-memory Run content for the agent-screen variants.
// Content is shaped after what Claude Code and Codex actually emit and what the Matt Front Spec
// Bundle actually routes (grill → choose-tracker → write-spec → plan-tickets → publish-tickets →
// implement repeat). Nothing here reads a Projection.

export type Item =
  | { kind: "step"; title: string; detail: string; newSession?: string }
  | { kind: "entry"; step: string; lines: number; preview: string }
  | { kind: "user"; text: string; steer?: "delivered" | "waiting" | "dropped" }
  | { kind: "assistant"; md: string; streaming?: boolean }
  | {
      kind: "thought";
      title: string;
      secs: number;
      body: string;
      live?: boolean;
    }
  | {
      kind: "tool";
      icon: string;
      label: string;
      state?: "running" | "done" | "failed";
      error?: string;
    }
  | {
      kind: "shell";
      command: string;
      output: string[];
      exit?: number;
      running?: boolean;
    }
  | { kind: "edit"; path: string; diff: string[] }
  | {
      kind: "turn-end";
      harness: string;
      model: string;
      secs: number;
      interrupted?: boolean;
      tools?: number;
    }
  | {
      kind: "agent-call";
      call: "step done" | "stage done";
      reason: string;
      outcome: string;
    }
  | { kind: "gate-answered"; title: string; answer: string }
  | { kind: "notice"; tone: "warning" | "error" | "info"; text: string };

export type Bottom =
  | {
      kind: "prompt";
      working: boolean;
      draft?: string;
      note?: string;
      placeholder: string;
      hints: string[];
    }
  | { kind: "request"; title: string; body: string[]; choices: string[] }
  | { kind: "gate"; title: string; message: string; suggestions: string[] }
  | { kind: "checkpoint"; message: string; facts: string[] }
  | { kind: "finished"; outcome: string; facts: string[]; runId: string };

export interface Progress {
  bundle: string;
  steps: { title: string; state: "done" | "current" | "todo" }[];
  step: string;
  iteration?: string;
  session: string;
  harness: string;
  model: string;
  effort: string;
  modelNote?: string;
  context?: string;
}

export interface Scene {
  key: string;
  title: string;
  items: Item[];
  /** Items appended one at a time while the scene plays (the live Turn). */
  script?: Item[];
  bottom: Bottom;
  progress: Progress;
}

const STEPS = [
  "Grill",
  "Choose tracker",
  "Write spec",
  "Plan tickets",
  "Publish tickets",
  "Implement",
];
const steps = (current: number) =>
  STEPS.map(
    (title, i) =>
      ({
        title,
        state: i < current ? "done" : i === current ? "current" : "todo",
      }) as const,
  );

const implementProgress = (over: Partial<Progress> = {}): Progress => ({
  bundle: "Matt Front Spec",
  steps: steps(5),
  step: "Implement",
  iteration: "Iteration 2",
  session: "implement-2",
  harness: "Codex",
  model: "gpt-5-codex",
  effort: "high",
  context: "61k (24%)",
  ...over,
});

const WORKING_HINTS = ["esc interrupt", "enter steer", "ctrl+o expand output"];
const IDLE_HINTS = [
  "enter send",
  "ctrl+e end step",
  "ctrl+n next ticket",
  "ctrl+o expand output",
];

// ── Shared history: the earlier Steps of this Run, as a human would scroll back to them. ──
const earlier: Item[] = [
  {
    kind: "step",
    title: "Grill",
    detail: "Interactive · Session spec",
    newSession: "spec",
  },
  {
    kind: "entry",
    step: "grill",
    lines: 38,
    preview:
      "Interview the human about their launch idea until every branch is resolved…",
  },
  {
    kind: "assistant",
    md: "Before I write anything down: **who runs the installer** — a developer on their own machine, or CI? The answer decides whether a hang should retry quietly or fail fast.",
  },
  {
    kind: "user",
    text: "Both. Developers mostly, but our release smoke runs it in CI on all three OSes.",
  },
  { kind: "turn-end", harness: "Codex", model: "gpt-5-codex", secs: 9 },
  {
    kind: "agent-call",
    call: "step done",
    reason: "You confirmed nothing is left to discuss.",
    outcome: "Grill ended",
  },
  { kind: "step", title: "Choose tracker", detail: "Workflow decision" },
  {
    kind: "gate-answered",
    title: "Where should the spec and tickets live?",
    answer: "GitHub",
  },
  { kind: "step", title: "Write spec", detail: "Agent · Session spec" },
  {
    kind: "tool",
    icon: "✓",
    label: "Wrote the spec · Spec: bounded installer downloads (#312)",
    state: "done",
  },
  {
    kind: "step",
    title: "Plan tickets",
    detail: "Interactive · Session tickets",
    newSession: "tickets",
  },
  {
    kind: "assistant",
    md: "Proposed breakdown:\n\n1. Print a line as each install phase starts\n2. Bound every download with a connect timeout, an overall timeout, and retries\n3. Bound the installed `secant --version` check\n\nShall I publish these three?",
  },
  { kind: "user", text: "Yes, publish them." },
  {
    kind: "agent-call",
    call: "step done",
    reason: "The human approved the three-ticket breakdown.",
    outcome: "Plan tickets ended",
  },
  { kind: "step", title: "Publish tickets", detail: "Agent · Session tickets" },
  {
    kind: "tool",
    icon: "✓",
    label: "Published 3 tickets on GitHub (#313, #314, #315)",
    state: "done",
  },
  {
    kind: "step",
    title: "Implement · Iteration 1",
    detail: "Interactive · fresh Session",
    newSession: "implement-1",
  },
  {
    kind: "tool",
    icon: "✓",
    label: "Print a line as each install phase starts (#313) — merged",
    state: "done",
  },
  {
    kind: "agent-call",
    call: "step done",
    reason: "#313 is merged and its installer test passes.",
    outcome: "Iteration 1 ended",
  },
  {
    kind: "step",
    title: "Implement · Iteration 2",
    detail: "Interactive · fresh Session",
    newSession: "implement-2",
  },
  {
    kind: "entry",
    step: "implement",
    lines: 42,
    preview:
      "Pick one ready ticket from the tracker whose blockers are all closed, say which one…",
  },
];

// ── Iteration 2's live Turn. ──
const turnOpen: Item[] = [
  {
    kind: "thought",
    title: "Choosing the next ready ticket",
    secs: 3.1,
    body: "#314 and #315 are open; #315 is blocked by #314, so #314 is the only ready one.",
  },
  {
    kind: "assistant",
    md: "I'll take **#314 — Bound every download with a connect timeout, an overall timeout, and retries.** Its only blocker (#313) is closed.",
  },
  { kind: "tool", icon: "→", label: "Read install.sh", state: "done" },
  { kind: "tool", icon: "→", label: "Read install.ps1", state: "done" },
  {
    kind: "tool",
    icon: "✱",
    label: 'Grep "curl -fsSL" in . (4 matches)',
    state: "done",
  },
];

const shellTest: Item = {
  kind: "shell",
  command: "bun run test tests/installer",
  exit: 1,
  output: [
    "bun test v1.4.2",
    "",
    "tests/installer/install-sh.test.ts:",
    "✓ prints each phase as it starts [212.40ms]",
    "✓ refuses an unknown platform [3.10ms]",
    "✗ times out a stalled download [30001.22ms]",
    "  error: Test timed out after 30000ms",
    "✓ verifies the archive checksum [48.02ms]",
    "✓ installs into SECANT_INSTALL_DIR [91.77ms]",
    "",
    "tests/installer/install-ps1.test.ts:",
    "✓ prints each phase as it starts [388.12ms]",
    "✗ times out a stalled download [30000.84ms]",
    "  error: Test timed out after 30000ms",
    "",
    " 5 pass",
    " 2 fail",
    "Ran 7 tests across 2 files. [61.03s]",
  ],
};

const editSh: Item = {
  kind: "edit",
  path: "install.sh",
  diff: [
    "@@ -41,7 +41,9 @@ fetch() {",
    "   url=$1 out=$2",
    '-  curl -fsSL "$url" -o "$out"',
    "+  curl -fsSL --connect-timeout 10 --max-time 300 \\",
    "+    --retry 3 --retry-delay 2 --retry-connrefused \\",
    '+    "$url" -o "$out"',
    " }",
  ],
};

const streamingReply =
  "Both installers hang because `curl` and `Invoke-WebRequest` run with no timeout. I've bounded `install.sh`:\n\n" +
  "- **connect timeout** 10 s, **overall** 300 s\n- **3 retries**, 2 s apart, including refused connections\n\n" +
  "Next I'll do the same in `install.ps1` with `-TimeoutSec` and a retry loop, then rerun the installer tests.";

export const SCENES: Scene[] = [
  {
    key: "working",
    title: "Agent working",
    items: [...earlier, { kind: "user", text: "Go ahead." }],
    script: [
      ...turnOpen,
      shellTest,
      {
        kind: "thought",
        title: "Both stalled-download tests hang",
        secs: 2.4,
        body: "The tests start a server that accepts and never responds; nothing bounds the transfer.",
      },
      editSh,
      { kind: "assistant", md: streamingReply, streaming: true },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "running" },
    ],
    bottom: {
      kind: "prompt",
      working: true,
      placeholder: "Message the agent — it reads this at its next step",
      hints: WORKING_HINTS,
    },
    progress: implementProgress(),
  },
  {
    key: "question",
    title: "Agent asks a question",
    items: [
      ...earlier,
      { kind: "user", text: "Go ahead." },
      ...turnOpen,
      shellTest,
      editSh,
      {
        kind: "assistant",
        md:
          "Before I touch `install.ps1` I need one decision from you. The ticket says *retries*, but it doesn't say what a retry covers:\n\n" +
          "1. **Transient only** — retry refused connections, DNS failures, and 5xx responses; fail at once on 404 or a checksum mismatch.\n" +
          "2. **Everything** — retry any non-zero exit, which also retries a 404 three times before giving up (slower failure on a wrong release name).\n\n" +
          "CI runs the installer on all three OSes, so option 1 fails a mistyped version in about 10 s instead of about 40 s. **Which do you want?** " +
          "I'd go with 1 and keep `curl --retry`'s own classification on Unix, then match it by status code in PowerShell.",
      },
      {
        kind: "turn-end",
        harness: "Codex",
        model: "gpt-5-codex",
        secs: 94,
        tools: 6,
      },
    ],
    bottom: {
      kind: "prompt",
      working: false,
      placeholder: "Reply to the agent",
      hints: IDLE_HINTS,
    },
    progress: implementProgress({
      effort: "high",
      modelNote: "medium applies when you send",
    }),
  },
  {
    key: "request",
    title: "Harness Request",
    items: [
      ...earlier,
      { kind: "user", text: "Option 1. Go ahead." },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      { kind: "tool", icon: "$", label: "bun install", state: "running" },
    ],
    bottom: {
      kind: "request",
      title: "Codex wants to run a command outside the sandbox",
      body: [
        "$ bun install --frozen-lockfile",
        "",
        "Reason given: the installer tests need the lockfile's dev dependencies (network access).",
      ],
      choices: ["Allow", "Deny"],
    },
    progress: implementProgress(),
  },
  {
    key: "gate",
    title: "Human Gate",
    items: earlier.slice(0, 6),
    bottom: {
      kind: "gate",
      title: "Choose tracker",
      message:
        "The interview is complete. Where should the spec and tickets live? Choose Local or GitHub, or type another tracker your agent can reach.",
      suggestions: ["Local", "GitHub"],
    },
    progress: {
      ...implementProgress(),
      steps: steps(1),
      step: "Choose tracker",
      iteration: undefined,
      session: "—",
      context: undefined,
    },
  },
  {
    key: "checkpoint",
    title: "Review checkpoint",
    items: [
      ...earlier,
      {
        kind: "tool",
        icon: "✓",
        label: "Bound every download with timeouts and retries (#314) — merged",
        state: "done",
      },
      {
        kind: "agent-call",
        call: "step done",
        reason: "#314 is merged; both installer suites pass on the PR.",
        outcome: "Iteration 2 ended",
      },
    ],
    bottom: {
      kind: "checkpoint",
      message:
        "The agent has run 50 Iterations since you last reviewed. Look over what landed before it keeps going.",
      facts: [
        "50 Iterations since the last review",
        "Latest: #314 merged",
        "1 ticket still open (#315)",
      ],
    },
    progress: implementProgress({ iteration: "Iteration 50" }),
  },
  {
    key: "steer",
    title: "Steer mid-Turn",
    items: [
      ...earlier,
      { kind: "user", text: "Option 1. Go ahead." },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      {
        kind: "user",
        text: "Also cap the PowerShell retries at 3 — match curl exactly.",
        steer: "delivered",
      },
      {
        kind: "assistant",
        md: "Got it — capping `install.ps1` at 3 retries, 2 s apart, to match `curl --retry 3 --retry-delay 2`.",
      },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      {
        kind: "shell",
        command: "bun run test tests/installer",
        running: true,
        output: [
          "bun test v1.4.2",
          "",
          "tests/installer/install-sh.test.ts:",
          "✓ prints each phase as it starts [209.11ms]",
          "✓ refuses an unknown platform [2.94ms]",
          "✓ times out a stalled download [10412.60ms]",
        ],
      },
      {
        kind: "user",
        text: "And don't forget the CHANGELOG line.",
        steer: "waiting",
      },
    ],
    bottom: {
      kind: "prompt",
      working: true,
      placeholder: "Message the agent — it reads this at its next step",
      hints: WORKING_HINTS,
    },
    progress: implementProgress(),
  },
  {
    key: "steer-late",
    title: "Steer after the Turn ended",
    items: [
      ...earlier,
      { kind: "user", text: "Option 1. Go ahead." },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      {
        kind: "assistant",
        md: "Both installers are bounded and the 7 installer tests pass. Ready for review.",
      },
      {
        kind: "turn-end",
        harness: "Codex",
        model: "gpt-5-codex",
        secs: 212,
        tools: 11,
      },
      {
        kind: "notice",
        tone: "warning",
        text: "The Turn ended before your message reached the agent. It's back in your draft — enter sends it as your next Turn.",
      },
    ],
    bottom: {
      kind: "prompt",
      working: false,
      draft: "And don't forget the CHANGELOG line.",
      placeholder: "Reply to the agent",
      hints: IDLE_HINTS,
    },
    progress: implementProgress(),
  },
  {
    key: "interrupt",
    title: "Interrupted",
    items: [
      ...earlier,
      { kind: "user", text: "Option 1. Go ahead." },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      {
        kind: "assistant",
        md: "Now rewriting the release-smoke step so it downloads through the new `fetch` helper and",
      },
      {
        kind: "user",
        text: "Leave CI alone — just the two installers.",
        steer: "dropped",
      },
      {
        kind: "turn-end",
        harness: "Codex",
        model: "gpt-5-codex",
        secs: 41,
        interrupted: true,
        tools: 4,
      },
    ],
    bottom: {
      kind: "prompt",
      working: false,
      draft: "Leave CI alone — just the two installers.",
      note: "You stopped the agent. It's waiting on you; your undelivered message is back in the draft.",
      placeholder: "Reply to the agent",
      hints: IDLE_HINTS,
    },
    progress: implementProgress(),
  },
  {
    key: "step-done",
    title: "Agent ends the Step",
    items: [
      ...earlier,
      { kind: "user", text: "Option 1. Go ahead." },
      { kind: "tool", icon: "←", label: "Edit install.ps1", state: "done" },
      shellTest.kind === "shell"
        ? {
            ...shellTest,
            exit: 0,
            output: shellTest.output
              .filter((l) => !l.includes("✗") && !l.includes("error:"))
              .map((l) =>
                l.replace(" 5 pass", " 7 pass").replace(" 2 fail", " 0 fail"),
              ),
          }
        : shellTest,
      {
        kind: "tool",
        icon: "$",
        label: "gh pr merge 318 --squash",
        state: "done",
      },
      {
        kind: "assistant",
        md: "**#314 is merged.** Both installers now bound every download (10 s connect, 300 s overall, 3 retries) and the version check has a 10 s limit.",
      },
      {
        kind: "turn-end",
        harness: "Codex",
        model: "gpt-5-codex",
        secs: 318,
        tools: 14,
      },
      {
        kind: "agent-call",
        call: "step done",
        reason: "#314 is merged and all 7 installer tests pass.",
        outcome: "Iteration 2 ended · starting Iteration 3 in a fresh Session",
      },
      {
        kind: "step",
        title: "Implement · Iteration 3",
        detail: "Interactive · fresh Session",
        newSession: "implement-3",
      },
      {
        kind: "entry",
        step: "implement",
        lines: 42,
        preview:
          "Pick one ready ticket from the tracker whose blockers are all closed, say which one…",
      },
    ],
    bottom: {
      kind: "prompt",
      working: true,
      placeholder: "Message the agent — it reads this at its next step",
      hints: WORKING_HINTS,
    },
    progress: implementProgress({
      iteration: "Iteration 3",
      session: "implement-3",
      context: "4k (2%)",
    }),
  },
  {
    key: "finished",
    title: "Run finished",
    items: [
      ...earlier,
      {
        kind: "tool",
        icon: "✓",
        label: "Bound the installed secant --version check (#315) — merged",
        state: "done",
      },
      {
        kind: "agent-call",
        call: "stage done",
        reason: "No open ticket is left on the tracker.",
        outcome: "Implement ended",
      },
    ],
    bottom: {
      kind: "finished",
      outcome: "Run succeeded",
      facts: [
        "Matt Front Spec · 6 Steps · 3 Iterations · 1h 12m",
        "Spec #312 · Tickets #313 #314 #315 merged",
      ],
      runId: "8ad1ceba-05f3-4fc5-a6f7-6e7c52eba121",
    },
    progress: {
      ...implementProgress({ iteration: "Iteration 3" }),
      steps: STEPS.map((title) => ({ title, state: "done" as const })),
    },
  },
];
