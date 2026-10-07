import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createCodexAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

const fixture = join(import.meta.dirname, "fixtures/codex/codex-qualification");
const schemaText = readFileSync(
  join(fixture, "stable-schema.generated.json"),
  "utf8",
);
const recording: { traffic: { direction: string; line: string }[] } =
  JSON.parse(readFileSync(join(fixture, "case.json"), "utf8"));
const replies = recording.traffic.filter(
  (frame) => frame.direction === "stdout",
);

type Mutation = (schema: unknown) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function at(value: unknown, ...path: string[]): unknown {
  for (const key of path) value = object(value)[key];
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

async function qualify(mutate: Mutation) {
  const schema: unknown = JSON.parse(schemaText);
  mutate(schema);
  const sent: string[] = [];
  let launches = 0;
  let schemaProbes = 0;
  const runtime = createFakeProcess({
    resolutionHandler: () => ({
      kind: "found",
      executable: process.execPath,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      if (options.args.includes("generate-json-schema")) {
        schemaProbes += 1;
        const directory = options.args[options.args.indexOf("--out") + 1];
        assert.ok(directory);
        writeFileSync(
          join(directory, "codex_app_server_protocol.schemas.json"),
          JSON.stringify(schema),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: new TextEncoder().encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request: { id?: number; method: string } = JSON.parse(
            new TextDecoder().decode(bytes),
          );
          sent.push(request.method);
          if (request.id === undefined) return [];
          const reply = replies.find(
            (frame) => JSON.parse(frame.line).id === request.id,
          );
          assert.ok(reply, `recorded reply for ${request.method}`);
          return [
            { kind: "stdout", bytes: new TextEncoder().encode(reply.line) },
          ];
        },
      },
    ],
  });
  // Each case constructs an Adapter so earlier qualification evidence cannot skip its schema probe.
  const prepared = await createCodexAdapter({ env: {} }).prepare({
    workspace: makeTempDir("secant-schema-ws-"),
    process: {
      resolveExecutable: (name, options) =>
        runtime.resolveExecutable(name, options),
      spawnCommand: (options) => runtime.spawnCommand(options),
      spawnCommandSync: (options) => runtime.spawnCommandSync(options),
      spawnOwnedProcess: (options) => {
        launches += 1;
        return runtime.spawnOwnedProcess(options);
      },
    },
  });
  if (prepared.ok) assert.equal((await prepared.harness.close()).clean, true);
  assert.equal(schemaProbes, 1);
  return { prepared, launches, sent };
}

async function accepts(mutate: Mutation) {
  const result = await qualify(mutate);
  assert.equal(result.prepared.ok, true, JSON.stringify(result.prepared));
  assert.equal(result.launches, 1);
  assert.deepEqual(result.sent, [
    "initialize",
    "initialized",
    "account/read",
    "model/list",
  ]);
}

async function rejects(mutate: Mutation) {
  const result = await qualify(mutate);
  assert.equal(result.prepared.ok, false);
  if (result.prepared.ok) throw new Error("expected incompatible schema");
  assert.equal(result.prepared.failure.category, "protocol-incompatible");
  assert.equal(result.prepared.failure.possibleEffects, "none");
  assert.equal(result.launches, 0);
  assert.deepEqual(result.sent, []);
}

for (const [name, path, members] of [
  ["reviewer", ["definitions", "v2", "ApprovalsReviewer", "enum"], ["user"]],
  [
    "tool approval",
    ["definitions", "v2", "AppToolApproval", "enum"],
    ["approve"],
  ],
  [
    "elicitation action",
    ["definitions", "McpServerElicitationAction", "enum"],
    ["accept", "decline"],
  ],
] satisfies [string, string[], string[]][]) {
  test(`Codex semantic schema qualification: accepts reordered ${name} enum`, async () => {
    await accepts((schema) => array(at(schema, ...path)).reverse());
  });
  for (const member of members) {
    test(`Codex semantic schema qualification: rejects missing ${name} ${member}`, async () => {
      await rejects((schema) => {
        const values = array(at(schema, ...path));
        values.splice(values.indexOf(member), 1);
      });
    });
  }
}

const nullableTypes: [string, string[]][] = [
  [
    "start config",
    ["definitions", "v2", "ThreadStartParams", "properties", "config", "type"],
  ],
  [
    "resume config",
    ["definitions", "v2", "ThreadResumeParams", "properties", "config", "type"],
  ],
  [
    "elicitation turn",
    [
      "definitions",
      "McpServerElicitationRequestParams",
      "properties",
      "turnId",
      "type",
    ],
  ],
];
for (const [name, path] of nullableTypes) {
  test(`Codex semantic schema qualification: accepts reordered ${name} types`, async () => {
    await accepts((schema) => array(at(schema, ...path)).reverse());
  });
}

const nullableReferences: [string, string[]][] = [
  [
    "start reviewer",
    [
      "definitions",
      "v2",
      "ThreadStartParams",
      "properties",
      "approvalsReviewer",
      "anyOf",
    ],
  ],
  [
    "resume reviewer",
    [
      "definitions",
      "v2",
      "ThreadResumeParams",
      "properties",
      "approvalsReviewer",
      "anyOf",
    ],
  ],
  [
    "turn effort",
    ["definitions", "v2", "TurnStartParams", "properties", "effort", "anyOf"],
  ],
  [
    "thread effort",
    ["definitions", "v2", "Thread", "properties", "reasoningEffort", "anyOf"],
  ],
];
for (const [name, path] of nullableReferences) {
  test(`Codex semantic schema qualification: accepts reordered ${name} references`, async () => {
    await accepts((schema) => array(at(schema, ...path)).reverse());
  });
}

test("Codex semantic schema qualification: accepts reordered elicitation variants", async () => {
  await accepts((schema) =>
    array(
      at(schema, "definitions", "McpServerElicitationRequestParams", "oneOf"),
    ).reverse(),
  );
});

for (const [name, path] of nullableTypes) {
  for (const member of ["value", "null"]) {
    test(`Codex semantic schema qualification: rejects missing ${name} ${member} type`, async () => {
      await rejects((schema) => {
        const types = array(at(schema, ...path));
        const index =
          member === "null"
            ? types.indexOf("null")
            : types.findIndex((type) => type !== "null");
        types.splice(index, 1);
      });
    });
  }
  test(`Codex semantic schema qualification: rejects rewritten ${name} type`, async () => {
    await rejects((schema) => {
      object(at(schema, ...path.slice(0, -1))).type = "string";
    });
  });
}

for (const [name, path] of nullableReferences) {
  for (const mutation of [
    "changed reference",
    "missing reference",
    "missing null",
  ]) {
    test(`Codex semantic schema qualification: rejects ${name} ${mutation}`, async () => {
      await rejects((schema) => {
        const variants = array(at(schema, ...path));
        variants.reverse();
        const reference = variants.findIndex(
          (variant) => "$ref" in object(variant),
        );
        if (mutation === "changed reference")
          object(variants[reference]).$ref = "#/definitions/v2/TurnStatus";
        else
          variants.splice(
            mutation === "missing reference"
              ? reference
              : variants.findIndex(
                  (variant) => object(variant).type === "null",
                ),
            1,
          );
      });
    });
  }
}

function elicitation(schema: unknown, mode: string): Record<string, unknown> {
  const variants = array(
    at(schema, "definitions", "McpServerElicitationRequestParams", "oneOf"),
  );
  return object(
    variants.find((variant) =>
      array(at(variant, "properties", "mode", "enum")).includes(mode),
    ),
  );
}

for (const mode of ["form", "url"]) {
  test(`Codex semantic schema qualification: rejects missing elicitation ${mode} variant`, async () => {
    await rejects((schema) => {
      const variants = array(
        at(schema, "definitions", "McpServerElicitationRequestParams", "oneOf"),
      );
      const selected = elicitation(schema, mode);
      variants.splice(variants.indexOf(selected), 1);
    });
  });
  for (const field of mode === "url"
    ? ["message", "mode", "url"]
    : ["message", "mode"]) {
    for (const mutation of ["not required", "missing schema", "changed type"]) {
      test(`Codex semantic schema qualification: rejects elicitation ${mode}.${field} ${mutation}`, async () => {
        await rejects((schema) => {
          const selected = elicitation(schema, mode);
          if (mutation === "not required") {
            const required = array(selected.required);
            required.splice(required.indexOf(field), 1);
          } else if (mutation === "missing schema")
            delete object(selected.properties)[field];
          else object(at(selected, "properties", field)).type = "integer";
        });
      });
    }
  }
  test(`Codex semantic schema qualification: rejects elicitation ${mode} object rewrite`, async () => {
    await rejects((schema) => {
      elicitation(schema, mode).type = "array";
    });
  });
}

for (const field of ["serverName", "threadId"]) {
  test(`Codex semantic schema qualification: rejects non-required elicitation ${field}`, async () => {
    await rejects((schema) => {
      const required = array(
        at(
          schema,
          "definitions",
          "McpServerElicitationRequestParams",
          "required",
        ),
      );
      required.splice(required.indexOf(field), 1);
    });
  });
}

test("Codex semantic schema qualification: rejects changed form metadata", async () => {
  await rejects((schema) => {
    object(elicitation(schema, "form").properties)._meta = { type: "string" };
  });
});

test("Codex semantic schema qualification: rejects a changed elicitation response reference", async () => {
  await rejects((schema) => {
    object(
      at(
        schema,
        "definitions",
        "McpServerElicitationRequestResponse",
        "properties",
        "action",
      ),
    ).$ref = "#/definitions/v2/ApprovalsReviewer";
  });
});

test("Codex semantic schema qualification: rejects a non-required elicitation response action", async () => {
  await rejects((schema) => {
    object(
      at(schema, "definitions", "McpServerElicitationRequestResponse"),
    ).required = [];
  });
});

test("Codex semantic schema qualification: accepts the original recorded schema", async () => {
  await accepts(() => {});
});

test("Codex semantic schema qualification: accepts combined reorderings and additions", async () => {
  await accepts((schema) => {
    for (const path of [
      ["definitions", "v2", "ApprovalsReviewer", "enum"],
      ["definitions", "v2", "AppToolApproval", "enum"],
      ["definitions", "McpServerElicitationAction", "enum"],
    ]) {
      const members = array(at(schema, ...path));
      members.reverse();
      members.push("future-member");
    }
    for (const [, path] of [...nullableTypes, ...nullableReferences])
      array(at(schema, ...path)).reverse();
    const variants = array(
      at(schema, "definitions", "McpServerElicitationRequestParams", "oneOf"),
    );
    variants.reverse();
    variants.unshift({
      type: "object",
      properties: { mode: { type: "string", enum: ["future-mode"] } },
      required: ["mode"],
    });
    object(elicitation(schema, "form").properties).futureField = {
      type: "string",
    };
  });
});

for (const [name, path] of [
  [
    "initialize home",
    ["definitions", "InitializeResponse", "properties", "codexHome"],
  ],
  [
    "command approval kind",
    [
      "definitions",
      "CommandExecutionRequestApprovalParams",
      "properties",
      "kind",
    ],
  ],
] satisfies [string, string[]][]) {
  test(`Codex semantic schema qualification: accepts reordered ${name} allOf references`, async () => {
    await accepts((schema) => {
      const references = array(at(schema, ...path, "allOf"));
      references.push({});
      references.reverse();
    });
  });
  for (const mutation of [
    "missing reference",
    "changed reference",
    "overriding reference",
  ]) {
    test(`Codex semantic schema qualification: rejects ${name} ${mutation}`, async () => {
      await rejects((schema) => {
        const property = object(at(schema, ...path));
        const references = array(property.allOf);
        if (mutation === "missing reference") references.splice(0, 1);
        else if (mutation === "changed reference")
          object(references[0]).$ref = "#/definitions/v2/TurnStatus";
        else property.$ref = "#/definitions/v2/TurnStatus";
      });
    });
  }
}

for (const [field, wrongType] of [
  ["delta", "integer"],
  ["summaryIndex", "string"],
  ["itemId", "integer"],
] as const) {
  test(`m10-observed-harness-facts: summary qualification refuses incompatible ${field}`, async () => {
    await rejects((schema) => {
      object(
        at(
          schema,
          "definitions",
          "v2",
          "ReasoningSummaryTextDeltaNotification",
          "properties",
          field,
        ),
      ).type = wrongType;
    });
  });
}
test("m10-observed-harness-facts: summary qualification refuses a non-array completed summary", async () => {
  await rejects((schema) => {
    const reasoning = array(
      at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
    ).find((variant) =>
      array(at(variant, "properties", "type", "enum")).includes("reasoning"),
    );
    object(at(reasoning, "properties", "summary")).type = "string";
  });
});
