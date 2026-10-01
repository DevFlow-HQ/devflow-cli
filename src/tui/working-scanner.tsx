import { RGBA } from "@opentui/core";
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js";
import stringWidth from "string-width";
import { clip } from "./clip.js";

// The working indicator (#292): OpenCode's block scanner, rebuilt against
// `packages/tui/src/ui/spinner.ts` (`createFrames`, `createColors`,
// `deriveTrailColors`) and the busy status row of
// `packages/tui/src/component/prompt/index.tsx`. No OpenCode source or
// `opentui-spinner` crosses (see UPSTREAM): the frames are a pure table built from
// `createFrames`' default constants, and each cell is its own OpenTUI `<text>` so
// its trail colour needs no custom Renderable (one string child per `<text>`).

const CELLS = 8;
/** Trail steps behind (and including) the lead: `deriveTrailColors`' default. */
const TRAIL = 6;
const HOLD_END = 9;
const HOLD_START = 30;
const FRAME_MS = 40;
/** The trail's alpha falloff (`deriveTrailColors`): the bloom step just behind the
 *  lead is brightened and slightly translucent, then each step decays. */
const BLOOM_BRIGHTNESS = 1.15;
const BLOOM_ALPHA = 0.9;
const TRAIL_DECAY = 0.65;
/** The inactive cells' alpha and their fading floor, as OpenCode's prompt sets them. */
const INACTIVE_ALPHA = 0.6;
const MIN_FADE = 0.3;
const ACTIVE = "■";
const INACTIVE = "⬝";
/** Shown instead of the scanner with reduced motion: OpenCode's animations-off mark. */
const STATIC_MARK = "[⋯]";
const INDENT = "  ";

interface ScannerCell {
  /** Steps behind the lead (0 is the lead), or undefined for an inactive cell. */
  readonly trail: number | undefined;
  /** The inactive cells' fade in this frame, from MIN_FADE up to 1. */
  readonly fade: number;
}

/** Where the lead is in frame `index` of the bidirectional cycle: forward across
 *  every cell, held at the far end, back from the second-last cell, held at the
 *  start. `step` counts frames into the current phase of `length` frames. */
function leadAt(index: number) {
  const backSteps = CELLS - 1;
  if (index < CELLS)
    return {
      at: index,
      forward: true,
      holding: false,
      step: index,
      length: CELLS,
    };
  if (index < CELLS + HOLD_END)
    return {
      at: CELLS - 1,
      forward: true,
      holding: true,
      step: index - CELLS,
      length: HOLD_END,
    };
  if (index < CELLS + HOLD_END + backSteps) {
    const step = index - CELLS - HOLD_END;
    return {
      at: CELLS - 2 - step,
      forward: false,
      holding: false,
      step,
      length: backSteps,
    };
  }
  return {
    at: 0,
    forward: false,
    holding: true,
    step: index - CELLS - HOLD_END - backSteps,
    length: HOLD_START,
  };
}

function frameAt(index: number): readonly ScannerCell[] {
  const lead = leadAt(index);
  // Inactive cells fade out toward the floor while held, and back in while moving.
  const progress = lead.holding
    ? Math.min(lead.step / lead.length, 1)
    : Math.min(lead.step / Math.max(1, lead.length - 1), 1);
  const fade = lead.holding
    ? Math.max(MIN_FADE, 1 - progress * (1 - MIN_FADE))
    : MIN_FADE + progress * (1 - MIN_FADE);
  return Array.from({ length: CELLS }, (_, cell) => {
    const behind = lead.forward ? lead.at - cell : cell - lead.at;
    // A hold keeps the lead's place and shifts the whole trail dimmer each frame,
    // so it drains out of the far end; moving, only cells behind the lead light.
    const step = lead.holding ? behind + lead.step : behind;
    return { trail: step >= 0 && step < TRAIL ? step : undefined, fade };
  });
}

/** One full scanner cycle (54 frames, 2.16 s at 40 ms), built once. */
export const SCANNER_FRAMES: readonly (readonly ScannerCell[])[] = Array.from(
  { length: CELLS + HOLD_END + (CELLS - 1) + HOLD_START },
  (_, index) => frameAt(index),
);

/** A frame as its glyphs: `■` for a lit cell, `⬝` for an inactive one, so the
 *  scanner's shape never depends on colour. */
export function scannerGlyphs(frame: readonly ScannerCell[]): string {
  return frame
    .map((cell) => (cell.trail === undefined ? INACTIVE : ACTIVE))
    .join("");
}

/** The trail's colours from the accent, by alpha falloff (`deriveTrailColors`): the
 *  lead solid, a slightly brightened bloom behind it, then exponential decay. */
function trailColors(accent: RGBA): readonly RGBA[] {
  return Array.from({ length: TRAIL }, (_, step) => {
    const bright = step === 1 ? BLOOM_BRIGHTNESS : 1;
    const alpha =
      step === 0 ? 1 : step === 1 ? BLOOM_ALPHA : TRAIL_DECAY ** (step - 1);
    return RGBA.fromValues(
      Math.min(1, accent.r * bright),
      Math.min(1, accent.g * bright),
      Math.min(1, accent.b * bright),
      alpha,
    );
  });
}

/** A working line: the scanner (or, with reduced motion, the static `[⋯]`) leading
 *  `label — detail`, clipped to `width` display columns. The caller mounts it only
 *  while a Turn is live, and `label` carries the meaning in words, so the mark yields
 *  first: it draws only while the whole label still fits beside it, and neither
 *  motion nor colour is ever the only signal. The one frame timer starts when the
 *  cells mount and is cleared when they unmount, so it stops when the Turn ends. */
export function WorkingScanner(props: {
  /** The words that must survive a narrow row, e.g. the interrupt key. */
  label: string;
  /** The rest of the line, clipped first. */
  detail: string;
  labelColor: RGBA;
  /** The trail's colour (the theme accent). */
  accent: RGBA;
  /** The static mark's colour (the theme's muted text). */
  muted: RGBA;
  reducedMotion: boolean;
  width: number;
}) {
  const mark = () => (props.reducedMotion ? STATIC_MARK : ACTIVE.repeat(CELLS));
  // The label must survive whole, past the clip's own `…` after it.
  const markShown = () =>
    stringWidth(`${INDENT}${mark()} ${props.label}…`) <= props.width;
  const words = () => {
    const line = `${props.label} — ${props.detail}`;
    return markShown()
      ? clip(` ${line}`, props.width - stringWidth(INDENT + mark()))
      : clip(`${INDENT}${line}`, props.width);
  };
  return (
    <box flexDirection="row" flexShrink={0}>
      <Show when={markShown()}>
        <text flexShrink={0}>{INDENT}</text>
        <Show
          when={!props.reducedMotion}
          fallback={
            <text fg={props.muted} flexShrink={0}>
              {STATIC_MARK}
            </text>
          }
        >
          <ScannerCells accent={props.accent} />
        </Show>
      </Show>
      <text fg={props.labelColor} flexShrink={0}>
        {words()}
      </text>
    </box>
  );
}

function ScannerCells(props: { accent: RGBA }) {
  const [index, setIndex] = createSignal(0);
  const timer = setInterval(
    () => setIndex((current) => (current + 1) % SCANNER_FRAMES.length),
    FRAME_MS,
  );
  // Unref'd, as OpenCode's spinner element does, so a frame tick never holds the
  // process open; unmount clears it.
  timer.unref();
  onCleanup(() => clearInterval(timer));
  const trail = createMemo(() => trailColors(props.accent));
  const cellColor = (cell: ScannerCell) => {
    if (cell.trail !== undefined) return trail()[cell.trail];
    const { r, g, b } = props.accent;
    return RGBA.fromValues(r, g, b, INACTIVE_ALPHA * cell.fade);
  };
  return (
    <Index each={SCANNER_FRAMES[index()]}>
      {(cell) => (
        <text fg={cellColor(cell())} flexShrink={0}>
          {cell().trail === undefined ? INACTIVE : ACTIVE}
        </text>
      )}
    </Index>
  );
}
