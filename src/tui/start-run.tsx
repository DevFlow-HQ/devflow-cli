import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
  FieldViolation,
  HarnessFocus,
  HarnessSummary,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchRunInput,
  Problem,
} from "../application/projection-port.js";
import type { ModelChoiceDraft } from "./model-choice-picker.js";
import { BundleCatalog } from "./bundle-catalog.js";
import { useBundleCatalogView } from "./bundle-view.js";
import { isCheckingModels } from "./harness-format.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { useRunLaunchView, type LaunchOutcome } from "./run-launch-view.js";
import {
  ChooseStep,
  HarnessStep,
  ModelChoiceStep,
  InputsStep,
  PendingStep,
  ReviewStep,
  routingNeedsHarness,
  type ReviewField,
} from "./start-run-views.js";

// Drafts survive back-navigation; only leaving the flow discards them. Agent
// Bundles choose a Harness, enter Launch inputs, then choose model and effort.
// Review assesses the complete draft and submits the ready Offer unchanged.
// Editing a field from Review visits only that field's step and returns to
// Review on it; Tab from the guided model stage visits the Harness the same
// way and returns to that stage. Refusals return to their correction stage without clearing
// unrelated choices.

type Step = "choose" | "harness" | "inputs" | "model" | "review" | "pending";

export function StartRun(props: {
  onLeave: () => void;
  onStarted: (runId: string, bundleName: string) => void;
}) {
  const bundles = useBundleCatalogView();
  const harnessCatalog = useHarnessCatalogView();
  const launch = useRunLaunchView();
  const list = bundles.openList();
  // The Harness list is opened once for the whole flow: a list open is discovery
  // only and spawns nothing (#191). Only choosing a Harness opens its focus.
  const harnessList = harnessCatalog.openList();

  const rows = (): readonly InstalledBundleSummary[] => {
    const result = list().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = list().result;
    return result.found ? undefined : result.problem;
  };

  const [step, setStep] = createSignal<Step>("choose");
  const [catalogOpen, setCatalogOpen] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  // The chosen Harness id (undefined until the user chooses one) and the requested
  // model draft (undefined starts from the preselection the launch assessment
  // resolves). Both survive back-navigation.
  const [chosenHarnessId, setChosenHarnessId] = createSignal<
    string | undefined
  >();
  const [harnessFindingId, setHarnessFindingId] = createSignal<
    string | undefined
  >();
  const [selectedChoice, setSelectedChoice] = createSignal<ModelChoiceDraft>();
  const [effortReset, setEffortReset] = createSignal<string>();
  const [modelStage, setModelStage] = createSignal<"model" | "effort">("model");
  // Where a visited step returns: Review, after editing one of its fields, or
  // the guided model stage, after Tab reached the Harness from it. Review
  // reopens focused on `reviewFocus`.
  const [returnTo, setReturnTo] = createSignal<"review" | "model">();
  const [reviewFocus, setReviewFocus] = createSignal<ReviewField>("start");
  const modelDraft = (): ModelChoiceDraft => {
    const selected = selectedChoice();
    if (selected !== undefined) return selected;
    const choice = chosenHarnessFocus()?.preselection?.choice;
    return choice === undefined
      ? { kind: "model-needed" }
      : { kind: "chosen", choice };
  };
  const chooseModelChoice = (
    choice: NonNullable<HarnessFocus["preselection"]>["choice"],
    reset?: string,
  ) => {
    setSelectedChoice({ kind: "chosen", choice });
    setEffortReset(reset);
  };
  const requestedChoice = () => {
    const selected = selectedChoice();
    const choice = selected?.kind === "chosen" ? selected.choice : undefined;
    const preselection = chosenHarnessFocus()?.preselection?.choice;
    return choice?.model === preselection?.model &&
      choice?.effort === preselection?.effort
      ? undefined
      : choice;
  };
  // Every digest the user has acknowledged trust for. A set (not one slot) so an
  // acknowledgement survives moving to another Bundle and back (trust is
  // digest-scoped, ADR 0021).
  const [ackedDigests, setAckedDigests] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [values, setValues] = createStore<Record<string, string>>({});
  let submittedBundleName: string | undefined;
  const [chooserProblem, setChooserProblem] = createSignal<
    Problem | undefined
  >();
  const [fieldFindings, setFieldFindings] = createSignal<
    readonly FieldViolation[] | undefined
  >();
  const [notice, setNotice] = createSignal<string>();
  const [outcome, setOutcome] = createSignal<
    Accessor<LaunchOutcome> | undefined
  >();

  const active = () => Math.min(selected(), Math.max(0, rows().length - 1));
  const selectedSummary = () => rows()[active()];

  const harnessRows = (): readonly HarnessSummary[] => harnessList().harnesses;
  const chosenHarnessSummary = (): HarnessSummary | undefined =>
    harnessRows().find((harness) => harness.id === chosenHarnessId());
  // The focus for the chosen Harness, re-opened when the choice changes: the memo
  // owns each openFocus subscription and disposes the previous on re-run. Opening a
  // focus qualifies exactly that Harness; nothing is opened until one is chosen.
  const harnessFocusAccessor = createMemo(() => {
    const id = chosenHarnessId();
    if (id === undefined) return undefined;
    return harnessCatalog.openFocus({ id });
  });
  const chosenHarnessFocus = (): HarnessFocus | undefined => {
    const accessor = harnessFocusAccessor();
    if (accessor === undefined) return undefined;
    const result = accessor().result;
    return result.found ? result.harness : undefined;
  };

  // The focus for the selected Bundle, re-opened when the selection changes: the
  // memo owns each openFocus subscription and disposes the previous one on
  // re-run. The side panel's Workflow line and every Launch input come from here.
  const focusAccessor = createMemo(() => {
    const summary = selectedSummary();
    if (summary === undefined) return undefined;
    return bundles.openFocus({ id: summary.id, version: summary.version });
  });
  const focusBundle = (): InstalledBundleFocus | undefined => {
    const accessor = focusAccessor();
    if (accessor === undefined) return undefined;
    const result = accessor().result;
    return result.found ? result.bundle : undefined;
  };

  // Launch input drafts belong to the chosen Bundle: clear them when the selection
  // moves to a different digest, so a value typed for one Bundle never leaks into
  // another Bundle's same-named input. Drafts still survive back-navigation within
  // one Bundle (its digest does not change), including the refusal round-trip.
  let draftsFor: string | undefined;
  createEffect(() => {
    const digest = focusBundle()?.digest;
    if (digest !== draftsFor) {
      draftsFor = digest;
      setValues(reconcile({}));
    }
  });

  const untrusted = () => focusBundle()?.trust.state === "not-yet-trusted";
  const acknowledged = () => {
    const bundle = focusBundle();
    return bundle !== undefined && ackedDigests().has(bundle.digest);
  };
  // Continue is unavailable until an untrusted digest is acknowledged; a trusted
  // or app-release Bundle needs no acknowledgement (AC1).
  const canContinue = () =>
    focusBundle() !== undefined && (!untrusted() || acknowledged());

  const acknowledge = () => {
    const bundle = focusBundle();
    if (bundle !== undefined && bundle.trust.state === "not-yet-trusted") {
      setAckedDigests((prev) => new Set(prev).add(bundle.digest));
    }
  };

  const continueFromChoose = () => {
    const bundle = focusBundle();
    if (bundle === undefined || !canContinue()) return;
    setChooserProblem(undefined);
    setStep(
      routingNeedsHarness(bundle.routing) ? "harness" : nextDraftStep(bundle),
    );
  };

  // The user has chosen a Harness (opening its focus qualifies only that one). A
  // different choice resets the model draft, since the previous model may not be
  // one the new Harness supports; the launch revalidates regardless.
  const chooseHarness = (id: string) => {
    if (chosenHarnessId() !== id && harnessFindingId() !== id) {
      setSelectedChoice(undefined);
      setEffortReset(undefined);
    }
    setHarnessFindingId(undefined);
    setChosenHarnessId(id);
    continueFromHarness();
  };

  // Continue past the Harness step only once the chosen Harness's check has
  // settled available: never while its models are still being checked.
  const canContinueHarness = () => {
    const focus = chosenHarnessFocus();
    return !isCheckingModels(focus) && focus.unavailable === undefined;
  };

  const continueFromHarness = () => {
    const bundle = focusBundle();
    if (bundle === undefined || !canContinueHarness()) return;
    setChooserProblem(undefined);
    setModelStage("model");
    if (returnTo() === undefined) setStep(nextDraftStep(bundle));
    // A Harness with nothing to start from needs a model before Review.
    else if (returnTo() === "review" && modelDraft().kind === "model-needed")
      setStep("model");
    else finishVisit();
  };

  const editFromReview = (field: Exclude<ReviewField, "start">) => {
    setReviewFocus(field);
    setReturnTo("review");
    if (field === "harness") {
      setStep("harness");
      return;
    }
    setModelStage(field);
    setStep("model");
  };
  const visitHarnessFromModel = () => {
    if (returnTo() === undefined) setReturnTo("model");
    setStep("harness");
  };
  const finishVisit = () => {
    const origin = returnTo();
    setReturnTo(undefined);
    if (origin === "model") {
      setModelStage("model");
      setStep("model");
    } else setStep("review");
  };

  const declaredValues = (): Record<string, string> => {
    const bundle = focusBundle();
    const collected: Record<string, string> = {};
    if (bundle === undefined) return collected;
    // Only names the user actually entered are sent; an omitted required input
    // surfaces as its own field violation from Preflight (AC4).
    for (const input of bundle.launchInputs) {
      const value = values[input.name];
      if (value !== undefined) collected[input.name] = value;
    }
    return collected;
  };

  const launchDraft = (): LaunchRunInput => {
    const bundle = focusBundle();
    if (bundle === undefined) {
      throw new Error("Review requires a selected Bundle");
    }
    const needsHarness = routingNeedsHarness(bundle.routing);
    return {
      bundle: { id: bundle.id, version: bundle.version },
      launchInputs: declaredValues(),
      harness: needsHarness ? chosenHarnessId() : undefined,
      // The draft carries the requested model into the launch; a Command-only
      // Bundle asks for neither Harness nor model (#191). An undefined model takes
      // the preselection, which the assessment resolves into the Offer's draft.
      requestedModel: needsHarness ? requestedChoice()?.model : undefined,
      requestedEffort: needsHarness ? requestedChoice()?.effort : undefined,
      trustDigest:
        bundle.trust.state === "not-yet-trusted" && acknowledged()
          ? bundle.digest
          : undefined,
    };
  };

  const startLaunch = (input: LaunchRunInput) => {
    const bundle = focusBundle();
    if (bundle === undefined) return;
    setFieldFindings(undefined);
    setChooserProblem(undefined);
    submittedBundleName = bundle.name;
    // Show pending BEFORE submitting: the live seam settles synchronously, so
    // storing the outcome fires the settlement effect at once — a later
    // `setStep("pending")` would clobber the receipt it just set and wedge the
    // screen on "Checking launch". Pending first lets the effect advance from it.
    setStep("pending");
    setOutcome(() => launch.launch(input));
  };

  // Follow the launch to its settlement: a successful launch transitions
  // straight into that Run's Workbench (#91), replacing #90's receipt; a refusal
  // returns to the step that owns the correction with the finding, leaving every
  // other draft choice intact (AC4). The Port itself says which surface owns the
  // correction (#98 A15): a Problem carrying field violations is an inputs-screen
  // fault, so the screen reads that presence rather than re-matching a Problem code
  // string; every other refusal (Workspace prerequisite, corrupted Bundle, trust,
  // Workspace state) belongs to Bundle selection.
  createEffect(() => {
    const accessor = outcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "launched") {
      if (submittedBundleName === undefined) {
        throw new Error("a launched Run must retain its submitted Bundle name");
      }
      props.onStarted(settled.runId, submittedBundleName);
      return;
    }
    const problem = settled.problem;
    setOutcome(undefined);
    setNotice("Run not started");
    setChooserProblem(problem);
    if (problem.correction === "inputs") {
      setFieldFindings(problem.fieldViolations);
      const invalidated = new Set(
        problem.fieldViolations?.map((violation) => violation.field) ?? [],
      );
      const preserved: Record<string, string> = {};
      for (const [name, value] of Object.entries(values)) {
        if (!invalidated.has(name)) preserved[name] = value;
      }
      setValues(reconcile(preserved));
      setStep("inputs");
    } else if (problem.correction === "harness") {
      setHarnessFindingId(chosenHarnessId());
      setChosenHarnessId(undefined);
      setStep("harness");
    } else if (problem.correction === "model") {
      const draft = modelDraft();
      setSelectedChoice({
        kind: "model-needed",
        effort: draft.kind === "chosen" ? draft.choice.effort : draft.effort,
      });
      setModelStage("model");
      setStep("model");
    } else if (problem.correction === "effort") {
      const draft = modelDraft();
      if (draft.kind === "chosen")
        setSelectedChoice({
          kind: "chosen",
          choice: { model: draft.choice.model },
        });
      setModelStage("effort");
      setStep("model");
    } else if (problem.correction === "trust") {
      const bundle = focusBundle();
      if (bundle !== undefined) {
        setAckedDigests((current) => {
          const next = new Set(current);
          next.delete(bundle.digest);
          return next;
        });
      }
      setStep("review");
    } else {
      setStep("choose");
    }
  });

  const backFromReview = () => {
    const bundle = focusBundle();
    if (focusNeedsHarness(bundle)) {
      setModelStage("effort");
      setStep("model");
    } else
      setStep(
        bundle !== undefined && bundle.launchInputs.length > 0
          ? "inputs"
          : "choose",
      );
  };

  // The ordered steps present for a Bundle, so each step can render its `N of M`
  // position: Harness only when the routing needs one, Inputs only when the Bundle
  // declares launch inputs (#191). `pending` is not a numbered step.
  const stepSequence = (bundle: InstalledBundleFocus): Step[] => {
    const sequence: Step[] = ["choose"];
    if (routingNeedsHarness(bundle.routing)) sequence.push("harness");
    if (bundle.launchInputs.length > 0) sequence.push("inputs");
    if (routingNeedsHarness(bundle.routing)) sequence.push("model");
    sequence.push("review");
    return sequence;
  };
  const stepLabel = (which: Step): string => {
    const bundle = focusBundle();
    if (bundle === undefined) return "";
    const sequence = stepSequence(bundle);
    const position = sequence.indexOf(which);
    if (position === -1) return "";
    return `Step ${position + 1} of ${sequence.length}`;
  };

  return (
    <Show
      when={catalogOpen()}
      fallback={
        <Switch>
          <Match when={step() === "choose"}>
            <ChooseStep
              rows={rows}
              listProblem={listProblem}
              selected={active}
              setSelected={setSelected}
              focus={focusBundle}
              untrusted={untrusted}
              acknowledged={acknowledged}
              acknowledge={acknowledge}
              canContinue={canContinue}
              stepLabel={() => stepLabel("choose")}
              onContinue={continueFromChoose}
              onViewDetails={() => setCatalogOpen(true)}
              onBack={props.onLeave}
              problem={chooserProblem}
              notice={notice}
              onDismissNotice={() => setNotice(undefined)}
            />
          </Match>
          <Match when={step() === "harness"}>
            <HarnessStep
              rows={harnessRows}
              chosenId={chosenHarnessId}
              findingHarnessId={harnessFindingId}
              choose={chooseHarness}
              focus={chosenHarnessFocus}
              stepLabel={() => stepLabel("harness")}
              problem={chooserProblem}
              notice={notice}
              onDismissNotice={() => setNotice(undefined)}
              canContinue={canContinueHarness}
              onContinue={continueFromHarness}
              canReturn={() => returnTo() !== undefined}
              onBack={() =>
                returnTo() === undefined ? setStep("choose") : finishVisit()
              }
            />
          </Match>
          <Match when={step() === "inputs"}>
            <InputsStep
              bundle={focusBundle}
              values={values}
              setValue={(name, value) => setValues(name, value)}
              findings={fieldFindings}
              problem={chooserProblem}
              notice={notice}
              onDismissNotice={() => setNotice(undefined)}
              stepLabel={() => stepLabel("inputs")}
              onContinue={() => {
                setModelStage("model");
                setStep(focusNeedsHarness(focusBundle()) ? "model" : "review");
              }}
              onBack={() =>
                setStep(focusNeedsHarness(focusBundle()) ? "harness" : "choose")
              }
            />
          </Match>
          <Match when={step() === "model"}>
            <ModelChoiceStep
              focus={chosenHarnessFocus}
              draft={modelDraft}
              reset={effortReset}
              enabled={canContinueHarness}
              initialStage={modelStage()}
              onChoice={chooseModelChoice}
              onDone={() => {
                if (returnTo() === undefined) setReviewFocus("start");
                setReturnTo(undefined);
                setStep("review");
              }}
              onHarness={visitHarnessFromModel}
              onBack={() => {
                setModelStage("model");
                if (returnTo() === "review") finishVisit();
                else
                  setStep(
                    focusBundle()?.launchInputs.length === 0
                      ? "harness"
                      : "inputs",
                  );
              }}
              stepLabel={() => stepLabel("model")}
              problem={chooserProblem}
              notice={notice}
              onDismissNotice={() => setNotice(undefined)}
            />
          </Match>
          <Match when={step() === "review"}>
            <ReviewStep
              bundle={focusBundle}
              harness={chosenHarnessSummary}
              harnessFocus={chosenHarnessFocus}
              modelDraft={modelDraft}
              draft={launchDraft}
              canAcknowledgeTrust={() => untrusted() && !acknowledged()}
              onAcknowledgeTrust={acknowledge}
              stepLabel={() => stepLabel("review")}
              notice={notice}
              onDismissNotice={() => setNotice(undefined)}
              reset={effortReset}
              initialFocus={reviewFocus()}
              onEdit={editFromReview}
              onStart={startLaunch}
              onBack={backFromReview}
            />
          </Match>
          <Match when={step() === "pending"}>
            <PendingStep />
          </Match>
        </Switch>
      }
    >
      <BundleCatalog
        selected={selectedSummary() === undefined ? undefined : active()}
        onSelect={setSelected}
        onBack={() => setCatalogOpen(false)}
      />
    </Show>
  );
}

// --- step sequencing -------------------------------------------------------

function nextDraftStep(bundle: InstalledBundleFocus): Step {
  return bundle.launchInputs.length > 0
    ? "inputs"
    : routingNeedsHarness(bundle.routing)
      ? "model"
      : "review";
}

function focusNeedsHarness(bundle: InstalledBundleFocus | undefined): boolean {
  return bundle !== undefined && routingNeedsHarness(bundle.routing);
}
