import { writeAgentBundle as authorAgentBundle } from "./agentBundle.js";

export function freshSessionBundleFolder(): string {
  const { folder } = authorAgentBundle({
    id: "io.example.fresh-sessions",
    name: "Fresh Sessions",
    description: "Two isolated Agent Steps.",
    prompt: { path: "p.md", text: "Do the work." },
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
  });

  return folder;
}

export const freshSessionBuildFindings = [
  '[fresh-session-not-shared] first: Step "first" names the reserved "fresh" Session; each "fresh" Agent Step opens its own isolated Session per Attempt and does not share one with the other "fresh" Steps (first, second). Name a shared Session explicitly to continue one conversation.',
  '[fresh-session-not-shared] second: Step "second" names the reserved "fresh" Session; each "fresh" Agent Step opens its own isolated Session per Attempt and does not share one with the other "fresh" Steps (first, second). Name a shared Session explicitly to continue one conversation.',
  "Derived requires.engine >=0.1.0.",
];
