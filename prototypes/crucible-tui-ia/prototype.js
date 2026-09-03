/* global document, history, location */

const variants = {
  H: {
    name: "Workspace Home",
    thesis:
      "Start with one Workspace and a small set of real paths, then reveal detail only after the user chooses a task.",
  },
  W: {
    name: "Workspace Resolution",
    thesis:
      "Keep the current directory on the common path while allowing an explicit existing directory without adding a Workspace browser.",
  },
  A: {
    name: "Progressive Launch",
    thesis:
      "Ask for one launch decision at a time, then show trust and preflight evidence only at final review.",
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

const currentDirectory = {
  name: "example-service",
  path: "/Users/rohan/src/example-service",
};

const workspaceDraft = {
  enteringPath: false,
  path: "",
  problem: "",
};

const trustedBundleDigests = new Set(
  workflowBundles
    .filter((bundle) => bundle.origin === "Built in")
    .map((bundle) => bundle.digest),
);

function currentVariantKey() {
  const key = new URLSearchParams(location.search).get("variant") || "H";
  return variants[key] ? key : "H";
}

function setVariant(next) {
  const params = new URLSearchParams(location.search);
  params.set("variant", next);
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

function resetWorkspaceDraft() {
  workspaceDraft.enteringPath = false;
  workspaceDraft.path = "";
  workspaceDraft.problem = "";
}

function openView(next) {
  if (next === "A") resetLaunchDraft();
  if (next === "W") resetWorkspaceDraft();
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
          <p class="workspace-path">
            <span>${escapeHtml(sample.workspace)}</span>
            <button type="button" class="workspace-change" data-view="W">Change Workspace</button>
          </p>
          <nav class="home-actions" aria-label="Workspace actions">
            <button type="button" class="primary" data-view="A">Start a Run</button>
            <button type="button" data-view="C">Workflow Bundles</button>
            <button type="button" data-view="B">Previous Runs</button>
            <button type="button" data-view="C">Harnesses</button>
          </nav>
          <p class="home-summary">4 Workflow Bundles · 3 previous Runs · ${sample.harness} qualified</p>
        </div>
      </main>
      ${switcher("H")}
    </section>
  `;
}

function workspaceResolutionHeading() {
  return `<header class="launch-heading">
    <button type="button" aria-label="Back" title="Back" data-workspace-back>&larr;</button>
    <h1>Choose a Workspace</h1>
    <span></span>
  </header>`;
}

function workspaceChoices() {
  const currentIsActive = sample.workspace === currentDirectory.path;
  return `<div class="choice-list">
    <button type="button" class="choice-button" data-workspace-current aria-pressed="${currentIsActive}">
      <span>
        <strong>Current directory</strong>
        <small>${currentDirectory.name} · ${currentDirectory.path}</small>
      </span>
      <span class="choice-meta">${currentIsActive ? "In use" : "Use"}</span>
    </button>
    <button type="button" class="choice-button" data-workspace-explicit aria-pressed="${workspaceDraft.enteringPath}">
      <span>
        <strong>Enter a path</strong>
        <small>Use another existing directory.</small>
      </span>
      <span class="choice-meta">&gt;</span>
    </button>
  </div>`;
}

function workspacePathPanel() {
  if (!workspaceDraft.enteringPath) return "";

  const problemAttributes = workspaceDraft.problem
    ? 'aria-invalid="true" aria-describedby="workspace-path-problem"'
    : "";
  return `<aside class="panel workspace-path-panel">
    <h2>Workspace path</h2>
    <form class="panel-body form-fields" data-workspace-form>
      <div class="field">
        <label for="workspace-path">Directory</label>
        <input id="workspace-path" type="text" value="${escapeHtml(workspaceDraft.path)}" placeholder="/Users/rohan/src/payments-service" data-workspace-path ${problemAttributes} />
        ${workspaceDraft.problem ? `<span id="workspace-path-problem" class="field-problem" role="alert">${workspaceDraft.problem}</span>` : ""}
      </div>
      <div class="launch-actions">
        <button type="submit" class="primary">Use Workspace</button>
      </div>
    </form>
  </aside>`;
}

function workspaceResolution() {
  const layoutClass = workspaceDraft.enteringPath
    ? "workspace-layout"
    : "workspace-layout single";
  return `<section class="screen variant-w">
    ${topLine("W")}
    <div class="launch-shell">
      ${workspaceResolutionHeading()}
      <div class="launch-content ${layoutClass}">
        ${workspaceChoices()}
        ${workspacePathPanel()}
      </div>
    </div>
    ${switcher("W")}
  </section>`;
}

function isAbsoluteWorkspacePath(path) {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

function normalizedWorkspacePath(path) {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\\\/]$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/[\\\\/]+$/, "");
}

function workspaceNameFromPath(path) {
  const parts = path.split(/[\\\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

function validateWorkspacePath(path) {
  const value = path.trim();
  if (!value) return "Enter a directory path.";
  if (!isAbsoluteWorkspacePath(value)) {
    return "Enter an absolute directory path.";
  }
  if (value.toLowerCase().includes("missing")) {
    return "No directory was found at this path.";
  }
  return "";
}

function activateWorkspace(path, name = workspaceNameFromPath(path)) {
  sample.workspace = normalizedWorkspacePath(path);
  sample.workspaceName = name;
  setVariant("H");
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
  return `
    <section class="screen variant-b">
      ${topLine("B")}
      <div class="grid layout">
        <section class="panel">
          <h2>Runs</h2>
          <div class="panel-body list">
            ${row("active", `<strong>${sample.run}</strong><br />${sample.bundle}<br /><span class="muted">${escapeHtml(sample.workspace)}</span>`, status("!", "warn", "Blocked"))}
            ${row("resting", "run_01JCPREV<br />same Workspace", status(">", "info", "Resumable"))}
            ${row("done", "run_01JCPASS<br />Test Repair", status("+", "ok", "Succeeded"))}
          </div>
        </section>

        <section class="panel timeline">
          <h2>Run Timeline</h2>
          <div class="timeline-scroll">
            <div class="entry"><span class="kind durable">older page</span><div>${status("^", "info", "Load previous session page")} preserves scroll anchor and prepends stable entries.</div></div>
            <div class="entry"><span class="kind durable">durable</span><div>Baseline command produced verdict <code>fail</code> and text artifact <code>test-output</code>.</div></div>
            <div class="entry"><span class="kind durable">durable</span><div>Agent attempt completed with effective model ${sample.effectiveModel}.</div></div>
            <div class="entry"><span class="kind live">live</span><div>Harness request expired with Turn 7; shown as historical evidence, not answerable.</div></div>
            <div class="entry"><span class="kind durable">gate</span><div>${status("!", "warn", "Human Gate pending")} Approve generated patch? Answer becomes Run Artifact <code>approval</code>.</div></div>
            <div class="entry"><span class="kind live">preview</span><div>Current replaceable preview: assistant is summarizing changed files.</div></div>
          </div>
          <div class="compose">
            <input aria-label="Interactive turn input" value="Ask the agent to explain the test failure..." />
            <button>Send turn</button>
            <button>End step</button>
          </div>
        </section>

        <section class="panel">
          <h2>Current Offers</h2>
          <div class="panel-body list">
            ${row("durable", "answer-human-gate", `<button class="primary">Answer</button>`)}
            ${row("live", "send-interactive-turn", `<button>Send</button>`)}
            ${row("live", "steer-turn", `<button>Steer</button>`)}
            ${row("unavailable", "interrupt-turn", status("x", "bad", "Codex session cannot interrupt mid-turn"))}
            ${row("resource", "Artifacts, transcript export, diagnostics", `<button>Inspect</button>`)}
            ${row("operation", "Last submission: applied", status("+", "ok", "Receipt only"))}
          </div>
        </section>
        ${stateDump("B")}
      </div>
      ${switcher("B")}
    </section>
  `;
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
        ? workspaceResolution()
        : key === "A"
          ? variantA()
          : key === "B"
            ? variantB()
            : variantC();
  document.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("click", () => cycle(Number(button.dataset.dir)));
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.view));
  });
  const currentWorkspaceButton = document.querySelector(
    "[data-workspace-current]",
  );
  if (currentWorkspaceButton) {
    currentWorkspaceButton.addEventListener("click", () => {
      activateWorkspace(currentDirectory.path, currentDirectory.name);
    });
  }

  const explicitWorkspaceButton = document.querySelector(
    "[data-workspace-explicit]",
  );
  if (explicitWorkspaceButton) {
    explicitWorkspaceButton.addEventListener("click", () => {
      workspaceDraft.enteringPath = true;
      workspaceDraft.problem = "";
      render();
      document.querySelector("[data-workspace-path]")?.focus();
    });
  }

  const workspacePathInput = document.querySelector("[data-workspace-path]");
  if (workspacePathInput) {
    workspacePathInput.addEventListener("input", () => {
      workspaceDraft.path = workspacePathInput.value;
      workspaceDraft.problem = "";
      workspacePathInput.removeAttribute("aria-invalid");
      document.querySelector("#workspace-path-problem")?.remove();
    });
  }

  const workspaceForm = document.querySelector("[data-workspace-form]");
  if (workspaceForm) {
    workspaceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      workspaceDraft.problem = validateWorkspacePath(workspaceDraft.path);
      if (workspaceDraft.problem) {
        render();
        document.querySelector("[data-workspace-path]")?.focus();
        return;
      }
      activateWorkspace(workspaceDraft.path);
    });
  }

  const workspaceBackButton = document.querySelector("[data-workspace-back]");
  if (workspaceBackButton) {
    workspaceBackButton.addEventListener("click", () => setVariant("H"));
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
      setVariant("B");
    });
  }
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  const isEditable = target && target.isContentEditable;
  if (event.key === "Escape") {
    const backButton = document.querySelector(
      "[data-launch-back], [data-workspace-back]",
    );
    if (backButton) {
      event.preventDefault();
      backButton.click();
    }
    return;
  }
  if (tag === "input" || tag === "select" || tag === "textarea" || isEditable)
    return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const choices = Array.from(document.querySelectorAll(".choice-button"));
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
