import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  createJsonlTailEventSource,
  type JsonlTailReadSegment,
  type JsonlTailWatchEvent,
  type JsonlTailWatcher,
} from "../../src/adapters/jsonlTailEventSource.js";

import { makeTempDir } from "../helpers/tempDir.js";
class FakeJsonlTailWatcher implements JsonlTailWatcher {
  readonly listeners = new Map<
    JsonlTailWatchEvent,
    Array<(filePath: string) => void>
  >();
  closeCount = 0;

  on(
    event: JsonlTailWatchEvent,
    listener: (filePath: string) => void,
  ): JsonlTailWatcher {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  emit(event: JsonlTailWatchEvent, filePath: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(filePath);
    }
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("JSONL tailer reads only newly appended records across repeated reads", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  await fs.writeFile(logPath, '{"id":1}\n{"id":2}\n', "utf8");
  const tailer = createJsonlTailEventSource({ filePath: logPath });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 1 }, { id: 2 }],
    diagnostics: [],
  });
  assert.deepEqual(await tailer.readNewRecords(), {
    records: [],
    diagnostics: [],
  });

  await fs.appendFile(logPath, '{"id":3}\n', "utf8");

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 3 }],
    diagnostics: [],
  });
});

test("JSONL tailer starts from an explicit offset on the first read", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  const completedTurn = '{"id":"completed"}\n';
  await fs.writeFile(logPath, `${completedTurn}{"id":"resumed"}\n`, "utf8");
  const tailer = createJsonlTailEventSource({
    filePath: logPath,
    startOffset: Buffer.byteLength(completedTurn, "utf8"),
  });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: "resumed" }],
    diagnostics: [],
  });
});

test("JSONL tailer watches later appends after starting from an explicit offset", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  const staleRecord = '{"id":"stale"}\n';
  const watcher = new FakeJsonlTailWatcher();
  const results: Array<unknown[]> = [];
  await fs.writeFile(logPath, staleRecord, "utf8");
  const tailer = createJsonlTailEventSource({
    filePath: logPath,
    startOffset: Buffer.byteLength(staleRecord, "utf8"),
    watchFile() {
      return watcher;
    },
  });

  tailer.watch(
    (result) => {
      results.push(result.records);
    },
    (error) => assert.fail(error as Error),
  );

  await fs.appendFile(logPath, '{"id":"resumed"}\n', "utf8");
  watcher.emit("change", logPath);
  await waitFor(() => results.length === 1);

  assert.deepEqual(results, [[{ id: "resumed" }]]);
});

test("JSONL tailer starts from offset zero when no offset is provided", async () => {
  const readOffsets: number[] = [];
  const readSegment: JsonlTailReadSegment = async (_filePath, offset) => {
    readOffsets.push(offset);

    return {
      content: offset === 0 ? '{"id":1}\n' : "",
      size: 9,
    };
  };
  const tailer = createJsonlTailEventSource({
    filePath: "/provider/session.jsonl",
    readSegment,
  });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 1 }],
    diagnostics: [],
  });
  assert.deepEqual(readOffsets, [0]);
});

test("JSONL tailer buffers an incomplete trailing line until it is terminated", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  await fs.writeFile(logPath, '{"id":1}\n{"id"', "utf8");
  const tailer = createJsonlTailEventSource({ filePath: logPath });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 1 }],
    diagnostics: [],
  });

  await fs.appendFile(logPath, ':2}\n', "utf8");

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 2 }],
    diagnostics: [],
  });
});

test("JSONL tailer skips newline-terminated malformed lines with debug metadata", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  await fs.writeFile(logPath, '{"id":1}\n{nope}\n{"id":2}\n', "utf8");
  const tailer = createJsonlTailEventSource({ filePath: logPath });

  const result = await tailer.readNewRecords();

  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.type, "malformed-line");
  assert.equal(result.diagnostics[0]?.line, "{nope}");
  assert.equal(result.diagnostics[0]?.offset, 9);
});

test("JSONL tailer resets safely after truncation without emitting corrupt partial records", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  await fs.writeFile(logPath, '{"id":1}\n{"id":2}', "utf8");
  const tailer = createJsonlTailEventSource({ filePath: logPath });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 1 }],
    diagnostics: [],
  });

  await fs.writeFile(logPath, '{"id":3}\n', "utf8");

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [{ id: 3 }],
    diagnostics: [{ type: "truncated", previousOffset: 17, nextOffset: 0 }],
  });
});

test("JSONL tailer passes through unknown valid records", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  const nativeRecord = {
    type: "future-provider-record",
    nested: { value: true },
  };
  await fs.writeFile(logPath, `${JSON.stringify(nativeRecord)}\n`, "utf8");
  const tailer = createJsonlTailEventSource({ filePath: logPath });

  assert.deepEqual(await tailer.readNewRecords(), {
    records: [nativeRecord],
    diagnostics: [],
  });
});

test("JSONL tailer isolates slow reads so overlapping polls stay responsive", async () => {
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readSegment: JsonlTailReadSegment = async () => {
    await readReleased;

    return {
      content: '{"id":1}\n',
      size: 9,
    };
  };
  const tailer = createJsonlTailEventSource({
    filePath: "/provider/session.jsonl",
    readSegment,
  });

  const slowRead = tailer.readNewRecords();
  const overlappingRead = await tailer.readNewRecords();

  assert.deepEqual(overlappingRead, {
    records: [],
    diagnostics: [{ type: "read-in-progress" }],
  });

  releaseRead();

  assert.deepEqual(await slowRead, {
    records: [{ id: 1 }],
    diagnostics: [],
  });
});

test("JSONL tailer consumes add and change wakeups for only the selected rollout file", async () => {
  const directory = makeTempDir("devflow-jsonl-tail-");
  const logPath = join(directory, "session.jsonl");
  const otherPath = join(directory, "other.jsonl");
  const watcher = new FakeJsonlTailWatcher();
  const watchedPaths: string[] = [];
  const results: Array<unknown[]> = [];
  await fs.writeFile(logPath, "", "utf8");
  const tailer = createJsonlTailEventSource({
    filePath: logPath,
    watchFile(filePath) {
      watchedPaths.push(filePath);
      return watcher;
    },
  });

  tailer.watch(
    (result) => {
      results.push(result.records);
    },
    (error) => assert.fail(error as Error),
  );

  await fs.appendFile(otherPath, '{"id":"other"}\n', "utf8");
  watcher.emit("add", otherPath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(results, []);

  await fs.appendFile(logPath, '{"id":1}\n', "utf8");
  watcher.emit("add", logPath);
  await waitFor(() => results.length === 1);

  await fs.appendFile(logPath, '{"id":2}\n', "utf8");
  watcher.emit("change", logPath);
  await waitFor(() => results.length === 2);

  assert.deepEqual(watchedPaths, [logPath]);
  assert.deepEqual(results, [[{ id: 1 }], [{ id: 2 }]]);

  await tailer.close();

  assert.equal(watcher.closeCount, 1);
});
