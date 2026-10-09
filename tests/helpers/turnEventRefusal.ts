import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { FakeTurnScript } from "../harness/fake-adapter.js";

/** A refused observation followed by content that proves event drainage continued.
 *  The trigger faults only the event insert, leaving admission and settlement usable. */
export function turnEventRefusalScript(
  home: string,
  fault: "invalid" | "storage",
): FakeTurnScript {
  return {
    pace: async (index) => {
      if (fault === "storage" && index === 0) refuseToolAppend(home);
    },
    events: [
      {
        kind: "tool-call",
        call: {
          callId: "refused",
          tool: "file-change",
          input: "requested.ts",
          files: [{ path: fault === "invalid" ? "" : "requested.ts" }],
          outcome: { kind: "completed" },
        },
      },
      {
        kind: "assistant-content",
        messageId: "later",
        content: "Still reading after refusal",
      },
    ],
    result: {
      kind: "completed",
      detail: {
        effectiveModel: { known: false },
        session: { state: "open" },
      },
    },
  };
}

/** Install a local database fault without changing the Store's append Interface. */
export function refuseToolAppend(home: string, allTools = false): void {
  const groups = join(home, "runs");
  const group = join(groups, readdirSync(groups)[0]!);
  const run = readdirSync(group, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  if (run === undefined) throw new Error("Run Store was not created");
  const database = new Database(join(group, run.name, "run.db"));
  try {
    const call = allTools
      ? ""
      : " AND json_extract(NEW.payload, '$.callId') = 'refused'";
    database.exec(
      `CREATE TRIGGER refuse_event BEFORE INSERT ON turn_event WHEN NEW.kind = 'tool-call'${call} BEGIN SELECT RAISE(ABORT, 'injected append fault'); END`,
    );
  } finally {
    database.close();
  }
}
