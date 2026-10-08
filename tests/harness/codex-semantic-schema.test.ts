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

async function qualify(mutate: Mutation, repeats = 1) {
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
    ownedProcesses: Array.from({ length: repeats }, () => ({
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
    })),
  });
  // Each case constructs an Adapter so earlier qualification evidence cannot skip its schema probe.
  const adapter = createCodexAdapter({ env: {} });
  const options = {
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
  } satisfies Parameters<typeof adapter.prepare>[0];
  const prepared = await adapter.prepare(options);
  const profiles = [];
  if (prepared.ok) {
    profiles.push(prepared.harness.profile);
    assert.equal((await prepared.harness.close()).clean, true);
  }
  for (let attempt = 1; attempt < repeats; attempt++) {
    const repeated = await adapter.prepare(options);
    assert.ok(repeated.ok);
    profiles.push(repeated.harness.profile);
    assert.equal((await repeated.harness.close()).clean, true);
  }
  assert.equal((await adapter.close()).status, "closed");
  assert.equal(schemaProbes, 1);
  return { prepared, launches, sent, profiles };
}

async function accepts(mutate: Mutation, limits: readonly string[] = []) {
  const result = await qualify(mutate);
  assert.equal(result.prepared.ok, true, JSON.stringify(result.prepared));
  if (!result.prepared.ok) throw new Error("expected qualified schema");
  assert.deepEqual(
    object(result.prepared.harness.profile).displayFactLimits,
    limits,
  );
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
  test(`m10-audit-optional-native-facts: summary preview limits incompatible ${field}`, async () => {
    await accepts(
      (schema) => {
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
      },
      [
        "Thought summary previews are unavailable because the installed Harness changed their format.",
      ],
    );
  });
}
test("m10-audit-optional-native-facts: completed summary limits a non-array summary", async () => {
  await accepts(
    (schema) => {
      const reasoning = array(
        at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
      ).find((variant) =>
        array(at(variant, "properties", "type", "enum")).includes("reasoning"),
      );
      object(at(reasoning, "properties", "summary")).type = "string";
    },
    [
      "Thought summaries are unavailable because the installed Harness changed their format.",
    ],
  );
});

const optionalDefinitions: [string, string, Record<string, string>][] = [
  [
    "Thought summary previews",
    "ReasoningSummaryTextDeltaNotification",
    {
      threadId: "string",
      turnId: "string",
      itemId: "string",
      summaryIndex: "integer",
      delta: "string",
    },
  ],
  [
    "Turn diffs",
    "TurnDiffUpdatedNotification",
    { threadId: "string", turnId: "string", diff: "string" },
  ],
  [
    "Context and usage",
    "ThreadTokenUsageUpdatedNotification",
    { threadId: "string", turnId: "string" },
  ],
  [
    "Agent message previews",
    "AgentMessageDeltaNotification",
    { threadId: "string", turnId: "string", itemId: "string", delta: "string" },
  ],
  [
    "Command output previews",
    "CommandExecutionOutputDeltaNotification",
    { threadId: "string", turnId: "string", itemId: "string", delta: "string" },
  ],
];
for (const [label, definition, fields] of optionalDefinitions) {
  const limits = [
    `${label} are unavailable because the installed Harness changed their format.`,
  ];
  for (const field of Object.keys(fields)) {
    test(`m10-audit-optional-native-facts: ${definition}.${field} changed type limits only that display`, async () => {
      await accepts((schema) => {
        object(
          at(schema, "definitions", "v2", definition, "properties", field),
        ).type = "boolean";
      }, limits);
    });
  }
  for (const mutation of [
    "missing definition",
    "renamed notification",
    "changed reference",
    "malformed definition",
  ]) {
    test(`m10-audit-optional-native-facts: ${definition} ${mutation} limits only that display`, async () => {
      await accepts((schema) => {
        const definitions = object(at(schema, "definitions", "v2"));
        if (mutation === "missing definition") delete definitions[definition];
        else if (mutation === "malformed definition")
          definitions[definition] = false;
        else {
          const notification = array(
            at(schema, "definitions", "ServerNotification", "oneOf"),
          ).find(
            (variant) =>
              object(at(variant, "properties", "params")).$ref ===
              `#/definitions/v2/${definition}`,
          );
          assert.ok(notification);
          if (mutation === "renamed notification")
            object(at(notification, "properties", "method")).enum = [
              "changed/upstream",
            ];
          else
            object(at(notification, "properties", "params")).$ref =
              "#/definitions/v2/ChangedNotification";
        }
      }, limits);
    });
  }
}
test("m10-audit-optional-native-facts: reports every optional failure in one qualification", async () => {
  await accepts(
    (schema) => {
      for (const [, definition] of optionalDefinitions)
        delete object(at(schema, "definitions", "v2"))[definition];
      const reasoning = array(
        at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
      ).find((variant) =>
        array(at(variant, "properties", "type", "enum")).includes("reasoning"),
      );
      delete object(at(reasoning, "properties")).summary;
    },
    [
      "Thought summaries",
      "Thought summary previews",
      "Turn diffs",
      "Context and usage",
      "Agent message previews",
      "Command output previews",
    ].map(
      (label) =>
        `${label} are unavailable because the installed Harness changed their format.`,
    ),
  );
});
for (const method of [
  "thread/started",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
]) {
  test(`m10-audit-optional-native-facts: unconsumed ${method} does not gate qualification`, async () => {
    await accepts((schema) => {
      const variants = array(
        at(schema, "definitions", "ServerNotification", "oneOf"),
      );
      const selected = variants.find((variant) =>
        array(at(variant, "properties", "method", "enum")).includes(method),
      );
      assert.ok(selected);
      const reference = object(at(selected, "properties", "params")).$ref;
      assert.equal(typeof reference, "string");
      if (typeof reference !== "string") throw new Error("reference required");
      const definition = reference.split("/").at(-1);
      assert.ok(definition);
      delete object(at(schema, "definitions", "v2"))[definition];
      variants.splice(variants.indexOf(selected), 1);
    });
  });
}
test("m10-audit-optional-native-facts: multiple required failures remain typed and retain diagnostics", async () => {
  const result = await qualify((schema) => {
    object(
      at(schema, "definitions", "v2", "TurnCompletedNotification"),
    ).required = [];
    object(
      at(schema, "definitions", "v2", "ModelReroutedNotification"),
    ).required = [];
  });
  assert.ok(!result.prepared.ok);
  assert.equal(result.prepared.failure.category, "protocol-incompatible");
  assert.match(
    result.prepared.failure.diagnostics ?? "",
    /turn\/completed notification/,
  );
  assert.match(
    result.prepared.failure.diagnostics ?? "",
    /model reroute notification/,
  );
});
test("m10-audit-optional-native-facts: classified notifications equal runtime consumption and model-output items stay required", () => {
  const classification = readFileSync(
    new URL("../../src/harness/codex/required-schema.ts", import.meta.url),
    "utf8",
  );
  const runtime = readFileSync(
    new URL("../../src/harness/codex/runtime-protocol.ts", import.meta.url),
    "utf8",
  );
  const list = (name: string) => {
    const body = classification.match(
      new RegExp(String.raw`const ${name}[^=]*= \{([\s\S]*?)\n\};`),
    )?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/^ {2}(?:"([^"]+)"|(\w+)): /gm)]
      .map((match) => match[1] ?? match[2])
      .sort();
  };
  const optional = classification
    .split("export const OPTIONAL_SCHEMA_FACTS =")[1]
    ?.split("] as const;")[0];
  assert.ok(optional);
  const optionalMethods = [...optional.matchAll(/method: "([^"]+)"/g)].map(
    (match) => match[1],
  );
  const parser = runtime
    .split("export function parseRuntimeNotification(")[1]
    ?.split("const MODEL_OUTPUT_ITEM_TYPES")[0];
  assert.ok(parser);
  const consumed = [
    ...new Set(
      [...parser.matchAll(/(?:case |method === )"([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  assert.deepEqual(
    [
      ...list("SERVER_NOTIFICATIONS"),
      ...list("SERVER_REQUESTS"),
      ...optionalMethods,
    ].sort(),
    consumed,
  );
  const modelOutputs = runtime.match(
    /const MODEL_OUTPUT_ITEM_TYPES[^=]*= new Set\(\[([\s\S]*?)\]\)/,
  )?.[1];
  assert.ok(modelOutputs);
  assert.deepEqual(
    list("THREAD_ITEMS"),
    [
      "userMessage",
      ...[...modelOutputs.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ].sort(),
  );
  const normalization = runtime
    .split("function normalizeItemContent(")[1]
    ?.split("function fileChangeApprovalInput(")[0];
  assert.ok(normalization);
  const contentKinds = new Set(
    [...normalization.matchAll(/(?:case |if \(type === )"([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  for (const [, kind] of modelOutputs.matchAll(/"([^"]+)"/g)) {
    assert.ok(kind);
    if (contentKinds.has(kind)) continue;
    const requiredFields = classification.match(
      new RegExp(String.raw`^ {2}${kind}: (\[[^\n]+\]),$`, "m"),
    )?.[1];
    assert.ok(requiredFields, kind);
    assert.deepEqual(
      JSON.parse(requiredFields),
      ["id", "type"],
      `${kind} supplies identity only`,
    );
  }
});

test("m10-audit-optional-native-facts: schema cache reuses the disabled-fact set across preparations", async () => {
  const result = await qualify((schema) => {
    delete object(at(schema, "definitions", "v2"))
      .AgentMessageDeltaNotification;
  }, 2);
  assert.equal(result.launches, 2);
  assert.deepEqual(
    result.profiles.map((profile) => profile.displayFactLimits),
    [
      [
        "Agent message previews are unavailable because the installed Harness changed their format.",
      ],
      [
        "Agent message previews are unavailable because the installed Harness changed their format.",
      ],
    ],
  );
});

test("m10-audit-optional-native-facts: every missing required notification is evaluated", async () => {
  const result = await qualify((schema) => {
    const variants = array(
      at(schema, "definitions", "ServerNotification", "oneOf"),
    );
    for (const method of ["turn/completed", "model/rerouted"]) {
      const selected = variants.find((variant) =>
        array(at(variant, "properties", "method", "enum")).includes(method),
      );
      assert.ok(selected);
      variants.splice(variants.indexOf(selected), 1);
    }
  });
  assert.ok(!result.prepared.ok);
  assert.equal(result.prepared.failure.category, "protocol-incompatible");
  assert.match(result.prepared.failure.diagnostics ?? "", /turn\/completed/);
  assert.match(result.prepared.failure.diagnostics ?? "", /model\/rerouted/);
});

for (const item of [
  "plan",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]) {
  test(`m10-audit-optional-native-facts: ${item} Steer-delivery identity stays required`, async () => {
    await rejects((schema) => {
      const variants = array(
        at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
      );
      const selected = variants.find((variant) =>
        array(at(variant, "properties", "type", "enum")).includes(item),
      );
      assert.ok(selected);
      variants.splice(variants.indexOf(selected), 1);
    });
  });
}
for (const [definition, field, mutation] of [
  ["ThreadTokenUsage", "total", "reference"],
  ["ThreadTokenUsage", "last", "reference"],
  ["ThreadTokenUsage", "modelContextWindow", "type"],
  ...[
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ].map((field) => ["TokenUsageBreakdown", field, "type"]),
]) {
  test(`m10-audit-optional-native-facts: ${definition}.${field} changed accounting shape limits only usage`, async () => {
    assert.ok(definition && field);
    await accepts(
      (schema) => {
        const property = object(
          at(schema, "definitions", "v2", definition, "properties", field),
        );
        if (mutation === "reference")
          property.$ref = "#/definitions/v2/UnknownUsage";
        else property.type = "string";
      },
      [
        "Context and usage are unavailable because the installed Harness changed their format.",
      ],
    );
  });
}

for (const [definition, fields] of [
  ["TurnStartedNotification", ["threadId"]],
  ["ItemStartedNotification", ["threadId", "turnId"]],
  ["ItemCompletedNotification", ["threadId", "turnId"]],
  ["ModelReroutedNotification", ["threadId", "turnId"]],
  ["ErrorNotification", ["threadId", "turnId"]],
] satisfies [string, string[]][]) {
  for (const field of fields) {
    test(`m10-audit-optional-native-facts: required ${definition}.${field} correlation cannot change type`, async () => {
      await rejects((schema) => {
        object(
          at(schema, "definitions", "v2", definition, "properties", field),
        ).type = "integer";
      });
    });
  }
}

test("m10-audit-optional-native-facts: Steer history identity shape stays required", async () => {
  await rejects((schema) => {
    const item = array(
      at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
    ).find((variant) =>
      array(at(variant, "properties", "type", "enum")).includes("userMessage"),
    );
    object(at(item, "properties", "clientId")).type = "integer";
  });
});

for (const item of [
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]) {
  test(`m10-audit-optional-native-facts: unused ${item} fields do not gate its required Steer identity`, async () => {
    await accepts((schema) => {
      const selected = array(
        at(schema, "definitions", "v2", "ThreadItem", "oneOf"),
      ).find((variant) =>
        array(at(variant, "properties", "type", "enum")).includes(item),
      );
      const fields = object(at(selected, "properties"));
      for (const field of Object.keys(fields))
        if (!["id", "type"].includes(field)) delete fields[field];
      object(selected).required = ["id", "type"];
      const definitions = object(at(schema, "definitions", "v2"));
      delete definitions.DynamicToolCallStatus;
      delete definitions.CollabAgentToolCallStatus;
    });
  });
}
