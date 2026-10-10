import assert from "node:assert/strict";
import type {
  HistoryTextReference,
  ProjectionPort,
} from "../../src/application/projection-port.js";
import type { TurnFactData } from "../helpers/turnFact.js";

export async function readHistoryText(
  port: ProjectionPort,
  reference: HistoryTextReference,
): Promise<string> {
  let continuation: string | undefined,
    content = "";
  let readId: string;
  do {
    const read = await port.readHistoryContent({ reference, continuation });
    assert.ok(read.found && read.type === "history-text");
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 32768);
    content += read.content;
    continuation = read.next;
    readId = read.readId;
  } while (continuation);
  port.releaseHistoryRead(readId);
  return content;
}

/** A structured Turn diff whose detail text is about `bytes` long. */
export function structuredDiff(bytes: number): TurnFactData<"turn-diff"> {
  const line = "+" + "const value = compute(input, options);".padEnd(59, " ");
  const lines = Math.ceil(bytes / (line.length + 1));
  const hunks = [];
  for (let at = 0; at < lines; at += 8)
    hunks.push({
      oldStart: at + 1,
      oldLines: 0,
      newStart: at + 1,
      newLines: 8,
      lines: Array.from(
        { length: Math.min(8, lines - at) },
        (_, i) => `${line}${at + i}`,
      ),
    });
  return {
    content: "Turn diff",
    files: [
      {
        path: "src/large.ts",
        kind: "update",
        patch: { kind: "structured", hunks },
      },
    ],
  };
}
