// PROTOTYPE — throwaway (#247). Renders every variant × scene headlessly so a broken frame shows before a human looks.
import { testRender } from "@opentui/solid";
import { test } from "bun:test";
import { App } from "./main.js";
import { SCENES } from "./scenes.js";
import { VARIANTS } from "./variants.js";

for (const v of VARIANTS)
  for (const s of SCENES)
    test(`${v.key} ${s.key}`, async () => {
      process.argv.push(`--variant=${v.key}`, `--scene=${s.key}`);
      const t = await testRender(() => <App />, { width: 140, height: 44 });
      await t.renderOnce();
      await new Promise((r) => setTimeout(r, 1500));
      await t.renderOnce();
      if (process.env.SHOW) console.log(`\n===== ${v.key} ${s.key}\n` + t.captureCharFrame());
      process.argv.splice(-2);
      t.renderer.destroy();
    });

test("prototype keys switch layout, scene, and thoughts", async () => {
  const t = await testRender(() => <App />, { width: 140, height: 44 });
  const settle = async () => { await new Promise((r) => setTimeout(r, 300)); await t.renderOnce(); };
  const bar = () => t.captureCharFrame().split("\n").find((l) => l.includes("PROTOTYPE")) ?? "";
  await settle();
  t.mockInput.pressKey("2", { meta: true }); await settle();
  if (!bar().includes("B Transcript") || !t.captureCharFrame().includes("Matt Front Spec")) throw new Error("alt+2 did not switch to B:\n" + bar());
  t.mockInput.pressKey("n", { meta: true }); await settle();
  if (!bar().includes("scene 2/")) throw new Error("alt+n did not advance scene:\n" + bar());
  t.mockInput.pressKey("p", { meta: true }); await settle();
  await new Promise((r) => setTimeout(r, 2500)); await t.renderOnce();
  if (!t.captureCharFrame().includes("Thought")) throw new Error("no thought row to toggle");
  t.mockInput.pressKey("r", { meta: true }); await settle();
  if (t.captureCharFrame().includes("Thought")) throw new Error("alt+r did not hide thoughts");
  t.mockInput.pressKey("3", { meta: true }); await settle();
  if (!t.captureCharFrame().includes("━━ Implement")) throw new Error("alt+3 did not switch to C");
  t.mockInput.pressKey("x", { meta: true }); await settle();
  if (!bar().includes("scene 1/")) throw new Error("alt+x did not replay scene 1");
  t.renderer.destroy();
});
