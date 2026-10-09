import { DisplayText } from "./display-text.js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type {
  HarnessFocus,
  HarnessFocusResult,
  HarnessFocusSnapshot,
  HarnessSummary,
} from "../application/projection-port.js";
import {
  CatalogEmptyState,
  CatalogRow,
  CatalogSearchAndResults,
  useCatalogNavigation,
} from "./catalog-navigation.js";
import { HarnessCatalogInspector } from "./harness-catalog-inspector.js";
import {
  harnessModelLine,
  harnessRowStatus,
  isQualified,
  qualificationLabel,
} from "./harness-format.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { Panel, PanelGroup } from "./vendor/panels.js";
import { useTheme } from "./vendor/theme-context.js";

const STACK_BREAKPOINT = 70;

type THarnessFilterParams = {
  harnesses: readonly HarnessSummary[];
  query: string;
  heldHarness: (id: HarnessSummary["id"]) => HarnessFocus | undefined;
};

type THeldHarnessFocus = {
  snapshot: Accessor<HarnessFocusSnapshot>;
  dispose: () => void;
};

export function HarnessCatalog(props: { onBack: () => void }) {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const componentOwner = getOwner();
  const view = useHarnessCatalogView();
  const snapshot = view.openList();
  const [openedFocus, setOpenedFocus] = createSignal<
    ReadonlyMap<string, THeldHarnessFocus>
  >(new Map());
  let inspectorScroll: ScrollBoxRenderable | undefined;

  const rows = () => snapshot().harnesses;
  const heldHarness = (id: HarnessSummary["id"]): HarnessFocus | undefined => {
    const result = openedFocus().get(id)?.snapshot().result;
    return result?.found ? result.harness : undefined;
  };
  const ensureFocus = (id: HarnessSummary["id"]): THeldHarnessFocus => {
    const held = openedFocus().get(id);
    if (held !== undefined) return held;
    const opened = createRoot(
      (dispose): THeldHarnessFocus => ({
        snapshot: view.openFocus({ id }),
        dispose,
      }),
      componentOwner,
    );
    const next = new Map(openedFocus());
    next.set(id, opened);
    setOpenedFocus(next);
    return opened;
  };
  onCleanup(() => {
    for (const held of openedFocus().values()) held.dispose();
  });
  const nav = useCatalogNavigation({
    filter: (value) =>
      filterHarnesses({ harnesses: rows(), query: value, heldHarness }),
    onBack: props.onBack,
    group: "Harnesses",
    item: "Harness",
    inspector: () => inspectorScroll,
  });

  const focus = createMemo(() => {
    const entry = nav.activeEntry();
    if (entry === undefined) return undefined;
    return ensureFocus(entry.harness.id).snapshot;
  });
  const focusedResult = (): HarnessFocusResult | undefined =>
    focus()?.().result;

  let scrolledHarness: string | undefined;
  createEffect(() => {
    const id = nav.activeEntry()?.harness.id;
    if (id === scrolledHarness) return;
    scrolledHarness = id;
    inspectorScroll?.scrollTo(0);
  });

  createEffect(() => {
    for (const harness of rows()) {
      if (harness.qualification.state !== "not-checked") {
        ensureFocus(harness.id);
      }
    }
  });

  const qualified = () =>
    rows().filter((harness) => isQualified(harness.qualification)).length;
  const stacked = () => dimensions().width < STACK_BREAKPOINT;

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <box flexDirection="column" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Harnesses
        </text>
        <DisplayText fg={theme.textMuted}>
          {`${rows().length} discovered · ${qualified()} qualified on this system`}
        </DisplayText>
      </box>
      <PanelGroup
        axis={stacked() ? "y" : "x"}
        flexGrow={1}
        overflow="hidden"
        gap={1}
      >
        <CatalogSearchAndResults
          title="Find a Harness"
          placeholder="name, model, or capability"
          pane={nav.pane()}
          query={nav.query()}
          onInput={nav.updateQuery}
          width={34}
          stacked={stacked()}
          hasResults={nav.matching().length > 0}
          empty={
            <CatalogEmptyState
              title="No matching Harnesses"
              hint="Try a different name, capability, model, or qualification state."
            />
          }
        >
          <For each={nav.matching()}>
            {(entry) => (
              <ResultRow
                harness={entry.harness}
                focusedHarness={() => heldHarness(entry.harness.id)}
                selected={entry.index === nav.activeEntry()?.index}
                focused={nav.pane() === "list"}
                onSelect={() => nav.focusRow(entry.index)}
              />
            )}
          </For>
        </CatalogSearchAndResults>
        <Panel
          title="Inspector"
          focused={nav.pane() === "inspector"}
          flexGrow={1}
          overflow="hidden"
        >
          <Show
            when={focusedResult()}
            fallback={
              <DisplayText fg={theme.textMuted} paddingLeft={1}>
                {nav.emptyInspector()}
              </DisplayText>
            }
          >
            {(result) => (
              <Show
                when={foundHarness(result())}
                fallback={
                  <DisplayText fg={theme.textMuted} paddingLeft={1}>
                    {notFoundExplanation(result()) ?? "No Harness selected"}
                  </DisplayText>
                }
              >
                {(harness) => (
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) =>
                      (inspectorScroll = element)
                    }
                    flexGrow={1}
                    minHeight={0}
                    paddingLeft={1}
                    paddingRight={1}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <HarnessCatalogInspector harness={harness} />
                  </scrollbox>
                )}
              </Show>
            )}
          </Show>
        </Panel>
      </PanelGroup>
      <DisplayText fg={theme.textMuted} flexShrink={0}>
        {nav.hint()}
      </DisplayText>
    </box>
  );
}

function filterHarnesses(params: THarnessFilterParams) {
  const needle = params.query.trim().toLocaleLowerCase();
  return params.harnesses
    .map((harness, index) => ({ harness, index }))
    .filter(({ harness }) => {
      if (needle.length === 0) return true;
      const focused = params.heldHarness(harness.id);
      const models = modelSearchText(focused?.modelDeclaration);
      const capabilities =
        focused?.capabilities
          .flatMap((capability) => [
            capability.name,
            capability.description,
            capability.state,
            capability.limits ?? "",
          ])
          .join(" ") ?? "";
      return [
        harness.name,
        harness.id,
        qualificationLabel(harness.qualification.state),
        models,
        capabilities,
        focused?.displayFactLimits.join(" ") ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
}

/** What a model search matches: each model's exact name and label, and for a
 *  non-exhaustive declaration its kind, so "suggested" or "free-text" finds it. */
function modelSearchText(
  declaration: HarnessFocus["modelDeclaration"],
): string {
  if (declaration === undefined) return "";
  const entries =
    declaration.kind === "free-text"
      ? []
      : declaration.models.flatMap((entry) => [entry.model, entry.label]);
  return (
    declaration.kind === "list" ? entries : [...entries, declaration.kind]
  ).join(" ");
}

function ResultRow(props: {
  harness: HarnessSummary;
  focusedHarness: Accessor<HarnessFocus | undefined>;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const details = () => {
    const line = harnessModelLine(
      props.harness.qualification,
      props.focusedHarness()?.modelDeclaration,
    );
    return line === undefined ? [] : [line];
  };
  return (
    <CatalogRow
      title={`${props.harness.name} · ${harnessRowStatus(props.harness)}`}
      details={details()}
      selected={props.selected}
      focused={props.focused}
      onSelect={props.onSelect}
    />
  );
}

function foundHarness(result: HarnessFocusResult): HarnessFocus | undefined {
  return result.found ? result.harness : undefined;
}

function notFoundExplanation(result: HarnessFocusResult): string | undefined {
  return result.found ? undefined : result.problem.explanation;
}
