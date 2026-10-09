import { DisplayText } from "./display-text.js";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import type { RunSummary } from "../application/projection-port.js";
import { useAppCommands } from "./app-commands.js";
import { CommandSearch, createCommandSearch } from "./command-search.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { isQualified } from "./harness-format.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Rebuilt against OpenCode Home at 228e9095ba3988a02664c3816cb51f98584e86c2. Home owns navigation;
// shell commands share discovery through Secant's catalog (ADR 0040).
export function Home(props: {
  onStartRun: () => void;
  onOpenBundles: () => void;
  onOpenPreviousRuns: () => void;
  onOpenHarnesses: () => void;
}) {
  const { theme } = useTheme();
  const view = useWorkspaceView();
  const harnesses = useHarnessCatalogView().openList();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const catalog = useAppCommands();
  const approved = () => view.snapshot().approval.state === "approved";

  catalog.register(() =>
    approved()
      ? [
          {
            id: "start-run",
            order: 10,
            name: "Start a Run",
            description: "Launch a Workflow Bundle",
            run: props.onStartRun,
          },
          {
            id: "bundles",
            order: 20,
            name: "Workflow Bundles",
            description: "Inspect installed Workflows and versions",
            run: props.onOpenBundles,
          },
          {
            id: "previous-runs",
            order: 30,
            name: "Previous Runs",
            description: "Inspect and reopen Run history",
            run: props.onOpenPreviousRuns,
          },
          {
            id: "harnesses",
            order: 40,
            name: "Harnesses",
            description: "Inspect discovery and model capabilities",
            run: props.onOpenHarnesses,
          },
        ]
      : [],
  );
  const search = createCommandSearch({
    entries: catalog.entries,
    escape() {},
    quit: () => exit(),
  });

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Secant
      </text>
      <Show when={dimensions().height >= 12}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.textMuted}>Workspace</text>
          <DisplayText fg={theme.text}>{view.snapshot().path}</DisplayText>
        </box>
      </Show>
      {/* A failed Shipped Bundle ensure is a notice, never a block (ADR 0029). */}
      <For each={view.snapshot().startupNotices}>
        {(notice) => (
          <box flexDirection="column" flexShrink={0}>
            <DisplayText
              fg={theme.warning}
            >{`Notice: ${notice.explanation}`}</DisplayText>
            <DisplayText fg={theme.textMuted}>{notice.remediation}</DisplayText>
          </box>
        )}
      </For>
      <Show when={approved()}>
        <Show when={dimensions().height >= 12}>
          <DisplayText fg={theme.textMuted} flexShrink={0}>
            {homeSummary({
              bundleCount: view.snapshot().installedBundleCount,
              previousRuns: view.snapshot().runSummary.previousRuns,
              qualifiedHarness: harnesses().harnesses.find((harness) =>
                isQualified(harness.qualification),
              )?.name,
            })}
          </DisplayText>
        </Show>
        <CommandSearch
          search={search}
          enabled={approved() && dialog.stack.length === 0}
          portDriven={false}
          width={Math.max(1, dimensions().width - 2)}
          rows={Math.max(
            1,
            dimensions().height - (dimensions().height >= 12 ? 10 : 6),
          )}
          hint="↑/↓ select · enter run · esc search/clear · ctrl+p commands · ctrl+c quit"
        />
      </Show>
    </box>
  );
}

type THomeSummaryParams = {
  bundleCount: number;
  previousRuns: RunSummary["previousRuns"];
  qualifiedHarness: string | undefined;
};

function homeSummary(params: THomeSummaryParams): string {
  // The Workspace's own Run total (#396); unreadable history says so, never zero.
  const runs =
    params.previousRuns.state === "known"
      ? `${params.previousRuns.count} previous ${params.previousRuns.count === 1 ? "Run" : "Runs"}`
      : "previous Runs unavailable";
  const base = `${params.bundleCount} installed ${params.bundleCount === 1 ? "Bundle" : "Bundles"} · ${runs}`;
  return params.qualifiedHarness === undefined
    ? base
    : `${base} · ${params.qualifiedHarness} qualified`;
}
