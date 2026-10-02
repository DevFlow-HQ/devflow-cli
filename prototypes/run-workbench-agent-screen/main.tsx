// PROTOTYPE — throwaway (#247). Three variants of the Run Workbench as an agent screen, switchable
// from the bottom prototype bar, over a scripted fake Run. Run: `bun run prototype:workbench`.
// Nothing here is imported by src/; it reads only the vendored theme module.
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import {
  batch,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Switch,
} from "solid-js";
import {
  Line,
  THEME_NAMES,
  expanded,
  interruptArmed,
  setExpanded,
  setInterruptArmed,
  setShowThoughts,
  setThemeName,
  showThoughts,
  theme,
  themeName,
} from "./parts.js";
import { SCENES, type Item } from "./scenes.js";
import { VARIANTS } from "./variants.js";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

export function App() {
  const [variant, setVariant] = createSignal(
    Math.max(
      0,
      VARIANTS.findIndex((v) => v.key === arg("variant")),
    ),
  );
  const [sceneIx, setSceneIx] = createSignal(
    Math.max(
      0,
      SCENES.findIndex((s) => s.key === arg("scene")),
    ),
  );
  const [items, setItems] = createSignal<Item[]>([]);
  const [replay, setReplay] = createSignal(0);
  let scroll: { scrollBy(d: number): void } | undefined;
  const scene = () => SCENES[sceneIx()]!;

  // Play the live Turn: append script items one at a time; stream assistant markdown in chunks.
  createEffect(
    on([sceneIx, replay], () => {
      const s = scene();
      setItems(s.items);
      const script = s.script ?? [];
      let step = 0;
      let chars = 0;
      const id = setInterval(() => {
        const next = script[step];
        if (!next) return clearInterval(id);
        if (next.kind === "assistant" && next.streaming) {
          chars = Math.min(next.md.length, chars + 14);
          const partial: Item = {
            ...next,
            md: next.md.slice(0, chars),
            streaming: chars < next.md.length,
          };
          setItems((cur) =>
            chars <= 14 ? [...cur, partial] : [...cur.slice(0, -1), partial],
          );
          if (chars >= next.md.length) {
            step++;
            chars = 0;
          }
          return;
        }
        // A thought shows "Thinking…" live before it settles.
        if (next.kind === "thought") {
          const live: Item = { ...next, live: true };
          setItems((cur) => [...cur, live]);
          setTimeout(
            () =>
              setItems((cur) => cur.map((c) => (c === live ? { ...next } : c))),
            600,
          );
        } else setItems((cur) => [...cur, next]);
        step++;
      }, 650);
      onCleanup(() => clearInterval(id));
    }),
  );

  // Submit: the draft is already cleared; the message appears at once. Mid-Turn it is a Steer that
  // waits for the agent's next step, then reads as delivered.
  const onSubmit = (text: string) => {
    const working =
      scene().bottom.kind === "prompt" &&
      (scene().bottom as { working: boolean }).working;
    const msg: Item = {
      kind: "user",
      text,
      steer: working ? "waiting" : undefined,
    };
    setItems((cur) => [...cur, msg]);
    if (working)
      setTimeout(
        () =>
          setItems((cur) =>
            cur.map((c) => (c === msg ? { ...msg, steer: "delivered" } : c)),
          ),
        1600,
      );
  };

  let armTimer: ReturnType<typeof setTimeout> | undefined;
  useKeyboard((key) => {
    const cycle = (n: number, len: number, d: number) => (n + d + len) % len;
    // Prototype-only keys ride Alt so they never collide with typing or the design's own ctrl keys.
    const alt = key.meta || key.option;
    const proto = (fn: () => void) => {
      key.preventDefault();
      fn();
    };
    if (alt && ["1", "2", "3"].includes(key.name))
      proto(() => setVariant(Number(key.name) - 1));
    else if (alt && key.name === "l")
      proto(() => setVariant((v) => cycle(v, VARIANTS.length, 1)));
    else if (alt && (key.name === "n" || key.name === "p"))
      proto(() =>
        batch(() => {
          setSceneIx((s) => cycle(s, SCENES.length, key.name === "n" ? 1 : -1));
          setInterruptArmed(false);
        }),
      );
    else if (alt && key.name === "t")
      proto(() =>
        setThemeName(
          (n) =>
            THEME_NAMES[cycle(THEME_NAMES.indexOf(n), THEME_NAMES.length, 1)]!,
        ),
      );
    else if (alt && key.name === "r") proto(() => setShowThoughts((v) => !v));
    else if (alt && key.name === "x")
      proto(() =>
        batch(() => {
          setSceneIx(0);
          setReplay((n) => n + 1);
        }),
      );
    else if (key.name === "o" && key.ctrl) setExpanded((v) => !v);
    else if (key.name === "pageup") scroll?.scrollBy(-10);
    else if (key.name === "pagedown") scroll?.scrollBy(10);
    else if (key.name === "escape") {
      if (interruptArmed()) {
        setInterruptArmed(false);
        setSceneIx(SCENES.findIndex((s) => s.key === "interrupt"));
      } else {
        setInterruptArmed(true);
        clearTimeout(armTimer);
        armTimer = setTimeout(() => setInterruptArmed(false), 5000);
      }
    } else if (key.name === "c" && key.ctrl) process.exit(0);
  });

  const v = () => VARIANTS[variant()]!;
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme().background}
    >
      <Switch>
        <For each={VARIANTS}>
          {(vv, i) => (
            <Match when={variant() === i()}>
              <vv.View
                scene={scene()}
                items={items()}
                onSubmit={onSubmit}
                scrollRef={(r: unknown) => {
                  scroll = r as typeof scroll;
                }}
              />
            </Match>
          )}
        </For>
      </Switch>
      <box
        height={1}
        flexShrink={0}
        backgroundColor={theme().text}
        paddingLeft={1}
        flexDirection="row"
      >
        <Line
          parts={[
            ["PROTOTYPE  ", theme().background, { bold: true }],
            [
              "alt+1/2/3 " + v().key + " " + v().name + "  ",
              theme().background,
            ],
            [
              "alt+n/p scene " +
                (sceneIx() + 1) +
                "/" +
                SCENES.length +
                " " +
                scene().title +
                "  ",
              theme().background,
            ],
            ["alt+t " + themeName() + "  ", theme().background],
            [
              "alt+r thoughts " + (showThoughts() ? "on" : "off") + "  ",
              theme().background,
            ],
            [
              "alt+x replay  ctrl+o " +
                (expanded() ? "collapse" : "expand") +
                "  ctrl+c quit",
              theme().background,
            ],
          ]}
        />
      </box>
    </box>
  );
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    targetFps: 30,
  });
  render(() => <App />, renderer);
}
