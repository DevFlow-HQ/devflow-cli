import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./renderer-fixture.js";
import {
  interactiveRunOf,
  MODEL_OFFER,
  mountWorkbench,
  noOverflow,
  press,
  resizeWorkbench,
  SEND_OFFER,
  type,
} from "./run-workbench-fixture.js";

type Workbench = Awaited<ReturnType<typeof mountWorkbench>>;
type WorkspacePathSearch = Awaited<
  ReturnType<Workbench["control"]["view"]["searchWorkspacePaths"]>
>;

async function frameMatching(wb: Workbench, pattern: RegExp) {
  await until(() => {
    void wb.t.renderOnce();
    return pattern.test(wb.t.captureCharFrame());
  });
}

/** Rows that carry the selection cue; colour is never the only signal. */
const selected = (frame: string) =>
  frame.split("\n").filter((line) => line.trimStart().startsWith("› "));

const PATHS: WorkspacePathSearch = {
  status: "available",
  candidates: [
    { path: "src/a.ts", kind: "file" },
    { path: "src/b", kind: "folder" },
  ],
};

test("m10-followup-prompt-completion: a pending path search shows the send hint and Enter sends the text", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER] }),
  );
  let queried = false;
  wb.control.view.searchWorkspacePaths = () => {
    queried = true;
    return new Promise(() => {});
  };

  await type(wb.t, "look @src");
  await until(() => queried);
  await frameMatching(wb, /Searching Workspace paths…/);
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /insert/);
  assert.match(frame, /↵ send · esc/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "look @src");
});

test("m10-followup-prompt-completion: the insert hint appears with the first drawn path and leaves with it", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER] }),
  );
  let reply: ((result: WorkspacePathSearch) => void) | undefined;
  wb.control.view.searchWorkspacePaths = () =>
    new Promise((resolve) => (reply = resolve));

  await type(wb.t, "@src");
  await until(() => reply !== undefined);
  await frameMatching(wb, /Searching Workspace paths…/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /insert/);
  reply?.(PATHS);
  await frameMatching(wb, /› @src\/a.ts/);
  assert.match(wb.t.captureCharFrame(), /↑↓ ↵\/tab insert · esc/);
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /insert|@src\/a.ts/);
  assert.match(wb.t.captureCharFrame(), /> @src/);
});

for (const completion of ["slash", "mention"] as const) {
  test(`m10-followup-prompt-completion: ${completion} keys move one selection cue, keep the native caret and leave focus in the prompt`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER] }),
    );
    wb.control.view.searchWorkspacePaths = async () => PATHS;
    const [text, first, second] =
      completion === "slash"
        ? ["/", /› \/model/, /› \/effort/]
        : ["@src", /› @src\/a.ts/, /› @src\/b\//];

    await type(wb.t, text);
    await frameMatching(wb, first);
    assert.equal(selected(wb.t.captureCharFrame()).length, 1);
    // The Port moves the list; the native field receives the same arrow inertly.
    wb.renderer.key("down");
    wb.t.mockInput.pressArrow("down");
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), second);
    assert.equal(selected(wb.t.captureCharFrame()).length, 1);
    wb.renderer.key("up");
    wb.t.mockInput.pressArrow("up");
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), first);

    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(selected(wb.t.captureCharFrame()), []);
    assert.deepEqual(wb.exits, []);
    // Typing after dismissal extends the draft at its end: focus and caret held.
    await type(wb.t, "x");
    assert.match(wb.t.captureCharFrame(), new RegExp(`> ${text}x`));
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends[0]?.text, `${text}x`);
  });
}

for (const completion of ["slash", "mention"] as const) {
  for (const [width, height] of [
    [48, 14],
    [120, 24],
    [121, 24],
    [160, 40],
  ] as const) {
    test(`m10-followup-prompt-completion: ${completion} rows and hint read without colour at ${width}x${height} through dual resize`, async () => {
      const wb = await mountWorkbench(
        interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER] }),
        width,
        height,
      );
      wb.control.view.searchWorkspacePaths = async () => PATHS;
      const [text, row, cue] =
        completion === "slash"
          ? ["/", /› \/effort · Effort/, /↑\/↓ select · enter\/tab run · esc/]
          : ["@src", /› @src\/b\/ · folder/, /↑↓ ↵\/tab insert · esc/];

      await type(wb.t, text);
      await frameMatching(wb, completion === "slash" ? /› \/model/ : /› @src/);
      await press(wb.t, wb.renderer, "down");
      for (const [w, h] of [
        [width, height],
        [160, 40],
        [48, 14],
      ] as const) {
        resizeWorkbench(wb.t, wb.renderer, w, h);
        await wb.t.renderOnce();
        const frame = wb.t.captureCharFrame();
        noOverflow(frame, w);
        assert.match(frame, row);
        assert.match(frame, cue);
        assert.equal(selected(frame).length, 1);
        assert.match(frame, new RegExp(`> ${text}`));
        assert.equal(wb.t.captureSpans().rows, h);
      }
      await press(wb.t, wb.renderer, "tab");
      if (completion === "slash")
        assert.match(wb.t.captureCharFrame(), /2\. Choose effort/);
      else {
        await press(wb.t, wb.renderer, "return");
        assert.equal(wb.control.sends[0]?.text, "@src/b/");
      }
    });
  }
}
