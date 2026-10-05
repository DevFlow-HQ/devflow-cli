import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./tempDir.js";

export function freshSessionBundleFolder(): string {
  const folder = makeTempDir("secant-fresh-sessions-");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "io.example.fresh-sessions",
        version: "1.0.0",
        name: "Fresh Sessions",
        description: "Two isolated Agent Steps.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "p.md", kind: "prompt" }],
      routing: [
        {
          id: "first",
          kind: "agent",
          session: "fresh",
          prompt: { asset: "p.md" },
        },
        {
          id: "second",
          kind: "agent",
          session: "fresh",
          prompt: { asset: "p.md" },
        },
      ],
    }),
  );
  writeFileSync(join(folder, "p.md"), "Do the work.");
  return folder;
}

export const freshSessionBuildFindings = [
  '[fresh-session-not-shared] first: Step "first" names the reserved "fresh" Session; each "fresh" Agent Step opens its own isolated Session per Attempt and does not share one with the other "fresh" Steps (first, second). Name a shared Session explicitly to continue one conversation.',
  '[fresh-session-not-shared] second: Step "second" names the reserved "fresh" Session; each "fresh" Agent Step opens its own isolated Session per Attempt and does not share one with the other "fresh" Steps (first, second). Name a shared Session explicitly to continue one conversation.',
  "Derived requires.engine >=0.1.0.",
];
