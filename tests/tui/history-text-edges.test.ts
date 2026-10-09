import assert from "node:assert/strict";
import test from "node:test";
import { historyTextEdges, screenHistoryPortion } from "../../src/tui/tui.js";

const GRID = 4095;

function screen(content: string, start = 0, raw = content) {
  const read = {
    found: true,
    type: "history-text",
    content,
    readId: "read",
    ...(start === 0 && content === raw
      ? {}
      : {
          edges: historyTextEdges(
            // The Application's transient portions: bounded and never joined.
            (function* () {
              for (let at = 0; at < raw.length; at += GRID)
                yield raw.slice(at, at + GRID);
            })(),
            start,
            start + content.length,
          ).edges,
        }),
  } as const;
  const text = screenHistoryPortion(read).text;
  assert.equal(read.content, content);
  return text;
}

/** Whole-body screening: a portion without edges is screenText. */
const whole = (raw: string) => screen(raw);

function portions(raw: string, cuts: readonly number[]): string[] {
  const bounds = [0, ...cuts, raw.length];
  return bounds
    .slice(0, -1)
    .map((from, index) =>
      screen(raw.slice(from, bounds[index + 1]), from, raw),
    );
}

const literals = [
  {
    name: "CSI between CR and LF",
    raw: "\r\x1b[31m\nMARK",
    expected: "\nMARK",
  },
  {
    name: "C1 CSI between CR and LF",
    raw: "\r\x9b31m\nMARK",
    expected: "\nMARK",
  },
  {
    name: "BEL-terminated OSC between CR and LF",
    raw: "\r\x1b]0;title\x07\nMARK",
    expected: "\nMARK",
  },
  {
    name: "ESC-backslash OSC hiding a CR",
    raw: "a\x1b]0;\r\x1b\\\nMARK",
    expected: "a\nMARK",
  },
  {
    name: "C1 ST OSC between CR and LF",
    raw: "\r\x1b]0;t\x9c\nMARK",
    expected: "\nMARK",
  },
  {
    name: "unterminated OSC keeps its CR visible",
    raw: "\x1b]0;\r\nMARK",
    expected: ";\nMARK",
  },
  {
    name: "OSC aborted by ESC keeps its payload",
    raw: "\x1b]0;a\r\x1bX\nMARK",
    expected: ";a\nX\nMARK",
  },
  {
    name: "five-digit CSI falls back to a four-digit match",
    raw: "\r\x1b[12345\nMARK",
    expected: "\nMARK",
  },
  {
    name: "malformed CSI leaves its tail visible",
    raw: "\r\x1b[1;x\nMARK",
    expected: "\n;x\nMARK",
  },
  {
    name: "unmatched ESC separates CR from LF",
    raw: "\r\x1b\nMARK",
    expected: "\n\nMARK",
  },
  {
    name: "a non-ANSI control separates CR from LF",
    raw: "\r\x00\nMARK",
    expected: "\n\nMARK",
  },
  {
    name: "surrogate pairs survive around a CSI",
    raw: "😀\r\x1b[0m\n😀",
    expected: "😀\n😀",
  },
];

test("m10-audit-history-tool-content: CRLF folds through ANSI removal at every portion boundary", () => {
  for (const { name, raw, expected } of literals) {
    assert.equal(whole(raw), expected, name);
    for (let cut = 1; cut < raw.length; cut++) {
      if (/[\uD800-\uDBFF]/.test(raw[cut - 1]!)) continue;
      assert.equal(portions(raw, [cut]).join(""), expected, `${name} @${cut}`);
    }
  }
});

test("m10-audit-history-tool-content: End and Home portions of a long body render CRLF once in either order", () => {
  const cases = [
    {
      raw: "x".repeat(4089) + "\r\x1b[31m\nMARK",
      expected: "x".repeat(4089) + "\nMARK",
    },
    {
      // The CSI crosses the grid line; the LF follows it in the End portion.
      raw: "x".repeat(4092) + "\r\x1b[31m\nMARK",
      expected: "x".repeat(4092) + "\nMARK",
    },
    {
      // An OSC longer than two portions sits between CR and LF.
      raw: "x\r\x1b]8;;" + "u".repeat(9000) + "\x07\nMARK",
      expected: "x\nMARK",
    },
    {
      // An unterminated OSC longer than a portion keeps its payload visible.
      raw: "x\r\x1b]8" + "w".repeat(5000) + "\r\nMARK",
      expected: "x\n" + "w".repeat(5000) + "\nMARK",
    },
  ];
  for (const { raw, expected } of cases) {
    assert.equal(whole(raw), expected);
    const cuts: number[] = [];
    for (let at = GRID; at < raw.length; at += GRID) cuts.push(at);
    const bounds = [0, ...cuts, raw.length];
    // Seeking reads one portion with no state from its neighbours.
    const rendered = bounds
      .slice(0, -1)
      .map((_, index) => index)
      .reverse()
      .map((index) => ({
        index,
        text: screen(
          raw.slice(bounds[index]!, bounds[index + 1]!),
          bounds[index]!,
          raw,
        ),
      }))
      .sort((left, right) => left.index - right.index)
      .map(({ text }) => text);
    assert.equal(rendered.join(""), expected);
  }
});

test("m10-audit-history-tool-content: arbitrary portion cuts reconstruct whole-body screening", () => {
  const alphabet = [
    ..."xm;:?#([]\\0129",
    "\r",
    "\r",
    "\n",
    "\n",
    "\x1b",
    "\x1b",
    "\x1b[",
    "\x1b]",
    "\x9b",
    "\x9c",
    "\x07",
    "\x00",
    "​",
    "é",
    "😀",
  ];
  let seed = 489;
  // mulberry32: deterministic and well spread over small ranges.
  const random = (limit: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
  };
  for (let round = 0; round < 3000; round++) {
    let raw = "";
    for (let length = random(32); length > 0; length--)
      raw += alphabet[random(alphabet.length)];
    const cuts: number[] = [];
    for (let at = 1; at < raw.length; at++)
      if (random(3) === 0 && !/[\uD800-\uDBFF]/.test(raw[at - 1]!))
        cuts.push(at);
    assert.equal(
      portions(raw, cuts).join(""),
      whole(raw),
      JSON.stringify({ raw, cuts }),
    );
  }
});

/** Sequential reads resume the analyser from the state it captured at the previous portion's end. */
function resumedEdges(raw: string, cuts: readonly number[]) {
  const bounds = [0, ...cuts, raw.length];
  const fresh = [],
    resumed = [];
  let state: ReturnType<typeof historyTextEdges>["resume"];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const start = bounds[index]!,
      end = bounds[index + 1]!;
    const source = (from: number) =>
      (function* () {
        for (let at = from; at < raw.length; at += GRID)
          yield raw.slice(at, at + GRID);
      })();
    fresh.push(historyTextEdges(source(0), start, end).edges);
    const read = historyTextEdges(
      source(state === undefined ? 0 : start),
      start,
      end,
      state,
    );
    resumed.push(read.edges);
    state = read.resume;
    if (end < raw.length) assert.ok(state, `state captured at ${end}`);
  }
  return { fresh, resumed };
}

test("m10-followup-bounded-history-cost: resumed sequential edges equal fresh whole-body analysis", () => {
  for (const { raw } of literals)
    for (let cut = 1; cut < raw.length; cut++) {
      if (/[\uD800-\uDBFF]/.test(raw[cut - 1]!)) continue;
      const { fresh, resumed } = resumedEdges(raw, [cut]);
      assert.deepEqual(resumed, fresh, `${JSON.stringify(raw)} @${cut}`);
    }
  for (const raw of [
    "x".repeat(4092) + "\r\x1b[31m\nMARK",
    "x\r\x1b]8;;" + "u".repeat(9000) + "\x07\nMARK",
    "x\r\x1b]8" + "w".repeat(5000) + "\r\nMARK",
  ]) {
    const cuts: number[] = [];
    for (let at = GRID; at < raw.length; at += GRID) cuts.push(at);
    const { fresh, resumed } = resumedEdges(raw, cuts);
    assert.deepEqual(resumed, fresh);
  }
  const alphabet = [..."xm;:?#([]\\0129", "\r", "\n", "\x1b", "\x1b[", "\x1b]"];
  alphabet.push("\x9b", "\x9c", "\x07", "\x00", "😀");
  let seed = 514;
  const random = (limit: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
  };
  for (let round = 0; round < 3000; round++) {
    let raw = "";
    for (let length = random(32); length > 0; length--)
      raw += alphabet[random(alphabet.length)];
    const cuts: number[] = [];
    for (let at = 1; at < raw.length; at++)
      if (random(3) === 0 && !/[\uD800-\uDBFF]/.test(raw[at - 1]!))
        cuts.push(at);
    const { fresh, resumed } = resumedEdges(raw, cuts);
    assert.deepEqual(resumed, fresh, JSON.stringify({ raw, cuts }));
  }
});
