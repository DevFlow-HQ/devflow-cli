import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  createJsonlTailEventSource,
  type JsonlTailReadSegment,
} from "../../src/adapters/jsonlTailEventSource.js";

test("JSONL tailer reads only newly appended records across repeated reads", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "devflow-jsonl-tail-"));
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

test("JSONL tailer buffers an incomplete trailing line until it is terminated", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "devflow-jsonl-tail-"));
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
  const directory = await fs.mkdtemp(join(tmpdir(), "devflow-jsonl-tail-"));
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
  const directory = await fs.mkdtemp(join(tmpdir(), "devflow-jsonl-tail-"));
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
  const directory = await fs.mkdtemp(join(tmpdir(), "devflow-jsonl-tail-"));
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
