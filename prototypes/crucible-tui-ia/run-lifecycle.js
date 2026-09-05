/* global activeRunPresentation, render, runHistory, runWorkbench, setVariant, status */

globalThis.runLifecyclePrototype = (() => {
  const runModeDefinitions = {
    running: "Working",
    gate: "Workflow approval",
    request: "Harness request",
    question: "Agent question",
    succeeded: "Succeeded",
    cancelled: "Cancelled",
    failed: "Failed",
    halted: "Halted",
    indeterminate: "Indeterminate attempt",
    "session-lost": "Lost Harness Session",
    "expired-resource": "Expired diagnostics",
  };

  function runLifecycleTimelineEntry() {
    const failedAtApproval = runWorkbench.notice.startsWith(
      "Workflow approval rejected",
    );
    const entries = {
      succeeded: `<article class="activity milestone">
      <div class="activity-marker">+</div>
      <div><header><strong>Run succeeded</strong><span>now</span></header><p>Every Workflow step completed and the approved fix was committed.</p></div>
    </article>`,
      cancelled: `<article class="activity failed-activity">
      <div class="activity-marker">x</div>
      <div><header><strong>Run cancelled</strong><span>now</span></header><p>You ended this Run. Its history and published Artifacts remain available until the Run is deleted.</p></div>
    </article>`,
      failed: `<article class="activity failed-activity">
      <div class="activity-marker">x</div>
      <div><header><strong>Run failed</strong><span>now</span></header><p>${failedAtApproval ? "The proposed fix was rejected. No commit was created." : "The focused test was still failing when you stopped at the review checkpoint."}</p></div>
    </article>`,
      halted: `<article class="activity recovery-activity">
      <div class="activity-marker">!</div>
      <div><header><strong>Run halted</strong><span>now</span></header><p>You interrupted the active Codex Turn. Codex confirmed it stopped, so this attempt can be safely tried again.</p></div>
    </article>`,
      indeterminate: `<article class="activity recovery-activity">
      <div class="activity-marker">?</div>
      <div><header><strong>Result unknown</strong><span>now</span></header><p>Crucible started Commit fix but shut down before it observed whether the command completed.</p></div>
    </article>
    <article class="activity tool-activity">
      <div class="activity-marker">#</div>
      <div><header><strong>Reconciliation inconclusive</strong><span>now</span></header><p>The recovery check could not establish whether the commit was created.</p></div>
    </article>`,
      "session-lost": `<article class="activity recovery-activity">
      <div class="activity-marker">!</div>
      <div><header><strong>Harness Session unavailable</strong><span>now</span></header><p>Codex no longer recognizes the <code>repair</code> Session. Crucible kept the Run history and retained transcript, but cannot truthfully continue that conversation.</p></div>
    </article>`,
      "expired-resource": `<article class="activity failed-activity">
      <div class="activity-marker">x</div>
      <div><header><strong>Run failed</strong><span>90 days ago</span></header><p>Fix test exhausted its attempt bounds after Codex stopped unexpectedly.</p><button type="button" class="activity-link" data-run-resource="expired-diagnostics">View detailed diagnostics</button></div>
    </article>`,
    };
    return entries[runWorkbench.mode] || "";
  }

  function recoveryEvidence(rows) {
    return `<dl class="recovery-evidence">
    ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
  </dl>`;
  }

  function runLifecycleDock() {
    const operationPending = runWorkbench.operation?.state === "pending";
    const terminalActions = `<div class="dock-actions">
    <button type="button" class="danger-button" data-run-delete ${operationPending ? "disabled" : ""}>Delete Run</button>
  </div>`;
    const resumableActions = `<div class="dock-actions">
    <button type="button" data-run-cancel ${operationPending ? "disabled" : ""}>Cancel Run</button>
    <button type="button" class="primary" data-run-resume ${operationPending ? "disabled" : ""}>Resume Run</button>
  </div>`;

    if (runWorkbench.mode === "succeeded") {
      return `<section class="interaction-dock lifecycle-dock success-dock" aria-label="Succeeded Run">
      <div class="dock-label">Terminal Run</div>
      <h2>Workflow completed</h2>
      <p>All four Steps completed. This Run cannot resume or be cancelled; its history and Artifacts remain available.</p>
      ${terminalActions}
    </section>`;
    }

    if (runWorkbench.mode === "cancelled") {
      return `<section class="interaction-dock lifecycle-dock" aria-label="Cancelled Run">
      <div class="dock-label">Terminal Run</div>
      <h2>This Run has ended</h2>
      <p>Cancellation is final. The Run cannot resume, but its retained history and Artifacts can still be inspected or deleted together.</p>
      ${terminalActions}
    </section>`;
    }

    if (runWorkbench.mode === "failed") {
      return failedRunDock(resumableActions);
    }

    if (runWorkbench.mode === "halted") {
      return `<section class="interaction-dock lifecycle-dock" aria-label="Halted Run recovery">
      <div class="dock-label">Resting Run · recovery available</div>
      <h2>Execution stopped outside the Workflow</h2>
      <p>Codex confirmed the interrupted Turn ended. Resuming re-attempts Fix test without changing the Run's history.</p>
      ${recoveryEvidence([
        ["Attempt", "Ended as cancelled"],
        ["Workspace", "Will be checked again before resume"],
      ])}
      ${resumableActions}
    </section>`;
    }

    if (runWorkbench.mode === "indeterminate") {
      return indeterminateRunDock(operationPending);
    }

    if (runWorkbench.mode === "session-lost") {
      return `<section class="interaction-dock lifecycle-dock" aria-label="Unavailable Run recovery">
      <div class="dock-label">Halted Run · recovery unavailable</div>
      <h2>The required Codex Session is lost</h2>
      <p>This Workflow requires the existing <code>repair</code> conversation. Crucible will not silently start a new Session and pretend continuity was preserved.</p>
      ${recoveryEvidence([
        ["Session", "repair"],
        ["Recovery", "Codex rejected the saved Session id"],
        ["Retained", "Run history, Artifacts, and captured transcript"],
      ])}
      <div class="dock-actions">
        <button type="button" data-run-cancel>Cancel Run</button>
        <button type="button" disabled aria-describedby="resume-session-lost">Resume Run</button>
      </div>
      <p id="resume-session-lost" class="action-unavailable">Resume unavailable: the required Harness Session cannot be recovered.</p>
    </section>`;
    }

    if (runWorkbench.mode === "expired-resource") {
      return `<section class="interaction-dock lifecycle-dock" aria-label="Failed Run with expired diagnostics">
      <div class="dock-label">Resting Run · recovery available</div>
      <h2>The detailed diagnostics have expired</h2>
      <p>The durable failure reason and timeline remain. Expiration removes supplementary diagnostics only and does not prevent this Run from resuming.</p>
      ${resumableActions}
    </section>`;
    }

    return "";
  }

  function failedRunDock(resumableActions) {
    const failedAtApproval = runWorkbench.notice.startsWith(
      "Workflow approval rejected",
    );
    return `<section class="interaction-dock lifecycle-dock" aria-label="Failed Run recovery">
    <div class="dock-label">Resting Run · recovery available</div>
    <h2>${failedAtApproval ? "The proposed fix was rejected" : "The Workflow reached a negative result"}</h2>
    <p>${failedAtApproval ? "Resuming keeps this Run and returns to Approve fix. The proposed patch and earlier evidence remain available for review." : "Resuming keeps this Run and starts Fix test again with a fresh review interval. Earlier attempts and Artifacts remain unchanged."}</p>
    ${recoveryEvidence([
      [
        "Stopped at",
        failedAtApproval ? "Approve fix" : "Fix test · Iteration 6",
      ],
      [
        "Resume will",
        failedAtApproval
          ? "Offer the same Workflow approval again"
          : "Reset this Step's attempt and iteration allowance",
      ],
    ])}
    ${resumableActions}
  </section>`;
  }

  function indeterminateRunDock(operationPending) {
    return `<section class="interaction-dock lifecycle-dock" aria-label="Indeterminate attempt recovery">
    <div class="dock-label">Halted Run · acknowledgement required</div>
    <h2>Crucible cannot tell whether Commit fix completed</h2>
    <p>The recovery check found no conclusive result. Resuming may repeat the command's effects, so Crucible requires an explicit acknowledgement.</p>
    ${recoveryEvidence([
      ["Last confirmed", "Commit command started"],
      ["Result", "Not observed"],
      ["Recovery check", "Inconclusive"],
    ])}
    <label class="recovery-acknowledgement">
      <input type="checkbox" data-recovery-acknowledgement ${runWorkbench.recoveryAcknowledged ? "checked" : ""} />
      <span>I understand that resuming may repeat this command's effects.</span>
    </label>
    <div class="dock-actions">
      <button type="button" data-run-cancel ${operationPending ? "disabled" : ""}>Cancel Run</button>
      <button type="button" class="primary" data-run-resume ${runWorkbench.recoveryAcknowledged && !operationPending ? "" : "disabled"}>Resume Run</button>
    </div>
  </section>`;
  }

  function runOperationFeedback() {
    if (!runWorkbench.operation) return "";
    const operation = runWorkbench.operation;
    return `<aside class="run-operation-feedback ${operation.state}" role="status" aria-live="polite">
    <div>
      <strong>${status(operation.state === "pending" ? "*" : "+", operation.state === "pending" ? "info" : "ok", operation.title)}</strong>
      <p>${operation.message}</p>
    </div>
    ${operation.state === "pending" ? "" : '<button type="button" class="icon-button" aria-label="Dismiss feedback" title="Dismiss feedback" data-dismiss-run-feedback>&times;</button>'}
  </aside>`;
  }

  function runConfirmationDialog() {
    const confirmation = runWorkbench.confirmation;
    if (!confirmation) return "";
    const deleting = confirmation === "delete";
    const title = deleting ? "Delete this Run?" : "Cancel this Run?";
    const message = deleting
      ? "This permanently removes the Run history, Artifacts, transcripts, and retained diagnostics from Crucible. Workspace files are not removed."
      : "This permanently ends the Run. Its history and published Artifacts remain available until you delete it.";
    const action = deleting ? "Delete Run" : "Cancel Run";

    return `<div class="run-confirmation-backdrop">
    <section class="run-confirmation" role="dialog" aria-modal="true" aria-labelledby="run-confirmation-title">
      <header>
        <h2 id="run-confirmation-title">${title}</h2>
        <button type="button" class="icon-button" aria-label="Close confirmation" title="Close confirmation" data-run-confirmation-dismiss>&times;</button>
      </header>
      <p>${message}</p>
      <div class="dock-actions">
        <button type="button" data-run-confirmation-dismiss>Keep Run</button>
        <button type="button" class="danger-button" data-run-confirm="${confirmation}">${action}</button>
      </div>
    </section>
  </div>`;
  }

  function resumeCurrentRun() {
    const restingMode = runWorkbench.mode;
    const failedAtApproval = runWorkbench.notice.startsWith(
      "Workflow approval rejected",
    );
    runWorkbench.operationAttempt += 1;
    const attempt = runWorkbench.operationAttempt;
    runWorkbench.operation = {
      state: "pending",
      title: "Checking resume",
      message:
        "Crucible is rechecking the Workspace, exact Bundle, trust, Harness, model, and recovery evidence.",
    };
    render();

    setTimeout(() => {
      if (runWorkbench.operationAttempt !== attempt) return;
      const messages = {
        failed: failedAtApproval
          ? "The Workflow approval is available again on this Run."
          : "Fix test is running with fresh attempt and iteration allowances.",
        halted: "Fix test is being attempted again on the existing Run.",
        indeterminate:
          "Commit fix is being attempted again after your acknowledgement.",
        "expired-resource":
          "Fix test is running again. The expired diagnostics remain unavailable.",
      };
      runWorkbench.mode = failedAtApproval ? "gate" : "running";
      runWorkbench.resource = null;
      runWorkbench.recoveryAcknowledged = false;
      runWorkbench.notice = messages[restingMode] || "The Run is continuing.";
      runWorkbench.operation = {
        state: "applied",
        title: "Resume applied",
        message: runWorkbench.notice,
      };
      render();
    }, 550);
  }

  function applyRunConfirmation(action) {
    runWorkbench.confirmation = null;
    if (action === "cancel") {
      runWorkbench.mode = "cancelled";
      runWorkbench.notice = "";
      runWorkbench.operation = {
        state: "applied",
        title: "Run cancelled",
        message:
          "No further work will run. History and published Artifacts remain available.",
      };
      render();
      return;
    }

    const run = activeRunPresentation();
    runHistory.deletedRunIds.add(run.id);
    runHistory.openedRunId = null;
    runHistory.notice = `${run.title} was deleted.`;
    runWorkbench.resource = null;
    runWorkbench.detailsOpen = false;
    runWorkbench.operation = null;
    setVariant("R");
  }

  function runStateSwitcher() {
    const options = Object.entries(runModeDefinitions)
      .map(
        ([mode, label]) =>
          `<option value="${mode}" ${runWorkbench.mode === mode ? "selected" : ""}>${label}</option>`,
      )
      .join("");
    return `<nav class="run-state-switcher" aria-label="Run state prototype switcher">
    <label for="run-state">Prototype Run state</label>
    <select id="run-state" data-run-mode-select>${options}</select>
    <button type="button" data-replay-run-mode>Load state</button>
  </nav>`;
  }

  return {
    applyRunConfirmation,
    resumeCurrentRun,
    runConfirmationDialog,
    runLifecycleDock,
    runLifecycleTimelineEntry,
    runModeDefinitions,
    runOperationFeedback,
    runStateSwitcher,
  };
})();
