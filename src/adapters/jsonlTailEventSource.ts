import fs from "node:fs/promises";
import { resolve } from "node:path";

import chokidar from "chokidar";

export interface JsonlTailReadSegmentResult {
  content: string;
  size: number;
}

export type JsonlTailReadSegment = (
  filePath: string,
  offset: number,
) => Promise<JsonlTailReadSegmentResult>;

export type JsonlTailDiagnostic =
  | {
      type: "malformed-line";
      line: string;
      offset: number;
      cause: unknown;
    }
  | {
      type: "truncated";
      previousOffset: number;
      nextOffset: number;
    }
  | {
      type: "read-in-progress";
    };

export interface JsonlTailReadResult {
  records: unknown[];
  diagnostics: JsonlTailDiagnostic[];
}

export interface JsonlTailEventSource {
  readNewRecords(): Promise<JsonlTailReadResult>;
  watch(
    onRead: (result: JsonlTailReadResult) => void | Promise<void>,
    onError: (error: unknown) => void,
  ): void;
  close(): Promise<void>;
}

export interface JsonlTailEventSourceOptions {
  filePath: string;
  startOffset?: number;
  readSegment?: JsonlTailReadSegment;
  watchFile?: JsonlTailWatchFile;
}

export type JsonlTailWatchEvent = "add" | "change";

export interface JsonlTailWatcher {
  on(
    event: JsonlTailWatchEvent,
    listener: (filePath: string) => void,
  ): JsonlTailWatcher;
  close(): Promise<void> | void;
}

export type JsonlTailWatchFile = (filePath: string) => JsonlTailWatcher;

export function createJsonlTailEventSource(
  options: JsonlTailEventSourceOptions,
): JsonlTailEventSource {
  const readSegment = options.readSegment ?? readFileSegment;
  const watchFile = options.watchFile ?? watchJsonlFile;
  const selectedFilePath = resolve(options.filePath);
  let offset = options.startOffset ?? 0;
  let bufferedLine = "";
  let reading = false;
  let watcher: JsonlTailWatcher | undefined;
  let watchReadActive = false;
  let watchReadPending = false;

  async function readNewRecords(): Promise<JsonlTailReadResult> {
      if (reading) {
        return {
          records: [],
          diagnostics: [{ type: "read-in-progress" }],
        };
      }

      reading = true;

      try {
        const diagnostics: JsonlTailDiagnostic[] = [];
        let readOffset = offset;
        let segment = await readSegment(options.filePath, readOffset);

        if (segment.size < offset) {
          diagnostics.push({
            type: "truncated",
            previousOffset: offset,
            nextOffset: 0,
          });
          offset = 0;
          bufferedLine = "";
          readOffset = 0;
          segment = await readSegment(options.filePath, readOffset);
        }

        if (segment.content.length === 0) {
          return {
            records: [],
            diagnostics,
          };
        }

        offset = readOffset + Buffer.byteLength(segment.content, "utf8");

        const parsed = parseCompletedLines({
          content: bufferedLine + segment.content,
          baseOffset: readOffset - Buffer.byteLength(bufferedLine, "utf8"),
        });
        bufferedLine = parsed.bufferedLine;

        return {
          records: parsed.records,
          diagnostics: [...diagnostics, ...parsed.diagnostics],
        };
      } finally {
        reading = false;
      }
  }

  return {
    readNewRecords,
    watch(onRead, onError) {
      if (watcher) {
        return;
      }

      watcher = watchFile(options.filePath);
      const onWakeup = (filePath: string): void => {
        if (resolve(filePath) !== selectedFilePath) {
          return;
        }

        watchReadPending = true;
        if (watchReadActive) {
          return;
        }

        watchReadActive = true;
        void (async () => {
          while (watchReadPending) {
            watchReadPending = false;
            await onRead(await readNewRecords());
          }
        })()
          .catch(onError)
          .finally(() => {
            watchReadActive = false;
          });
      };

      watcher.on("add", onWakeup);
      watcher.on("change", onWakeup);
    },

    async close() {
      const activeWatcher = watcher;
      watcher = undefined;

      if (activeWatcher) {
        await activeWatcher.close();
      }
    },
  };
}

function watchJsonlFile(filePath: string): JsonlTailWatcher {
  return chokidar.watch(filePath, {
    ignoreInitial: false,
    awaitWriteFinish: false,
  });
}

async function readFileSegment(
  filePath: string,
  offset: number,
): Promise<JsonlTailReadSegmentResult> {
  const stats = await fs.stat(filePath);

  if (stats.size <= offset) {
    return {
      content: "",
      size: stats.size,
    };
  }

  const handle = await fs.open(filePath, "r");

  try {
    const length = stats.size - offset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);

    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}

function parseCompletedLines(options: {
  content: string;
  baseOffset: number;
}): JsonlTailReadResult & { bufferedLine: string } {
  const records: unknown[] = [];
  const diagnostics: JsonlTailDiagnostic[] = [];
  const lines = options.content.split("\n");
  const bufferedLine = options.content.endsWith("\n") ? "" : (lines.pop() ?? "");

  if (options.content.endsWith("\n")) {
    lines.pop();
  }
  let lineOffset = options.baseOffset;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    try {
      records.push(JSON.parse(line));
    } catch (error) {
      diagnostics.push({
        type: "malformed-line",
        line,
        offset: lineOffset,
        cause: error,
      });
    }

    lineOffset += Buffer.byteLength(rawLine, "utf8") + 1;
  }

  return {
    records,
    diagnostics,
    bufferedLine,
  };
}
