import assert from "node:assert/strict";
import type {
  HistoryTextReference,
  HistoryItemsReference,
  HistoryContentItem,
  ProjectionPort,
  SessionFileChange,
} from "../../src/application/projection-port.js";

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
async function readItems(
  port: ProjectionPort,
  reference: HistoryItemsReference,
): Promise<HistoryContentItem[]> {
  let continuation: string | undefined;
  let readId: string;
  const items: HistoryContentItem[] = [];
  do {
    const read = await port.readHistoryContent({ reference, continuation });
    assert.ok(read.found && read.type === "history-items");
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 32768);
    items.push(...read.items);
    continuation = read.next;
    readId = read.readId;
  } while (continuation);
  port.releaseHistoryRead(readId);
  return items;
}
interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
/** A file change as content reads rebuild it: the stored change with its patch. */
type ReadFile = Omit<SessionFileChange, "pathContent"> & {
  readonly patch?:
    | { readonly kind: "unified"; readonly content: string }
    | { readonly kind: "structured"; readonly hunks: readonly Hunk[] };
};
export async function readHistoryFiles(
  port: ProjectionPort,
  reference: HistoryItemsReference,
): Promise<ReadFile[]> {
  const files: ReadFile[] = [];
  for (const item of await readItems(port, reference)) {
    assert.ok(item.kind === "file");
    const file: ReadFile = {
      path: await readHistoryText(port, item.path),
      ...(item.change === undefined ? {} : { kind: item.change }),
      ...(item.additions === undefined ? {} : { additions: item.additions }),
      ...(item.removals === undefined ? {} : { removals: item.removals }),
    };
    if (!item.patch) {
      files.push(file);
      continue;
    }
    if (item.patch.kind === "unified") {
      files.push({
        ...file,
        patch: {
          kind: "unified",
          content: await readHistoryText(port, item.patch.content),
        },
      });
      continue;
    }
    const hunks: Hunk[] = [];
    for (const hunk of await readItems(port, item.patch.hunks)) {
      assert.ok(hunk.kind === "hunk");
      const lines: string[] = [];
      for (const line of await readItems(port, hunk.lines)) {
        assert.ok(line.kind === "line");
        lines.push(await readHistoryText(port, line.content));
      }
      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
      });
    }
    files.push({ ...file, patch: { kind: "structured", hunks } });
  }
  return files;
}
