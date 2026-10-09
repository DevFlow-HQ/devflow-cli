import { DisplayText } from "./display-text.js";
import { createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { AppearancePreferences } from "../application/projection-port.js";
import { CommandSearch, createCommandSearch } from "./command-search.js";
import { useAppCommands } from "./app-commands.js";
import { useBindings } from "./keymap.js";
import type { PreferencesView } from "./preferences-view.js";
import type { SettleOutcome } from "./submit-and-settle.js";
import type { RendererKeyEvent, RendererPort } from "./renderer/renderer.js";
import { useDialog } from "./vendor/dialog.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";
import { clip } from "./clip.js";

// Rebuilt after studying OpenCode's dialog-theme-list and command palette at
// 228e9095ba3988a02664c3816cb51f98584e86c2. Keep preview/entry restoration; Application saves independently.
export function ShellCommands(props: {
  preferences: PreferencesView;
  portDriven: boolean;
  renderer: RendererPort;
}) {
  const appearance = useTheme();
  const catalog = useAppCommands();
  const dialog = useDialog();
  const exit = useExit();
  const terminalDims = useTerminalDimensions();
  const [portDims, setPortDims] = createSignal(props.renderer.size());
  onCleanup(
    props.renderer.onResize((width, height) => setPortDims({ width, height })),
  );
  const dims = () => (props.portDriven ? portDims() : terminalDims());
  const [showing, setShowing] = createSignal(false);
  const [flight, setFlight] = createSignal<{
    pair: AppearancePreferences;
    outcome: Accessor<SettleOutcome>;
  }>();
  const save = (pair: AppearancePreferences) => {
    appearance.apply(pair);
    setFlight({ pair, outcome: props.preferences.save(pair) });
  };
  const retry = () => {
    const sent = flight();
    if (sent?.outcome().kind === "refused") save(sent.pair);
  };
  const open = (kind: "palette" | "themes") => {
    const entry = appearance.active();
    let confirmed = false;
    let key: (event: RendererKeyEvent) => void = () => {};
    dialog.replace(
      () => {
        const toggle = () =>
          appearance.apply({
            ...appearance.active(),
            appearance:
              appearance.active().appearance === "dark" ? "light" : "dark",
          });
        const search = createCommandSearch({
          modal: true,
          entries:
            kind === "palette"
              ? () =>
                  catalog
                    .entries()
                    .map((entry) => ({ ...entry, run: command(entry.run) }))
              : () =>
                  props.preferences.snapshot().supportedThemes.map((name) => ({
                    id: name,
                    name,
                    description: "Preview theme",
                    run() {
                      confirmed = true;
                      const pair = { ...appearance.active(), theme: name };
                      dialog.clear();
                      save(pair);
                    },
                  })),
          ...(kind === "themes"
            ? {
                initial: entry.theme,
                preview: (row) =>
                  appearance.apply({ ...appearance.active(), theme: row.id }),
                tab: toggle,
              }
            : {}),
          escape: () => dialog.clear(),
          quit: () => dialog.clear(),
        });
        key = search.key;
        return (
          <box
            paddingLeft={1}
            paddingRight={1}
            height={Math.max(
              5,
              dims().height - Math.floor(dims().height / 4) - 2,
            )}
            overflow="hidden"
          >
            <DisplayText
              fg={appearance.theme.text}
              flexShrink={0}
              wrapMode="none"
            >
              {kind === "themes"
                ? `Themes · ${appearance.active().appearance === "dark" ? "Dark" : "Light"} · ${appearance.active().theme}`
                : "App commands"}
            </DisplayText>
            <CommandSearch
              search={search}
              enabled={true}
              portDriven={props.portDriven}
              width={Math.max(1, Math.min(60, dims().width - 2) - 2)}
              rows={Math.max(
                1,
                dims().height - Math.floor(dims().height / 4) - 6,
              )}
              hint={
                kind === "themes"
                  ? "tab Dark/Light · ↑/↓ preview · enter confirm · esc restore"
                  : "↑/↓ select · enter run · esc close"
              }
            />
          </box>
        );
      },
      () => {
        setShowing(false);
        if (kind === "themes" && !confirmed) appearance.apply(entry);
      },
      props.portDriven ? (event) => key(event) : undefined,
      props.portDriven ? dims : undefined,
    );
    setShowing(true);
  };
  // Palette actions close discovery first, then use their owner's normal path.
  const command = (run: () => void) => () => {
    dialog.clear();
    run();
  };
  catalog.register(() => [
    {
      id: "themes",
      order: 110,
      name: "Themes",
      description: "Preview and save Dark or Light appearance",
      slash: "themes",
      run: () => open("themes"),
    },
    {
      id: "quit",
      order: 120,
      name: "Quit",
      description: "Leave Secant with guarded live Run shutdown",
      slash: "quit",
      aliases: ["exit"],
      keyHint: "ctrl+c",
      run: () => exit(),
    },
  ]);
  catalog.shell({
    palette: () => open("palette"),
    preempt: () => {
      if (showing()) dialog.clear();
    },
    retry,
  });
  useBindings(() => ({
    enabled: !props.portDriven && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+p",
        desc: "App commands",
        group: "Shell",
        cmd: () => open("palette"),
      },
      {
        key: "ctrl+r",
        desc: "Retry appearance save",
        group: "Shell",
        cmd: retry,
      },
    ],
  }));
  const message = () => {
    const sent = flight();
    const outcome = sent?.outcome();
    if (outcome?.kind === "pending") return "Saving appearance…";
    if (outcome?.kind === "refused") return "Appearance not saved";
    return props.preferences.snapshot().notice?.explanation;
  };
  const refusal = () => {
    const outcome = flight()?.outcome();
    return outcome?.kind === "refused" ? outcome.problem.explanation : "";
  };
  return (
    <Show when={message()}>
      {(notice) => (
        <box
          position="absolute"
          bottom={0}
          left={1}
          backgroundColor={appearance.theme.backgroundPanel}
        >
          <text fg={appearance.theme.warning} wrapMode="none">
            {clip(notice(), Math.max(1, dims().width - 2))}
          </text>
          <Show when={flight()?.outcome().kind === "refused"}>
            <text fg={appearance.theme.text} wrapMode="none" onMouseUp={retry}>
              {clip(
                `ctrl+r retry · ${flight()?.outcome().kind === "refused" ? refusal() : ""}`,
                Math.max(1, dims().width - 2),
              )}
            </text>
          </Show>
        </box>
      )}
    </Show>
  );
}
