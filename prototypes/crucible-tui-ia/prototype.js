/* global document, history, location */

const variants = {
  H: {
    name: "Workspace Home",
    thesis:
      "Start with one Workspace and a small set of real paths, then reveal detail only after the user chooses a task.",
  },
  W: {
    name: "Workspace Approval",
    thesis:
      "Use the exact launch directory as the Workspace and ask for approval only the first time Crucible opens there.",
  },
  A: {
    name: "Progressive Launch",
    thesis:
      "Ask for one launch decision at a time, then show trust and preflight evidence only at final review.",
  },
  R: {
    name: "Previous Runs",
    thesis:
      "Keep Run discovery minimal and ordered by recent durable activity, then open one exact Run before offering any applicable action.",
  },
  B: {
    name: "Run Workbench",
    thesis:
      "Make the normal post-submit experience the Run timeline, with control-plane operations kept small and peripheral.",
  },
  C: {
    name: "Catalog Inspector",
    thesis:
      "Use one stable inspector shell for Bundle, Harness, launch, and Run focus so headless projections map cleanly to TUI views.",
  },
};

const sample = {
  workspaceName: "example-service",
  workspace: "/Users/rohan/src/example-service",
  bundle: "io.devflow.test-repair@1.0.0",
  digest: "sha256:48e8...b91c",
  harness: "Codex",
  requestedModel: "gpt-5-codex",
  effectiveModel: "gpt-5-codex",
  run: "run_01JCRUCIBLE",
  state: "blocked",
  step: "approve-fix",
  attempt: "approve-fix / iteration 2 / attempt 1",
  projectionState: {
    opened: "run",
    durableCursor: "run:01JCRUCIBLE:000184",
    liveGeneration: "turn:main:7",
    actionOffers: [
      "answer-human-gate",
      "send-interactive-turn",
      "steer-turn",
      "interrupt-turn unavailable: harness does not support mid-turn interrupt",
    ],
    resources: [
      "older-session-page",
      "artifact-index",
      "diagnostic-index",
      "workspace-materialization-details",
    ],
  },
};

const workflowBundles = [
  {
    name: "Test Repair",
    identity: "io.devflow.test-repair@1.0.0",
    version: "1.0.0",
    description: "Drive one failing test to green, then ask for approval.",
    lastUsed: "Used 2 hours ago",
    origin: "Imported local file",
    workflow: "1 agent step · 3 commands · 1 approval",
    inputs: [
      {
        name: "failing-test",
        type: "file",
        description: "Path to the file containing the failing test.",
        placeholder: "tests/example.test.ts",
      },
    ],
    digest:
      "sha256:48e8a90bb6f2b80b99781c1bf676bf315b523f819852bad0c6392de88a27b91c",
  },
  {
    name: "Git Diff Review",
    identity: "io.devflow.diff-review@1.1.0",
    version: "1.1.0",
    description: "Review the current Git diff and confirm the findings.",
    lastUsed: "Used yesterday",
    origin: "Built in",
    workflow: "1 agent step · 1 command · 1 confirmation",
    inputs: [],
    digest:
      "sha256:cb34eb16a614573e2713f2c22c7c86569ac847fbfa1fb10c96135b55b5cd6f19",
  },
  {
    name: "Issue to Pull Request",
    identity: "io.devflow.issue-to-pr@2.0.0",
    version: "2.0.0",
    description:
      "Turn a prepared issue into an implementation and pull request.",
    lastUsed: "Used 6 days ago",
    origin: "Imported local file",
    workflow: "2 agent steps · 2 commands · 2 approvals",
    inputs: [
      {
        name: "issue-location",
        type: "text",
        description: "Issue URL or reference to implement.",
        placeholder: "https://github.com/owner/repository/issues/123",
      },
    ],
    digest:
      "sha256:a6b79fb09f2c4573cbafd69d924a78f80ce26cf77009af765f24b3c8be2368bf",
  },
  {
    name: "Dependency Upgrade",
    identity: "io.devflow.dependency-upgrade@1.0.0",
    version: "1.0.0",
    description: "Upgrade one dependency and verify the Workspace.",
    lastUsed: "Never used",
    origin: "Imported local file",
    workflow: "1 agent step · 3 commands · 1 approval",
    inputs: [
      {
        name: "dependency-name",
        type: "text",
        description: "Dependency to upgrade.",
        placeholder: "typescript",
      },
      {
        name: "target-version",
        type: "text",
        description: "Version the dependency should reach.",
        placeholder: "5.9.2",
      },
    ],
    digest:
      "sha256:856bf331f350db309e09272d8734576ec9b713fe726f9b01fdcf5339c51d6c38",
  },
];

const previousRuns = [
  {
    id: "run_01JCRUCIBLE",
    bundleId: "io.devflow.test-repair",
    bundleName: "Test Repair",
    workspace: sample.workspace,
    activityGroup: "Today",
    latestActivity: "11:42 AM",
    latestActivityOrder: 6,
    state: "halted",
    stateLabel: "Halted",
    position: "Fix test · Iteration 2 · Attempt 1",
    reason:
      "Crucible closed while Codex was working. Existing Run history and published Artifacts are intact.",
    resumable: true,
    loadedInitially: true,
  },
  {
    id: "run_01JDIFFREVIEW",
    bundleId: "io.devflow.diff-review",
    bundleName: "Git Diff Review",
    workspace: sample.workspace,
    activityGroup: "Today",
    latestActivity: "9:18 AM",
    latestActivityOrder: 5,
    state: "succeeded",
    stateLabel: "Succeeded",
    position: "Workflow complete",
    reason: "The review completed and all declared outputs were published.",
    resumable: false,
    loadedInitially: true,
  },
  {
    id: "run_01JISSUETOPR",
    bundleId: "io.devflow.issue-to-pr",
    bundleName: "Issue to Pull Request",
    workspace: sample.workspace,
    activityGroup: "Yesterday",
    latestActivity: "6:07 PM",
    latestActivityOrder: 4,
    state: "failed",
    stateLabel: "Failed",
    position: "Verify implementation · Iteration 4",
    reason:
      "The Workflow reached its negative verdict. Resuming grants the Step fresh attempt and Iteration bounds.",
    resumable: true,
    loadedInitially: true,
  },
  {
    id: "run_01JDEPENDENCY",
    bundleId: "io.devflow.dependency-upgrade",
    bundleName: "Dependency Upgrade",
    workspace: sample.workspace,
    activityGroup: "Older",
    latestActivity: "Aug 28, 3:31 PM",
    latestActivityOrder: 3,
    state: "cancelled",
    stateLabel: "Cancelled",
    position: "Run ended by user",
    reason: "This Run was explicitly cancelled and cannot be resumed.",
    resumable: false,
    loadedInitially: false,
  },
  {
    id: "run_01JTESTREPAIR8",
    bundleId: "io.devflow.test-repair",
    bundleName: "Test Repair",
    workspace: sample.workspace,
    activityGroup: "Older",
    latestActivity: "Aug 21, 10:14 AM",
    latestActivityOrder: 2,
    state: "succeeded",
    stateLabel: "Succeeded",
    position: "Workflow complete",
    reason: "The failing test passed and the approved fix was committed.",
    resumable: false,
    loadedInitially: false,
  },
  {
    id: "run_01JDIFFREVIEW4",
    bundleId: "io.devflow.diff-review",
    bundleName: "Git Diff Review",
    workspace: sample.workspace,
    activityGroup: "Older",
    latestActivity: "Aug 12, 4:46 PM",
    latestActivityOrder: 1,
    state: "halted",
    stateLabel: "Halted",
    position: "Review changes · Attempt 1",
    reason:
      "The Harness Session detached after the machine restarted. Crucible can reattach before continuing.",
    resumable: true,
    loadedInitially: false,
  },
];

const harnesses = [
  {
    name: "Codex",
    detail: "Qualified · session recovery available",
    models: ["gpt-5-codex", "gpt-5"],
    available: true,
  },
  {
    name: "Claude Code",
    detail: "Unavailable · authenticate with Claude Code first",
    models: ["claude-opus-4-1", "claude-sonnet-4"],
    available: false,
  },
  {
    name: "Gemini",
    detail: "Qualified · interrupt unavailable",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    available: true,
  },
];

const launchDraft = {
  step: "bundle",
  bundleIndex: null,
  harnessIndex: null,
  model: "",
  inputValues: {},
  inputProblems: {},
  trustApproved: false,
};

const runModes = ["running", "gate", "request", "question"];
const requestedRunMode = new URLSearchParams(location.search).get("runState");

const runWorkbench = {
  mode: runModes.includes(requestedRunMode) ? requestedRunMode : "running",
  historyRunId: null,
  detailsOpen: false,
  resource: null,
  notice: "",
  olderLoaded: false,
};

const requestedRunListMode = new URLSearchParams(location.search).get(
  "runList",
);

const runHistory = {
  mode: requestedRunListMode === "empty" ? "empty" : "populated",
  filter: "all",
  olderLoaded: false,
  loadingOlder: false,
  openedRunId: null,
  resumedRunIds: new Set(),
};

const WORKSPACE_APPROVALS_KEY = "crucible-prototype.workspace-approvals";

const workspaceApproval = {
  approvedPaths: loadWorkspaceApprovals(),
  declined: false,
};

const trustedBundleDigests = new Set(
  workflowBundles
    .filter((bundle) => bundle.origin === "Built in")
    .map((bundle) => bundle.digest),
);

function currentVariantKey() {
  const requestedKey = new URLSearchParams(location.search).get("variant");
  const key =
    requestedKey ||
    (workspaceApproval.approvedPaths.has(sample.workspace) ? "H" : "W");
  return variants[key] ? key : "H";
}

function setVariant(next) {
  const params = new URLSearchParams(location.search);
  params.set("variant", next);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  render();
}

function setRunMode(mode) {
  runWorkbench.historyRunId = null;
  runWorkbench.mode = runModes.includes(mode) ? mode : "running";
  const params = new URLSearchParams(location.search);
  params.set("runState", runWorkbench.mode);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  render();
}

function setRunListMode(mode) {
  runHistory.mode = mode === "empty" ? "empty" : "populated";
  runHistory.filter = "all";
  runHistory.olderLoaded = false;
  runHistory.loadingOlder = false;
  runHistory.openedRunId = null;
  const params = new URLSearchParams(location.search);
  params.set("runList", runHistory.mode);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  render();
}

function resetLaunchDraft() {
  launchDraft.step = "bundle";
  launchDraft.bundleIndex = null;
  launchDraft.harnessIndex = null;
  launchDraft.model = "";
  launchDraft.inputValues = {};
  launchDraft.inputProblems = {};
  launchDraft.trustApproved = false;
}

function openView(next) {
  if (next === "A") resetLaunchDraft();
  if (next === "R") runHistory.openedRunId = null;
  setVariant(next);
}

function cycle(offset) {
  const keys = Object.keys(variants);
  const current = keys.indexOf(currentVariantKey());
  const next = keys[(current + offset + keys.length) % keys.length];
  setVariant(next);
}

function status(symbol, cls, label) {
  return `<span class="status ${cls}" data-symbol="${symbol}">${label}</span>`;
}

function row(left, main, right = "") {
  return `<div class="row"><span class="muted">${left}</span><div>${main}</div><span>${right}</span></div>`;
}

function topLine(key) {
  return `
    <div class="topline">
      <div><span class="brand">Crucible</span> <span class="muted">TUI IA prototype</span></div>
      <div class="tag">${key} ${variants[key].name}</div>
    </div>
  `;
}

function stateDump(key) {
  return `<section class="panel">
    <h2>Projected state visible in this variant</h2>
    <div class="panel-body state-dump">${escapeHtml(
      JSON.stringify(
        {
          variant: `${key} ${variants[key].name}`,
          designThesis: variants[key].thesis,
          sample,
        },
        null,
        2,
      ),
    )}</div>
  </section>`;
}

function switcher(key) {
  return `<nav class="kbdbar" aria-label="Prototype variant switcher">
    <button type="button" title="Previous variant" aria-label="Previous variant" data-dir="-1">&larr;</button>
    <div class="label">${key} (${variants[key].name})</div>
    <button type="button" title="Next variant" aria-label="Next variant" data-dir="1">&rarr;</button>
  </nav>`;
}

function workspaceHome() {
  return `
    <section class="screen home">
      ${topLine("H")}
      <main class="home-main">
        <div>
          <h1 class="workspace-name">${escapeHtml(sample.workspaceName)}</h1>
          <p class="workspace-path">${escapeHtml(sample.workspace)}</p>
          <nav class="home-actions" aria-label="Workspace actions">
            <button type="button" class="primary" data-view="A">Start a Run</button>
            <button type="button" data-view="C">Workflow Bundles</button>
            <button type="button" data-view="R">Previous Runs</button>
            <button type="button" data-view="C">Harnesses</button>
          </nav>
          <p class="home-summary">4 Workflow Bundles · ${runHistory.mode === "empty" ? "No previous Runs" : `${previousRuns.length} previous Runs`} · ${sample.harness} qualified</p>
        </div>
      </main>
      ${switcher("H")}
    </section>
  `;
}

function visiblePreviousRuns() {
  if (runHistory.mode === "empty") return [];

  return previousRuns
    .filter((run) => {
      const isLoaded = run.loadedInitially || runHistory.olderLoaded;
      const matchesFilter =
        runHistory.filter === "all" ||
        (run.resumable && !runHistory.resumedRunIds.has(run.id));
      return isLoaded && matchesFilter;
    })
    .sort(
      (left, right) => right.latestActivityOrder - left.latestActivityOrder,
    );
}

function previousRunGroups() {
  const groupOrder = ["Today", "Yesterday", "Older"];
  const runs = visiblePreviousRuns();
  return groupOrder
    .map((name) => ({
      name,
      runs: runs.filter((run) => run.activityGroup === name),
    }))
    .filter((group) => group.runs.length > 0);
}

function previousRunRows(runs) {
  return runs
    .map(
      (
        run,
      ) => `<button type="button" class="run-list-row" data-keyboard-choice data-previous-run-id="${run.id}">
        <span class="run-list-identity">
          <strong>${escapeHtml(run.bundleName)}</strong>
          <small>${escapeHtml(run.id)}</small>
        </span>
        <time>${escapeHtml(run.latestActivity)}</time>
      </button>`,
    )
    .join("");
}

function previousRunListContent() {
  const groups = previousRunGroups();
  if (groups.length === 0) {
    const title =
      runHistory.mode === "empty" ? "No previous Runs" : "No resumable Runs";
    const description =
      runHistory.mode === "empty"
        ? "Runs started in this Workspace will appear here."
        : "No failed or halted Runs are currently available to resume.";
    return `<div class="run-list-empty">
      <h2>${title}</h2>
      <p>${description}</p>
    </div>`;
  }

  const hasOlderRuns = previousRuns.some(
    (run) =>
      !run.loadedInitially &&
      (runHistory.filter === "all" ||
        (run.resumable && !runHistory.resumedRunIds.has(run.id))),
  );
  const pagingControl = runHistory.loadingOlder
    ? `<div class="run-list-boundary" role="status">${status("*", "info", "Loading older Runs...")}</div>`
    : runHistory.olderLoaded || !hasOlderRuns
      ? '<div class="run-list-boundary">Beginning of Run history</div>'
      : '<button type="button" class="load-older-runs" data-load-older-runs>Load older Runs</button>';

  return `<div class="run-groups">
    ${groups
      .map(
        (
          group,
        ) => `<section class="run-group" aria-labelledby="run-group-${group.name.toLowerCase()}">
          <h2 id="run-group-${group.name.toLowerCase()}">${group.name}</h2>
          <div>${previousRunRows(group.runs)}</div>
        </section>`,
      )
      .join("")}
    ${pagingControl}
  </div>`;
}

function runListStateSwitcher() {
  return `<nav class="run-state-switcher" aria-label="Previous Runs prototype state switcher">
    <span>Prototype state</span>
    <button type="button" data-run-list-mode="populated" aria-pressed="${runHistory.mode === "populated"}">With Runs</button>
    <button type="button" data-run-list-mode="empty" aria-pressed="${runHistory.mode === "empty"}">Empty</button>
  </nav>`;
}

function previousRunListScreen() {
  return `<section class="screen previous-runs-screen">
    ${topLine("R")}
    <main class="previous-runs-shell">
      <header class="previous-runs-heading">
        <button type="button" class="icon-button" aria-label="Back to Workspace home" title="Back to Workspace home" data-history-back>&larr;</button>
        <div>
          <h1>Previous Runs</h1>
          <p>${escapeHtml(sample.workspaceName)} · ${escapeHtml(sample.workspace)}</p>
        </div>
        <div class="run-list-filter" role="tablist" aria-label="Filter Runs">
          <button type="button" role="tab" data-run-list-filter="all" aria-selected="${runHistory.filter === "all"}">All Runs</button>
          <button type="button" role="tab" data-run-list-filter="resumable" aria-selected="${runHistory.filter === "resumable"}">Resumable</button>
        </div>
      </header>
      ${previousRunListContent()}
      <p class="run-list-keys">Up/Down move · Enter opens the exact Run · Esc returns home</p>
    </main>
    ${runListStateSwitcher()}
    ${switcher("R")}
  </section>`;
}

function exactPreviousRunState(run) {
  if (!runHistory.resumedRunIds.has(run.id)) {
    return {
      label: run.stateLabel,
      state: run.state,
      reason: run.reason,
      position: run.position,
    };
  }

  return {
    label: "Running",
    state: "running",
    reason:
      "Resume was applied. Crucible is continuing this Run from its resting Step.",
    position: run.position,
  };
}

function exactRunStatus(state) {
  const stateStyles = {
    running: ["*", "info"],
    halted: ["!", "warn"],
    failed: ["x", "bad"],
    succeeded: ["+", "ok"],
    cancelled: ["x", "bad"],
  };
  const [symbol, style] = stateStyles[state.state] || [" ", "info"];
  return status(symbol, style, state.label);
}

function previousRunDetailScreen(run) {
  const state = exactPreviousRunState(run);
  const canResume = run.resumable && state.state !== "running";
  return `<section class="screen previous-runs-screen">
    ${topLine("R")}
    <main class="previous-run-detail">
      <header class="previous-runs-heading">
        <button type="button" class="icon-button" aria-label="Back to Previous Runs" title="Back to Previous Runs" data-history-back>&larr;</button>
        <div>
          <h1>${escapeHtml(run.bundleName)}</h1>
          <p>${escapeHtml(run.id)}</p>
        </div>
        <div>${exactRunStatus(state)}</div>
      </header>
      <section class="exact-run-summary" aria-labelledby="run-state-heading">
        <p class="exact-run-label">Current Run state</p>
        <h2 id="run-state-heading">${escapeHtml(state.label)}</h2>
        <p>${escapeHtml(state.reason)}</p>
        <dl>
          <div><dt>Workspace</dt><dd>${escapeHtml(sample.workspaceName)}</dd></div>
          <div><dt>Bundle</dt><dd>${escapeHtml(run.bundleName)}</dd></div>
          <div><dt>Current</dt><dd>${escapeHtml(state.position)}</dd></div>
          <div><dt>Latest activity</dt><dd>${escapeHtml(run.activityGroup)} · ${escapeHtml(run.latestActivity)}</dd></div>
        </dl>
      </section>
      <section class="exact-run-latest" aria-labelledby="latest-activity-heading">
        <h2 id="latest-activity-heading">Latest durable activity</h2>
        <article class="activity ${state.state === "running" ? "current" : "milestone"}">
          <div class="activity-marker">${state.state === "running" ? "*" : "+"}</div>
          <div><header><strong>${state.state === "running" ? "Run resumed" : escapeHtml(state.label)}</strong><span>${state.state === "running" ? "now" : escapeHtml(run.latestActivity)}</span></header><p>${escapeHtml(state.reason)}</p></div>
        </article>
      </section>
      <footer class="exact-run-actions">
        ${canResume ? '<button type="button" class="primary" data-resume-previous-run>Resume Run</button>' : `<span>${state.state === "running" ? "This Run is active." : "No action is currently offered for this Run."}</span>`}
      </footer>
    </main>
    ${switcher("R")}
  </section>`;
}

function previousRunsScreen() {
  const openedRun = previousRuns.find(
    (run) => run.id === runHistory.openedRunId,
  );
  return openedRun
    ? previousRunDetailScreen(openedRun)
    : previousRunListScreen();
}

function loadWorkspaceApprovals() {
  try {
    const storedPaths = JSON.parse(
      localStorage.getItem(WORKSPACE_APPROVALS_KEY) || "[]",
    );
    return new Set(Array.isArray(storedPaths) ? storedPaths : []);
  } catch {
    return new Set();
  }
}

function persistWorkspaceApprovals() {
  try {
    localStorage.setItem(
      WORKSPACE_APPROVALS_KEY,
      JSON.stringify([...workspaceApproval.approvedPaths]),
    );
  } catch {
    // Browser storage only models the future Crucible-home approval record.
  }
}

function workspaceApprovalContent() {
  if (workspaceApproval.declined) {
    return `<div class="workspace-approval">
      <h1>Crucible closed</h1>
      <p class="workspace-path">${escapeHtml(sample.workspace)}</p>
      <p class="workspace-approval-copy">This Workspace was not approved, so Crucible did not open it.</p>
    </div>`;
  }

  const isApproved = workspaceApproval.approvedPaths.has(sample.workspace);
  return `<div class="workspace-approval">
    <h1 class="workspace-name">${escapeHtml(sample.workspaceName)}</h1>
    <p class="workspace-path">${escapeHtml(sample.workspace)}</p>
    <h2>${isApproved ? "Workspace approved" : "Trust this Workspace?"}</h2>
    <p class="workspace-approval-copy">
      ${
        isApproved
          ? "Crucible remembers approval for this exact directory."
          : "Crucible runs selected Workflow Bundles through Harnesses in this folder. Harnesses may read and change files while a Run is active."
      }
    </p>
    <div class="workspace-approval-actions">
      <button type="button" data-workspace-decline>Exit</button>
      <button type="button" class="primary" data-workspace-approve>${isApproved ? "Continue" : "Trust and Continue"}</button>
    </div>
  </div>`;
}

function workspaceApprovalScreen() {
  return `<section class="screen variant-w">
    ${topLine("W")}
    <main class="workspace-approval-main">
      ${workspaceApprovalContent()}
    </main>
    ${switcher("W")}
  </section>`;
}

function selectedBundle() {
  return launchDraft.bundleIndex === null
    ? null
    : workflowBundles[launchDraft.bundleIndex];
}

function launchSequence() {
  const bundle = selectedBundle();
  return bundle && bundle.inputs.length === 0
    ? ["bundle", "harness", "review"]
    : ["bundle", "harness", "inputs", "review"];
}

function launchHeading(title) {
  const steps = launchSequence();
  const stepIndex = steps.indexOf(launchDraft.step);
  const previousStep = stepIndex <= 0 ? "home" : steps[stepIndex - 1];

  return `<header class="launch-heading">
    <button type="button" aria-label="Back" title="Back" data-launch-back="${previousStep}">&larr;</button>
    <h1>${title}</h1>
    <span class="tag">${stepIndex + 1} of ${steps.length}</span>
  </header>`;
}

function workflowBundleChoices() {
  return workflowBundles
    .map(
      (bundle, index) => `
        <button type="button" class="choice-button" data-bundle-index="${index}" aria-pressed="${launchDraft.bundleIndex === index}">
          <span>
            <strong>${bundle.name}</strong>
            <small>${bundle.description}</small>
          </span>
          <span class="bundle-recency">${bundle.lastUsed}</span>
        </button>`,
    )
    .join("");
}

function workflowBundleDetails() {
  if (launchDraft.bundleIndex === null) return "";

  const bundle = workflowBundles[launchDraft.bundleIndex];
  const isTrusted = trustedBundleDigests.has(bundle.digest);
  const trustControl = isTrusted
    ? ""
    : `<label class="trust-confirmation">
        <input type="checkbox" data-trust-confirmation ${launchDraft.trustApproved ? "checked" : ""} />
        <span>I trust ${bundle.name} ${bundle.version}.</span>
      </label>`;

  return `<div class="workflow-side">
    <aside class="panel bundle-details">
      <h2>What this Bundle can do</h2>
      <div class="panel-body review-list">
        <div class="review-item"><span class="muted">Name</span><strong>${bundle.name}</strong></div>
        <div class="review-item"><span class="muted">Description</span><span>${bundle.description}</span></div>
        <div class="review-item"><span class="muted">Source</span><span>${bundle.origin}</span></div>
        <div class="review-item"><span class="muted">Workflow</span><span>${bundle.workflow}</span></div>
        <p class="bundle-info">${status("i", "info", "Harnesses may also run commands while completing agent steps.")} Explore declared steps and commands in <button type="button" class="inline-command" data-view="C">View Bundle Details</button>.</p>
        ${trustControl}
      </div>
    </aside>
    <div class="launch-actions">
      <button type="button" class="primary" data-launch-next="harness" ${isTrusted || launchDraft.trustApproved ? "" : "disabled"}>Continue</button>
    </div>
  </div>`;
}

function launchBundleStep() {
  const layoutClass =
    launchDraft.bundleIndex === null
      ? "workflow-layout single"
      : "workflow-layout";

  return `${launchHeading("Choose a Workflow Bundle")}
    <div class="launch-content ${layoutClass}">
      <div class="choice-list">${workflowBundleChoices()}</div>
      ${workflowBundleDetails()}
    </div>`;
}

function harnessChoices() {
  return harnesses
    .map((harness, index) => {
      const selectionAttribute = harness.available
        ? `data-harness-index="${index}"`
        : "disabled";
      return `
        <button type="button" class="choice-button" ${selectionAttribute} aria-pressed="${launchDraft.harnessIndex === index}">
          <span>
            <strong>${harness.name}</strong>
            <small>${harness.detail}</small>
          </span>
          <span class="choice-meta">${launchDraft.harnessIndex === index ? "Selected" : harness.available ? ">" : "—"}</span>
        </button>`;
    })
    .join("");
}

function harnessConfiguration() {
  if (launchDraft.harnessIndex === null) return "";

  const harness = harnesses[launchDraft.harnessIndex];
  const modelOptions = harness.models
    .map(
      (model) =>
        `<option value="${model}" ${launchDraft.model === model ? "selected" : ""}>${model}</option>`,
    )
    .join("");

  return `<aside class="panel configuration-panel">
    <h2>Configure ${harness.name}</h2>
    <div class="panel-body form-fields">
      <div class="field">
        <label for="launch-model">Model</label>
        <select id="launch-model" data-launch-model>${modelOptions}</select>
      </div>
      <div class="mini">
        <b>Session continuity</b>
        ${harness.detail}
      </div>
      <div class="launch-actions">
        <button type="button" class="primary" data-launch-next="${launchSequence()[2]}">Continue</button>
      </div>
    </div>
  </aside>`;
}

function launchHarnessStep() {
  const layoutClass =
    launchDraft.harnessIndex === null
      ? "harness-layout single"
      : "harness-layout";

  return `${launchHeading("Choose a Harness")}
    <div class="launch-content ${layoutClass}">
      <div class="choice-list">${harnessChoices()}</div>
      ${harnessConfiguration()}
    </div>`;
}

function inputLabel(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function launchInputControl(input, problem) {
  const value = launchDraft.inputValues[input.name] || "";
  const problemAttributes = problem
    ? `aria-invalid="true" aria-describedby="launch-input-${input.name}-problem"`
    : "";
  const attributes = `id="launch-input-${input.name}" data-launch-input="${input.name}" ${problemAttributes}`;

  if (input.type === "choice") {
    const options = input.choices
      .map(
        (choice) =>
          `<option value="${escapeHtml(choice)}" ${value === choice ? "selected" : ""}>${escapeHtml(choice)}</option>`,
      )
      .join("");
    return `<select ${attributes}><option value="">Select one</option>${options}</select>`;
  }

  if (input.type === "verdict") {
    return `<select ${attributes}>
      <option value="">Select one</option>
      <option value="pass" ${value === "pass" ? "selected" : ""}>Pass</option>
      <option value="fail" ${value === "fail" ? "selected" : ""}>Fail</option>
    </select>`;
  }

  if (input.type === "file-set") {
    return `<textarea ${attributes} placeholder="One file path per line">${escapeHtml(value)}</textarea>`;
  }

  return `<input type="text" ${attributes} value="${escapeHtml(value)}" placeholder="${escapeHtml(input.placeholder || "")}" />`;
}

function launchInputFields() {
  return selectedBundle()
    .inputs.map((input) => {
      const problem = launchDraft.inputProblems[input.name];
      return `<div class="field">
        <div class="field-heading">
          <label for="launch-input-${input.name}">${inputLabel(input.name)}</label>
          <span class="tag">${input.type}</span>
        </div>
        <span class="field-description">${input.description}</span>
        ${launchInputControl(input, problem)}
        ${problem ? `<span id="launch-input-${input.name}-problem" class="field-problem" role="alert" data-input-problem="${input.name}">${problem}</span>` : ""}
      </div>`;
    })
    .join("");
}

function validateLaunchInput(input) {
  const value = (launchDraft.inputValues[input.name] || "").trim();
  if (!value) return "Required by this Workflow Bundle.";

  if (input.type === "file" && value.toLowerCase().includes("missing")) {
    return "No existing, non-empty file was found at this path.";
  }

  if (input.type === "file-set") {
    const paths = value
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    if (paths.some((path) => path.toLowerCase().includes("missing"))) {
      return "One or more files do not exist or are empty.";
    }
  }

  if (
    input.schema &&
    input.type === "file" &&
    value.toLowerCase().includes("invalid")
  ) {
    return `The JSON file does not match ${input.schema}.`;
  }

  return "";
}

function validateLaunchInputs() {
  launchDraft.inputProblems = Object.fromEntries(
    selectedBundle()
      .inputs.map((input) => [input.name, validateLaunchInput(input)])
      .filter(([, problem]) => problem),
  );
  return Object.keys(launchDraft.inputProblems).length === 0;
}

function launchInputsStep() {
  const bundle = selectedBundle();

  return `${launchHeading(`Provide inputs for ${bundle.name}`)}
    <div class="launch-content launch-content-narrow">
      <div class="form-fields">${launchInputFields()}</div>
      <div class="launch-actions">
        <button type="button" class="primary" data-launch-next="review">Review Run</button>
      </div>
    </div>`;
}

function launchInputReviewItems(bundle) {
  return bundle.inputs
    .map((input) => {
      const value = escapeHtml(launchDraft.inputValues[input.name]).replaceAll(
        "\n",
        "<br />",
      );
      return `<div class="review-item"><span class="muted">${inputLabel(input.name)}</span><span>${value}</span></div>`;
    })
    .join("");
}

function launchReviewStep() {
  const bundle = workflowBundles[launchDraft.bundleIndex];
  const harness = harnesses[launchDraft.harnessIndex];
  const isTrusted = trustedBundleDigests.has(bundle.digest);
  const canStart = isTrusted || launchDraft.trustApproved;

  return `${launchHeading("Review and start")}
    <div class="launch-content launch-content-narrow">
      <div class="review-list">
        <div class="review-item"><span class="muted">Workflow</span><strong>${bundle.name}</strong></div>
        <div class="review-item"><span class="muted">Bundle digest</span><span>${bundle.digest}</span></div>
        <div class="review-item"><span class="muted">Workspace</span><span><strong>${escapeHtml(sample.workspaceName)}</strong><br />${escapeHtml(sample.workspace)}</span></div>
        <div class="review-item"><span class="muted">Harness</span><span>${harness.name} · ${launchDraft.model}</span></div>
        ${launchInputReviewItems(bundle)}
      </div>
      <div class="launch-actions">
        <button type="button" class="primary" data-start-run ${canStart ? "" : "disabled"}>Start Run</button>
      </div>
    </div>`;
}

function launchStepContent() {
  if (launchDraft.step === "bundle") return launchBundleStep();
  if (launchDraft.step === "harness") return launchHarnessStep();
  if (launchDraft.step === "inputs") return launchInputsStep();
  return launchReviewStep();
}

function variantA() {
  return `<section class="screen variant-a">
    ${topLine("A")}
    <div class="launch-shell">${launchStepContent()}</div>
    ${switcher("A")}
  </section>`;
}

function variantB() {
  const runState = runWorkbenchState();
  return `
    <section class="screen variant-b">
      ${topLine("B")}
      <main class="run-shell ${runWorkbench.detailsOpen ? "details-visible" : ""}">
        <section class="run-main" aria-label="Active Run">
          ${runHeader(runState)}
          ${runProgress(runState)}
          <div class="run-timeline" aria-label="Run timeline">
            ${runWorkbench.olderLoaded ? runEarlierActivity() : `<button type="button" class="load-earlier" data-run-load-earlier>Load earlier activity</button>`}
            ${runTimeline()}
          </div>
          ${runInteractionDock()}
        </section>
        ${runDetails(runState)}
        ${runResourceInspector()}
      </main>
      ${runStateSwitcher()}
      ${switcher("B")}
    </section>
  `;
}

function resumedHistoryRun() {
  return previousRuns.find((run) => run.id === runWorkbench.historyRunId);
}

function activeRunPresentation() {
  const run = resumedHistoryRun();
  if (!run) {
    return {
      id: sample.run,
      title: "Test Repair",
      bundle: "Test Repair 1.0.0",
      steps: ["Run failing test", "Fix test", "Approve fix", "Commit fix"],
      currentStep: 2,
      iteration: "Iteration 2",
      position: "Fix test · Iteration 2 · Attempt 1",
    };
  }

  const workflows = {
    "io.devflow.test-repair": {
      steps: ["Run failing test", "Fix test", "Approve fix", "Commit fix"],
      currentStep: 2,
      iteration: "Iteration 2",
    },
    "io.devflow.issue-to-pr": {
      steps: [
        "Prepare implementation",
        "Implement issue",
        "Verify implementation",
        "Open pull request",
      ],
      currentStep: 3,
      iteration: "Iteration 1",
    },
    "io.devflow.diff-review": {
      steps: ["Collect diff", "Review changes", "Confirm findings"],
      currentStep: 2,
      iteration: "",
    },
  };
  const workflow = workflows[run.bundleId] || {
    steps: ["Continue workflow"],
    currentStep: 1,
    iteration: "",
  };

  return {
    id: run.id,
    title: run.bundleName,
    bundle: run.bundleName,
    steps: workflow.steps,
    currentStep: workflow.currentStep,
    iteration: workflow.iteration,
    position: run.position,
  };
}

function runWorkbenchState() {
  const activeRun = activeRunPresentation();
  const states = {
    running: {
      status: status("*", "info", "Running"),
      step: activeRun.currentStep,
      iteration: activeRun.iteration,
      position: activeRun.position,
    },
    gate: {
      status: status("!", "warn", "Waiting for approval"),
      step: 3,
      iteration: "",
      position: "Approve fix",
    },
    request: {
      status: status("?", "warn", "Codex needs a response"),
      step: 2,
      iteration: "Iteration 2",
      position: "Fix test · Iteration 2 · Attempt 1",
    },
    question: {
      status: status("?", "info", "Agent asked a question"),
      step: 2,
      iteration: "Iteration 2",
      position: "Fix test · Iteration 2 · Attempt 1",
    },
    committing: {
      status: status("*", "info", "Running"),
      step: 4,
      iteration: "",
      position: "Commit fix · Attempt 1",
    },
    failed: {
      status: status("x", "bad", "Stopped"),
      step: 3,
      iteration: "",
      position: "Approve fix",
    },
  };
  return states[runWorkbench.mode] || states.running;
}

function runHeader(runState) {
  const activeRun = activeRunPresentation();
  return `<header class="run-header">
    <button type="button" class="icon-button" aria-label="Back to Workspace home" title="Back to Workspace home" data-view="H">&larr;</button>
    <div class="run-title">
      <h1>${escapeHtml(activeRun.title)}</h1>
      <p>${escapeHtml(activeRun.id)} · ${runState.status}</p>
    </div>
    <button type="button" class="details-toggle" aria-expanded="${runWorkbench.detailsOpen}" data-run-details>${runWorkbench.detailsOpen ? "Hide details" : "Details"}</button>
  </header>`;
}

function runProgress(runState) {
  const steps = activeRunPresentation().steps.map((label, index) => [
    label,
    index + 1,
  ]);
  const items = steps
    .map(([label, index]) => {
      const state =
        index < runState.step
          ? "complete"
          : index === runState.step
            ? "current"
            : "upcoming";
      const marker =
        state === "complete" ? "+" : state === "current" ? ">" : " ";
      return `<li class="${state}"><span aria-hidden="true">[${marker}]</span>${label}</li>`;
    })
    .join("");

  return `<section class="run-progress" aria-label="Workflow progress">
    <div class="run-progress-heading">
      <span>Step ${runState.step} of ${steps.length}</span>
      ${runState.iteration ? `<span>${runState.iteration}</span>` : ""}
    </div>
    <ol>${items}</ol>
  </section>`;
}

function runTimeline() {
  const resumedRun = resumedHistoryRun();
  if (resumedRun) {
    const priorStateClass =
      resumedRun.state === "failed" ? "failed-activity" : "milestone";
    const priorMarker = resumedRun.state === "failed" ? "x" : "!";
    return `<article class="activity ${priorStateClass}">
      <div class="activity-marker">${priorMarker}</div>
      <div><header><strong>Run ${escapeHtml(resumedRun.stateLabel.toLowerCase())}</strong><span>${escapeHtml(resumedRun.latestActivity)}</span></header><p>${escapeHtml(resumedRun.reason)}</p></div>
    </article>
    <div class="run-notice">${escapeHtml(runWorkbench.notice)}</div>
    <article class="activity current">
      <div class="activity-marker">*</div>
      <div><header><strong>Codex is working</strong><span>now</span></header><p>Continuing ${escapeHtml(resumedRun.position)}.</p><p class="activity-preview">The existing Harness Session and Run history remain attached to this Run.</p></div>
    </article>`;
  }

  const pendingEntry = {
    running: `<article class="activity current">
      <div class="activity-marker">*</div>
      <div><header><strong>Codex is working</strong><span>now</span></header><p>Checking the updated assertion against the focused test.</p><p class="activity-preview">Running <code>npm test -- tests/example.test.ts</code></p></div>
    </article>`,
    gate: `<article class="activity milestone">
      <div class="activity-marker">!</div>
      <div><header><strong>Workflow approval</strong><span>now</span></header><p>The generated patch is ready for your review.</p></div>
    </article>`,
    request: `<article class="activity current">
      <div class="activity-marker">?</div>
      <div><header><strong>Codex requested access</strong><span>now</span></header><p>The request belongs to the current Harness Turn and is waiting below.</p></div>
    </article>`,
    question: `<article class="activity message">
      <div class="activity-marker">?</div>
      <div><header><strong>Codex</strong><span>${sample.effectiveModel} · now</span></header><p>The focused test has two valid outcomes. Should I preserve the existing API behavior or update the expectation?</p></div>
    </article>`,
    committing: `<article class="activity current">
      <div class="activity-marker">*</div>
      <div><header><strong>Commit fix</strong><span>now</span></header><p>Running the Bundle-declared commit command.</p></div>
    </article>`,
    failed: `<article class="activity failed-activity">
      <div class="activity-marker">x</div>
      <div><header><strong>Run stopped</strong><span>now</span></header><p>The generated patch was not approved. No commit was created.</p></div>
    </article>`,
  }[runWorkbench.mode];

  return `<article class="activity milestone">
      <div class="activity-marker">+</div>
      <div><header><strong>Run failing test</strong><span>10:41</span></header><p>The test failed as expected. Output saved as <button type="button" class="text-button" data-run-resource="test-output">test-output</button>.</p></div>
    </article>
    <article class="activity tool-activity">
      <div class="activity-marker">#</div>
      <div><header><strong>Command completed</strong><span>exit 1 · 4.2s</span></header><p><code>npm test -- tests/example.test.ts</code></p></div>
    </article>
    <article class="activity message">
      <div class="activity-marker">C</div>
      <div><header><strong>Codex</strong><span>${sample.effectiveModel} · 10:43</span></header><p>The failure comes from an outdated assertion. I updated the expectation and kept the public behavior unchanged.</p><button type="button" class="activity-link" data-run-resource="candidate">View 2 changed files</button></div>
    </article>
    ${runWorkbench.notice ? `<div class="run-notice">${escapeHtml(runWorkbench.notice)}</div>` : ""}
    ${pendingEntry}`;
}

function runEarlierActivity() {
  const resumedRun = resumedHistoryRun();
  if (resumedRun) {
    return `<div class="earlier-activity">
      <span>Earlier activity loaded</span>
      <article class="activity milestone">
        <div class="activity-marker">+</div>
        <div><header><strong>Run started</strong><span>Earlier</span></header><p>${escapeHtml(resumedRun.bundleName)} started in ${escapeHtml(sample.workspaceName)} with ${sample.harness}.</p></div>
      </article>
    </div>`;
  }

  return `<div class="earlier-activity">
    <span>Earlier activity loaded</span>
    <article class="activity milestone">
      <div class="activity-marker">+</div>
      <div><header><strong>Run started</strong><span>10:40</span></header><p>Test Repair started in ${escapeHtml(sample.workspaceName)} with ${sample.harness}.</p></div>
    </article>
  </div>`;
}

function runInteractionDock() {
  if (runWorkbench.mode === "gate") {
    return `<section class="interaction-dock gate-dock" aria-label="Workflow approval">
      <div class="dock-label">Workflow approval · remains here until answered</div>
      <h2>Approve the generated patch?</h2>
      <p>Test Repair will commit the fix only if you approve it.</p>
      <div class="dock-actions">
        <button type="button" data-run-answer="rejected">Reject</button>
        <button type="button" class="primary" data-run-answer="approved">Approve</button>
      </div>
    </section>`;
  }

  if (runWorkbench.mode === "request") {
    return `<section class="interaction-dock request-dock" aria-label="Harness request">
      <div class="dock-label">Harness request · Codex · current Turn only</div>
      <h2>Allow access outside the Workspace?</h2>
      <p>Codex wants to read <code>~/.npmrc</code> while checking the test command.</p>
      <div class="dock-actions">
        <button type="button" data-run-answer="denied">Deny</button>
        <button type="button" class="primary" data-run-answer="allowed once">Allow once</button>
      </div>
    </section>`;
  }

  if (runWorkbench.mode === "question") {
    return `<section class="interaction-dock question-dock" aria-label="Agent question">
      <div class="dock-label">Agent question · reply continues this interactive step</div>
      <label for="run-reply">Your reply</label>
      <div class="reply-row">
        <textarea id="run-reply" rows="2" placeholder="Tell Codex which behavior to preserve..." data-run-reply></textarea>
        <button type="button" class="primary" data-run-send>Send</button>
      </div>
    </section>`;
  }

  if (runWorkbench.mode === "running") {
    return `<section class="interaction-dock steer-dock" aria-label="Steer current Turn">
      <div class="dock-label">Live control · current Codex Turn</div>
      <label for="run-steer">Steer while Codex is working</label>
      <div class="steer-row">
        <textarea id="run-steer" rows="1" placeholder="Add direction for the current Turn..." data-run-steer-input></textarea>
        <button type="button" class="primary" data-run-steer>Steer</button>
        <button type="button" disabled aria-describedby="interrupt-unavailable">Interrupt</button>
      </div>
      <p id="interrupt-unavailable">Interrupt unavailable: this Codex Session cannot interrupt mid-Turn.</p>
    </section>`;
  }

  return `<footer class="run-working">
    ${runWorkbench.mode === "failed" ? `<span class="failed-mark" aria-hidden="true">x</span><span>This Run has stopped.</span>` : `<span class="working-pulse" aria-hidden="true">*</span><span>${runWorkbench.mode === "committing" ? "Running Commit fix" : "Codex is working on Fix test"} · ${sample.effectiveModel}</span>`}
  </footer>`;
}

function runDetails(runState) {
  if (!runWorkbench.detailsOpen) return "";

  const activeRun = activeRunPresentation();
  const inspectActions = resumedHistoryRun()
    ? ""
    : `<h3>Inspect</h3>
    <div class="resource-actions">
      <button type="button" data-run-resource="artifacts">Artifacts</button>
      <button type="button" data-run-resource="transcript">Transcript</button>
      <button type="button" data-run-resource="diagnostics">Diagnostics</button>
    </div>`;

  return `<aside class="run-details" aria-label="Run details">
    <div class="run-details-heading">
      <h2>Run details</h2>
      <button type="button" class="icon-button" aria-label="Close Run details" title="Close Run details" data-run-details>&times;</button>
    </div>
    <dl>
      <div><dt>Workspace</dt><dd>${escapeHtml(sample.workspaceName)}</dd></div>
      <div><dt>Bundle</dt><dd>${escapeHtml(activeRun.bundle)}</dd></div>
      <div><dt>Harness</dt><dd>${sample.harness}</dd></div>
      <div><dt>Current</dt><dd>${runState.position}</dd></div>
      <div><dt>Requested</dt><dd>${sample.requestedModel}</dd></div>
      <div><dt>Effective</dt><dd>${sample.effectiveModel}</dd></div>
    </dl>
    ${inspectActions}
  </aside>`;
}

function runResourceInspector() {
  if (!runWorkbench.resource) return "";

  const resources = {
    artifacts: {
      title: "Run Artifacts",
      meta: "Published values available to this Run",
      body: `<div class="artifact-index">
        <button type="button" data-run-resource="test-output"><strong>test-output</strong><span>Text · Run failing test · Iteration 1</span></button>
        <button type="button" data-run-resource="candidate"><strong>proposed-patch</strong><span>File set · Fix test · Iteration 2</span></button>
      </div>`,
    },
    "test-output": {
      title: "test-output",
      meta: "Text Artifact · Run failing test · Iteration 1",
      body: `<pre class="resource-code">FAIL tests/example.test.ts

  example response
    Expected status: 201
    Received status: 200

  1 failed, 7 passed
  Command exited with code 1 after 4.2s</pre>`,
    },
    candidate: {
      title: "2 changed files",
      meta: "Retained Candidate output · Fix test · Iteration 2",
      body: `<div class="changed-file-list">
        <span><strong>tests/example.test.ts</strong><b>+2 -2</b></span>
        <span><strong>src/example.ts</strong><b>+1 -1</b></span>
      </div>
      <pre class="resource-code diff-code"><span class="diff-file">tests/example.test.ts</span>
<span class="diff-remove">- expect(response.status).toBe(201);</span>
<span class="diff-add">+ expect(response.status).toBe(200);</span>

<span class="diff-file">src/example.ts</span>
<span class="diff-remove">- return buildResponse(payload);</span>
<span class="diff-add">+ return buildResponse(normalize(payload));</span></pre>`,
    },
    transcript: {
      title: "Codex transcript",
      meta: "Current Harness Session · 18 entries",
      body: `<div class="transcript-view">
        <p><strong>You</strong><span>Fix the focused failing test without changing the public behavior.</span></p>
        <p><strong>Codex</strong><span>I found an outdated assertion and updated the expected status.</span></p>
        <p><strong>Tool</strong><span><code>npm test -- tests/example.test.ts</code></span></p>
        <p><strong>Codex</strong><span>The focused test now passes. I am checking the full suite.</span></p>
      </div>`,
    },
    diagnostics: {
      title: "Diagnostics",
      meta: "Run and Harness diagnostic evidence",
      body: `<div class="empty-resource"><strong>No active diagnostic findings</strong><span>Earlier diagnostic entries remain in the Run timeline.</span></div>`,
    },
  };
  const resource = resources[runWorkbench.resource];
  if (!resource) return "";

  return `<section class="resource-inspector" aria-label="${resource.title}">
    <header>
      <div><h2>${resource.title}</h2><p>${resource.meta}</p></div>
      <button type="button" class="icon-button" aria-label="Close details" title="Close details" data-run-resource-close>&times;</button>
    </header>
    <div class="resource-inspector-body">${resource.body}</div>
  </section>`;
}

function runStateSwitcher() {
  const modes = [
    ["running", "Working"],
    ["gate", "Workflow approval"],
    ["request", "Harness request"],
    ["question", "Agent question"],
  ];
  return `<nav class="run-state-switcher" aria-label="Run state prototype switcher">
    <span>Prototype state</span>
    ${modes.map(([mode, label]) => `<button type="button" data-run-mode="${mode}" aria-pressed="${runWorkbench.mode === mode}">${label}</button>`).join("")}
  </nav>`;
}

function variantC() {
  return `
    <section class="screen variant-c">
      ${topLine("C")}
      <div class="grid layout">
        <section class="panel nav">
          <h2>Projection Families</h2>
          <div class="panel-body">
            <button>Bundle catalog</button>
            <button>Harness catalog</button>
            <button class="primary">Launch preparation</button>
            <button>Run list</button>
            <button>Exact Run</button>
            <button>Operation</button>
          </div>
        </section>

        <section class="panel">
          <h2>Focused Inspector</h2>
          <div class="panel-body list">
            ${row("focus", `<strong>${sample.bundle}</strong><br />highest stable installed version`, status("+", "ok", "Compatible"))}
            ${row("origin", "local file: ~/Downloads/test-repair.wfb", "")}
            ${row("routing", "command -> repeat(agent, command) -> human gate -> command", "")}
            ${row("trust", "not trusted for digest", status("*", "warn", "Grant offer shown"))}
            ${row("harness", `${sample.harness}; requested ${sample.requestedModel}`, status("+", "ok", "Qualified"))}
            ${row("workspace", escapeHtml(sample.workspace), status("+", "ok", "Preflight passes"))}
          </div>
        </section>

        <section class="panel">
          <h2>Projection Port Shape</h2>
          <div class="panel-body">
            <div class="diagram">
              <div class="mini"><b>Durable Snapshot</b>Run state, pending Human Gate, artifacts, recovery evidence, available actions.</div>
              <div class="mini"><b>Live Overlay</b>Turn phase, Harness Requests, current activity, usage, replaceable preview.</div>
              <div class="mini"><b>Resources</b>Older pages, transcript export, artifact bytes, file sets, diagnostics.</div>
              <div class="mini"><b>Action Offers</b>Only exact offered commands. Unavailable reasons shown when relevant.</div>
              <div class="mini"><b>Operation</b>Admission/result receipt. Not the main progress surface.</div>
              <div class="mini"><b>Headless Parity</b>Same semantic families; no TUI-only state reducers.</div>
            </div>
          </div>
        </section>
        ${stateDump("C")}
      </div>
      ${switcher("C")}
    </section>
  `;
}

function render() {
  const key = currentVariantKey();
  const app = document.getElementById("app");
  const fallback = document.getElementById("fallback");
  if (fallback) fallback.style.display = "none";
  app.innerHTML =
    key === "H"
      ? workspaceHome()
      : key === "W"
        ? workspaceApprovalScreen()
        : key === "A"
          ? variantA()
          : key === "R"
            ? previousRunsScreen()
            : key === "B"
              ? variantB()
              : variantC();
  document.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("click", () => cycle(Number(button.dataset.dir)));
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.view));
  });

  const historyBackButton = document.querySelector("[data-history-back]");
  if (historyBackButton) {
    historyBackButton.addEventListener("click", () => {
      if (runHistory.openedRunId) {
        runHistory.openedRunId = null;
        render();
        return;
      }
      setVariant("H");
    });
  }

  document.querySelectorAll("[data-run-list-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      runHistory.filter = button.dataset.runListFilter;
      runHistory.loadingOlder = false;
      render();
      document.querySelector("[data-previous-run-id]")?.focus();
    });
  });

  document.querySelectorAll("[data-run-list-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setRunListMode(button.dataset.runListMode);
    });
  });

  document.querySelectorAll("[data-previous-run-id]").forEach((button) => {
    button.addEventListener("click", () => {
      runHistory.openedRunId = button.dataset.previousRunId;
      render();
    });
  });

  const loadOlderRunsButton = document.querySelector("[data-load-older-runs]");
  if (loadOlderRunsButton) {
    loadOlderRunsButton.addEventListener("click", () => {
      runHistory.loadingOlder = true;
      render();
      setTimeout(() => {
        runHistory.loadingOlder = false;
        runHistory.olderLoaded = true;
        render();
      }, 550);
    });
  }

  const resumePreviousRunButton = document.querySelector(
    "[data-resume-previous-run]",
  );
  if (resumePreviousRunButton) {
    resumePreviousRunButton.addEventListener("click", () => {
      runHistory.resumedRunIds.add(runHistory.openedRunId);
      runWorkbench.historyRunId = runHistory.openedRunId;
      runWorkbench.mode = "running";
      runWorkbench.notice = "Resume applied. Continuing the existing Run.";
      runWorkbench.detailsOpen = false;
      runWorkbench.resource = null;
      runWorkbench.olderLoaded = false;
      setVariant("B");
    });
  }

  const workspaceApproveButton = document.querySelector(
    "[data-workspace-approve]",
  );
  if (workspaceApproveButton) {
    workspaceApproveButton.addEventListener("click", () => {
      workspaceApproval.approvedPaths.add(sample.workspace);
      workspaceApproval.declined = false;
      persistWorkspaceApprovals();
      setVariant("H");
    });
  }

  const workspaceDeclineButton = document.querySelector(
    "[data-workspace-decline]",
  );
  if (workspaceDeclineButton) {
    workspaceDeclineButton.addEventListener("click", () => {
      workspaceApproval.declined = true;
      render();
    });
  }
  document.querySelectorAll("[data-bundle-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const bundleIndex = Number(button.dataset.bundleIndex);
      launchDraft.bundleIndex = bundleIndex;
      launchDraft.harnessIndex = null;
      launchDraft.model = "";
      launchDraft.inputValues = {};
      launchDraft.inputProblems = {};
      launchDraft.trustApproved = false;
      render();
      document.querySelector(`[data-bundle-index="${bundleIndex}"]`).focus();
    });
  });
  document.querySelectorAll("[data-harness-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const harnessIndex = Number(button.dataset.harnessIndex);
      launchDraft.harnessIndex = harnessIndex;
      launchDraft.model = harnesses[launchDraft.harnessIndex].models[0];
      render();
      document.querySelector(`[data-harness-index="${harnessIndex}"]`).focus();
    });
  });

  const modelSelect = document.querySelector("[data-launch-model]");
  if (modelSelect) {
    modelSelect.addEventListener("change", () => {
      launchDraft.model = modelSelect.value;
    });
  }

  const launchInputs = document.querySelectorAll("[data-launch-input]");
  const nextButton = document.querySelector("[data-launch-next]");
  launchInputs.forEach((input) => {
    input.addEventListener("input", () => {
      const inputName = input.dataset.launchInput;
      launchDraft.inputValues[inputName] = input.value;
      delete launchDraft.inputProblems[inputName];
      input.removeAttribute("aria-invalid");
      document.querySelector(`[data-input-problem="${inputName}"]`)?.remove();
    });
  });
  if (nextButton) {
    nextButton.addEventListener("click", () => {
      if (
        launchDraft.step === "inputs" &&
        nextButton.dataset.launchNext === "review" &&
        !validateLaunchInputs()
      ) {
        render();
        document.querySelector('[aria-invalid="true"]')?.focus();
        return;
      }
      launchDraft.step = nextButton.dataset.launchNext;
      render();
    });
  }

  const backButton = document.querySelector("[data-launch-back]");
  if (backButton) {
    backButton.addEventListener("click", () => {
      if (backButton.dataset.launchBack === "home") {
        setVariant("H");
        return;
      }
      launchDraft.step = backButton.dataset.launchBack;
      render();
    });
  }

  const trustConfirmation = document.querySelector("[data-trust-confirmation]");
  if (trustConfirmation) {
    trustConfirmation.addEventListener("change", () => {
      launchDraft.trustApproved = trustConfirmation.checked;
      render();
    });
  }

  const startRunButton = document.querySelector("[data-start-run]");
  if (startRunButton) {
    startRunButton.addEventListener("click", () => {
      trustedBundleDigests.add(selectedBundle().digest);
      runWorkbench.mode = "running";
      runWorkbench.historyRunId = null;
      runWorkbench.notice = "";
      runWorkbench.olderLoaded = false;
      setVariant("B");
    });
  }

  document.querySelectorAll("[data-run-details]").forEach((button) => {
    button.addEventListener("click", () => {
      runWorkbench.detailsOpen = !runWorkbench.detailsOpen;
      if (!runWorkbench.detailsOpen) runWorkbench.resource = null;
      render();
    });
  });

  document.querySelectorAll("[data-run-resource]").forEach((button) => {
    button.addEventListener("click", () => {
      runWorkbench.resource = button.dataset.runResource;
      render();
    });
  });

  const resourceCloseButton = document.querySelector(
    "[data-run-resource-close]",
  );
  if (resourceCloseButton) {
    resourceCloseButton.addEventListener("click", () => {
      runWorkbench.resource = null;
      render();
    });
  }

  document.querySelectorAll("[data-run-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      runWorkbench.notice = "";
      setRunMode(button.dataset.runMode);
    });
  });

  document.querySelectorAll("[data-run-answer]").forEach((button) => {
    button.addEventListener("click", () => {
      const interaction = runWorkbench.mode;
      runWorkbench.notice =
        interaction === "gate"
          ? `Workflow approval ${button.dataset.runAnswer}.`
          : `Harness request ${button.dataset.runAnswer}.`;
      runWorkbench.mode =
        interaction === "gate"
          ? button.dataset.runAnswer === "approved"
            ? "committing"
            : "failed"
          : "running";
      render();
    });
  });

  const loadEarlierButton = document.querySelector("[data-run-load-earlier]");
  if (loadEarlierButton) {
    loadEarlierButton.addEventListener("click", () => {
      runWorkbench.olderLoaded = true;
      render();
    });
  }

  const runSendButton = document.querySelector("[data-run-send]");
  if (runSendButton) {
    runSendButton.addEventListener("click", () => {
      const reply = document.querySelector("[data-run-reply]").value.trim();
      if (!reply) {
        document.querySelector("[data-run-reply]").focus();
        return;
      }
      runWorkbench.notice = `You replied: ${reply}`;
      runWorkbench.mode = "running";
      render();
    });
  }

  const runSteerButton = document.querySelector("[data-run-steer]");
  if (runSteerButton) {
    runSteerButton.addEventListener("click", () => {
      const direction = document
        .querySelector("[data-run-steer-input]")
        .value.trim();
      if (!direction) {
        document.querySelector("[data-run-steer-input]").focus();
        return;
      }
      runWorkbench.notice = `Steering accepted: ${direction}`;
      render();
    });
  }
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  const isEditable = target && target.isContentEditable;
  if (event.key === "Escape") {
    const backButton = document.querySelector("[data-launch-back]");
    if (backButton) {
      event.preventDefault();
      backButton.click();
      return;
    }
    const historyBackButton = document.querySelector("[data-history-back]");
    if (historyBackButton) {
      event.preventDefault();
      historyBackButton.click();
    }
    return;
  }
  if (tag === "input" || tag === "select" || tag === "textarea" || isEditable)
    return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const choices = Array.from(
      document.querySelectorAll(".choice-button, [data-keyboard-choice]"),
    );
    if (choices.length > 0) {
      event.preventDefault();
      const currentIndex = choices.indexOf(document.activeElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex === -1
          ? offset === 1
            ? 0
            : choices.length - 1
          : (currentIndex + offset + choices.length) % choices.length;
      choices[nextIndex].focus();
    }
    return;
  }
  if (event.key === "ArrowLeft") cycle(-1);
  if (event.key === "ArrowRight") cycle(1);
});

render();
