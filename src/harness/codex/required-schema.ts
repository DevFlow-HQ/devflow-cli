import { z } from "zod";

const discriminatorSchema = z.looseObject({ enum: z.array(z.string()) });
const variantSchema = z.looseObject({
  properties: z.looseObject({
    method: discriminatorSchema.optional(),
    type: discriminatorSchema.optional(),
    mode: discriminatorSchema.optional(),
  }),
  required: z.array(z.string()).optional(),
});
// Malformed unconsumed/optional variants cannot poison the required bundle.
// Their absence is classified by the named lists below.
const variantsSchema = z.looseObject({
  oneOf: z.array(variantSchema.catch({ properties: {} })),
});
const enumSchema = z.looseObject({ enum: z.array(z.string()) });
const shapeSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});
const optionalShapeSchema = shapeSchema.extend({ type: z.literal("object") });
const literalUnionSchema = z.looseObject({
  oneOf: z.array(z.looseObject({ enum: z.array(z.string()).optional() })),
});
const primitiveUnionSchema = z.looseObject({
  anyOf: z.array(z.looseObject({ type: z.string().optional() })),
});
const generatedSchema = z.looseObject({
  definitions: z.looseObject({
    ClientRequest: variantsSchema,
    ClientNotification: variantsSchema,
    ServerNotification: variantsSchema,
    ServerRequest: variantsSchema,
    InitializeParams: shapeSchema,
    InitializeResponse: shapeSchema,
    CommandExecutionRequestApprovalParams: shapeSchema,
    CommandExecutionRequestApprovalResponse: shapeSchema,
    CommandExecutionApprovalDecision: literalUnionSchema,
    CommandExecutionApprovalKind: enumSchema,
    FileChangeRequestApprovalParams: shapeSchema,
    FileChangeRequestApprovalResponse: shapeSchema,
    FileChangeApprovalDecision: literalUnionSchema,
    McpServerElicitationAction: enumSchema,
    McpServerElicitationRequestParams: shapeSchema.extend({
      oneOf: z.array(variantSchema),
    }),
    McpServerElicitationRequestResponse: shapeSchema,
    v2: z.looseObject({
      ApprovalsReviewer: enumSchema,
      AppToolApproval: enumSchema,
      TurnStatus: enumSchema,
      CommandExecutionStatus: enumSchema,
      PatchApplyStatus: enumSchema,
      McpToolCallStatus: enumSchema,
      ThreadItem: variantsSchema,
      FileUpdateChange: shapeSchema,
      PatchChangeKind: variantsSchema,
      Thread: shapeSchema,
      Turn: shapeSchema,
      ThreadStartParams: shapeSchema,
      ThreadStartResponse: shapeSchema,
      ThreadResumeParams: shapeSchema,
      ThreadResumeResponse: shapeSchema,
      ThreadReadParams: shapeSchema,
      ThreadReadResponse: shapeSchema,
      TurnStartParams: shapeSchema,
      TurnStartResponse: shapeSchema,
      TurnSteerParams: shapeSchema,
      TurnSteerResponse: shapeSchema,
      TurnInterruptParams: shapeSchema,
      TurnInterruptResponse: shapeSchema,
      ModelListParams: shapeSchema,
      ModelListResponse: shapeSchema,
      GetAccountParams: shapeSchema,
      GetAccountResponse: shapeSchema,
      ErrorNotification: shapeSchema,
      ModelReroutedNotification: shapeSchema,
      TurnStartedNotification: shapeSchema,
      TurnCompletedNotification: shapeSchema,
      ItemStartedNotification: shapeSchema,
      ItemCompletedNotification: shapeSchema,
      ServerRequestResolvedNotification: shapeSchema,
      RequestId: primitiveUnionSchema,
    }),
  }),
});

type TRequiredVariants = Readonly<Record<string, readonly string[]>>;

const CLIENT_REQUESTS: TRequiredVariants = {
  initialize: ["id", "method", "params"],
  "thread/start": ["id", "method", "params"],
  "thread/resume": ["id", "method", "params"],
  "thread/read": ["id", "method", "params"],
  "turn/start": ["id", "method", "params"],
  "turn/steer": ["id", "method", "params"],
  "turn/interrupt": ["id", "method", "params"],
  "model/list": ["id", "method", "params"],
  "account/read": ["id", "method", "params"],
};

const CLIENT_NOTIFICATIONS: TRequiredVariants = {
  initialized: ["method"],
};

const SERVER_NOTIFICATIONS: TRequiredVariants = {
  error: ["method", "params"],
  "turn/started": ["method", "params"],
  "turn/completed": ["method", "params"],
  "item/started": ["method", "params"],
  "item/completed": ["method", "params"],
  "serverRequest/resolved": ["method", "params"],
  "model/rerouted": ["method", "params"],
};

const SERVER_REQUESTS: TRequiredVariants = {
  "item/commandExecution/requestApproval": ["id", "method", "params"],
  "item/fileChange/requestApproval": ["id", "method", "params"],
  "mcpServer/elicitation/request": ["id", "method", "params"],
  "item/tool/requestUserInput": ["id", "method", "params"],
};

const THREAD_ITEMS: TRequiredVariants = {
  userMessage: ["id", "content", "type"],
  agentMessage: ["id", "text", "type"],
  reasoning: ["id", "type"],
  plan: ["id", "type"],
  commandExecution: ["id", "command", "status", "type"],
  fileChange: ["id", "changes", "status", "type"],
  mcpToolCall: ["id", "server", "tool", "status", "type"],
  dynamicToolCall: ["id", "type"],
  collabAgentToolCall: ["id", "type"],
  webSearch: ["id", "type"],
  imageView: ["id", "type"],
  imageGeneration: ["id", "type"],
};

const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"];
const FILE_CHANGE_KINDS: TRequiredVariants = {
  add: ["type"],
  delete: ["type"],
  update: ["type"],
};

const CLIENT_REQUEST_PARAM_REFS: Readonly<Record<string, string>> = {
  initialize: "#/definitions/InitializeParams",
  "thread/start": "#/definitions/v2/ThreadStartParams",
  "thread/resume": "#/definitions/v2/ThreadResumeParams",
  "thread/read": "#/definitions/v2/ThreadReadParams",
  "turn/start": "#/definitions/v2/TurnStartParams",
  "turn/steer": "#/definitions/v2/TurnSteerParams",
  "turn/interrupt": "#/definitions/v2/TurnInterruptParams",
  "model/list": "#/definitions/v2/ModelListParams",
  "account/read": "#/definitions/v2/GetAccountParams",
};

const SERVER_NOTIFICATION_PARAM_REFS: Readonly<Record<string, string>> = {
  error: "#/definitions/v2/ErrorNotification",
  "turn/started": "#/definitions/v2/TurnStartedNotification",
  "turn/completed": "#/definitions/v2/TurnCompletedNotification",
  "item/started": "#/definitions/v2/ItemStartedNotification",
  "item/completed": "#/definitions/v2/ItemCompletedNotification",
  "serverRequest/resolved":
    "#/definitions/v2/ServerRequestResolvedNotification",
  "model/rerouted": "#/definitions/v2/ModelReroutedNotification",
};

const SERVER_REQUEST_PARAM_REFS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval":
    "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval":
    "#/definitions/FileChangeRequestApprovalParams",
  "mcpServer/elicitation/request":
    "#/definitions/McpServerElicitationRequestParams",
  "item/tool/requestUserInput": "#/definitions/ToolRequestUserInputParams",
};

const SERVER_REQUEST_ID_REFS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "#/definitions/v2/RequestId",
  "item/fileChange/requestApproval": "#/definitions/v2/RequestId",
};

const THREAD_ITEM_FIELD_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  userMessage: { id: "string", content: "array" },
  agentMessage: { id: "string", text: "string" },
  reasoning: { id: "string" },
  plan: { id: "string" },
  commandExecution: { id: "string", command: "string" },
  fileChange: { id: "string", changes: "array" },
  mcpToolCall: { id: "string", server: "string", tool: "string" },
  dynamicToolCall: { id: "string" },
  collabAgentToolCall: { id: "string" },
  webSearch: { id: "string" },
  imageView: { id: "string" },
  imageGeneration: { id: "string" },
};

const THREAD_ITEM_FIELD_REFS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  commandExecution: {
    status: "#/definitions/v2/CommandExecutionStatus",
  },
  fileChange: { status: "#/definitions/v2/PatchApplyStatus" },
  mcpToolCall: { status: "#/definitions/v2/McpToolCallStatus" },
};

const THREAD_ITEM_ARRAY_ITEM_REFS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  fileChange: { changes: "#/definitions/v2/FileUpdateChange" },
};

interface TSchemaFact {
  readonly path: readonly string[];
  readonly expected: string | boolean;
  readonly label: string;
}

const REQUIRED_SCHEMA_FACTS: readonly TSchemaFact[] = [
  ...[
    "ErrorNotification",
    "ItemStartedNotification",
    "ItemCompletedNotification",
    "ModelReroutedNotification",
  ].flatMap((definition) =>
    ["threadId", "turnId"].map((field) =>
      fact(
        `${definition} ${field}`,
        "string",
        "definitions",
        "v2",
        definition,
        "properties",
        field,
        "type",
      ),
    ),
  ),
  fact(
    "Turn start correlation",
    "string",
    "definitions",
    "v2",
    "TurnStartedNotification",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "Turn error message",
    "string",
    "definitions",
    "v2",
    "TurnError",
    "properties",
    "message",
    "type",
  ),
  fact(
    "MCP config map",
    true,
    "definitions",
    "v2",
    "ThreadStartParams",
    "properties",
    "config",
    "additionalProperties",
  ),
  fact(
    "MCP resume config map",
    true,
    "definitions",
    "v2",
    "ThreadResumeParams",
    "properties",
    "config",
    "additionalProperties",
  ),
  fact(
    "elicitation server",
    "string",
    "definitions",
    "McpServerElicitationRequestParams",
    "properties",
    "serverName",
    "type",
  ),
  fact(
    "elicitation thread",
    "string",
    "definitions",
    "McpServerElicitationRequestParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "elicitation response",
    "#/definitions/McpServerElicitationAction",
    "definitions",
    "McpServerElicitationRequestResponse",
    "properties",
    "action",
    "$ref",
  ),
  fact(
    "user input answers",
    "object",
    "definitions",
    "ToolRequestUserInputResponse",
    "properties",
    "answers",
    "type",
  ),
  fact(
    "initialize client info",
    "#/definitions/ClientInfo",
    "definitions",
    "InitializeParams",
    "properties",
    "clientInfo",
    "$ref",
  ),
  fact(
    "experimental API opt-out",
    "boolean",
    "definitions",
    "InitializeCapabilities",
    "properties",
    "experimentalApi",
    "type",
  ),
  fact(
    "initialize user agent",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "userAgent",
    "type",
  ),
  fact(
    "initialize platform family",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "platformFamily",
    "type",
  ),
  fact(
    "initialize platform OS",
    "string",
    "definitions",
    "InitializeResponse",
    "properties",
    "platformOs",
    "type",
  ),
  fact(
    "thread/start response",
    "#/definitions/v2/Thread",
    "definitions",
    "v2",
    "ThreadStartResponse",
    "properties",
    "thread",
    "$ref",
  ),
  fact(
    "thread/resume id",
    "string",
    "definitions",
    "v2",
    "ThreadResumeParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "thread/resume response",
    "#/definitions/v2/Thread",
    "definitions",
    "v2",
    "ThreadResumeResponse",
    "properties",
    "thread",
    "$ref",
  ),
  fact(
    "turn/start thread id",
    "string",
    "definitions",
    "v2",
    "TurnStartParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/start input",
    "array",
    "definitions",
    "v2",
    "TurnStartParams",
    "properties",
    "input",
    "type",
  ),
  fact(
    "reasoning effort",
    "string",
    "definitions",
    "v2",
    "ReasoningEffort",
    "type",
  ),
  fact(
    "thread/read id",
    "string",
    "definitions",
    "v2",
    "ThreadReadParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "thread/read response",
    "#/definitions/v2/Thread",
    "definitions",
    "v2",
    "ThreadReadResponse",
    "properties",
    "thread",
    "$ref",
  ),
  fact(
    "rerouted model",
    "string",
    "definitions",
    "v2",
    "ModelReroutedNotification",
    "properties",
    "toModel",
    "type",
  ),
  fact(
    "turn/start response",
    "#/definitions/v2/Turn",
    "definitions",
    "v2",
    "TurnStartResponse",
    "properties",
    "turn",
    "$ref",
  ),
  fact(
    "turn/steer expected id",
    "string",
    "definitions",
    "v2",
    "TurnSteerParams",
    "properties",
    "expectedTurnId",
    "type",
  ),
  fact(
    "turn/steer input",
    "array",
    "definitions",
    "v2",
    "TurnSteerParams",
    "properties",
    "input",
    "type",
  ),
  fact(
    "turn/interrupt thread id",
    "string",
    "definitions",
    "v2",
    "TurnInterruptParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/interrupt turn id",
    "string",
    "definitions",
    "v2",
    "TurnInterruptParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "model list data",
    "array",
    "definitions",
    "v2",
    "ModelListResponse",
    "properties",
    "data",
    "type",
  ),
  fact(
    "account auth requirement",
    "boolean",
    "definitions",
    "v2",
    "GetAccountResponse",
    "properties",
    "requiresOpenaiAuth",
    "type",
  ),
  fact(
    "thread id",
    "string",
    "definitions",
    "v2",
    "Thread",
    "properties",
    "id",
    "type",
  ),
  fact(
    "Turn id",
    "string",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "id",
    "type",
  ),
  fact(
    "Turn items",
    "array",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "items",
    "type",
  ),
  fact(
    "Turn status",
    "#/definitions/v2/TurnStatus",
    "definitions",
    "v2",
    "Turn",
    "properties",
    "status",
    "$ref",
  ),
  fact(
    "command approval decision",
    "#/definitions/CommandExecutionApprovalDecision",
    "definitions",
    "CommandExecutionRequestApprovalResponse",
    "properties",
    "decision",
    "$ref",
  ),
  fact(
    "file approval decision",
    "#/definitions/FileChangeApprovalDecision",
    "definitions",
    "FileChangeRequestApprovalResponse",
    "properties",
    "decision",
    "$ref",
  ),
  fact(
    "error notification error",
    "#/definitions/v2/TurnError",
    "definitions",
    "v2",
    "ErrorNotification",
    "properties",
    "error",
    "$ref",
  ),
  fact(
    "error notification retry",
    "boolean",
    "definitions",
    "v2",
    "ErrorNotification",
    "properties",
    "willRetry",
    "type",
  ),
  fact(
    "turn/completed thread id",
    "string",
    "definitions",
    "v2",
    "TurnCompletedNotification",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "turn/completed Turn",
    "#/definitions/v2/Turn",
    "definitions",
    "v2",
    "TurnCompletedNotification",
    "properties",
    "turn",
    "$ref",
  ),
  fact(
    "item/started item",
    "#/definitions/v2/ThreadItem",
    "definitions",
    "v2",
    "ItemStartedNotification",
    "properties",
    "item",
    "$ref",
  ),
  fact(
    "item/completed item",
    "#/definitions/v2/ThreadItem",
    "definitions",
    "v2",
    "ItemCompletedNotification",
    "properties",
    "item",
    "$ref",
  ),
  fact(
    "command approval item id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "itemId",
    "type",
  ),
  fact(
    "file approval item id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "itemId",
    "type",
  ),
  fact(
    "command approval thread id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "command approval turn id",
    "string",
    "definitions",
    "CommandExecutionRequestApprovalParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "file approval thread id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "threadId",
    "type",
  ),
  fact(
    "file approval turn id",
    "string",
    "definitions",
    "FileChangeRequestApprovalParams",
    "properties",
    "turnId",
    "type",
  ),
  fact(
    "file change path",
    "string",
    "definitions",
    "v2",
    "FileUpdateChange",
    "properties",
    "path",
    "type",
  ),
  fact(
    "file change kind",
    "#/definitions/v2/PatchChangeKind",
    "definitions",
    "v2",
    "FileUpdateChange",
    "properties",
    "kind",
    "$ref",
  ),
  fact(
    "request resolution id",
    "#/definitions/v2/RequestId",
    "definitions",
    "v2",
    "ServerRequestResolvedNotification",
    "properties",
    "requestId",
    "$ref",
  ),
  fact(
    "request resolution thread id",
    "string",
    "definitions",
    "v2",
    "ServerRequestResolvedNotification",
    "properties",
    "threadId",
    "type",
  ),
];

/** Private display classification. A completed summary and its live preview can
 * degrade independently; missing model/settings output does not affect this check. */
export const OPTIONAL_SCHEMA_FACTS = [
  {
    fact: "thought-summary",
    label: "Thought summaries",
    item: "reasoning",
    field: "summary",
  },
  {
    fact: "thought-preview",
    label: "Thought summary previews",
    method: "item/reasoning/summaryTextDelta",
    definition: "ReasoningSummaryTextDeltaNotification",
    fields: {
      threadId: "string",
      turnId: "string",
      itemId: "string",
      summaryIndex: "integer",
      delta: "string",
    },
  },
  {
    fact: "turn-diff",
    label: "Turn diffs",
    method: "turn/diff/updated",
    definition: "TurnDiffUpdatedNotification",
    fields: { threadId: "string", turnId: "string", diff: "string" },
  },
  {
    fact: "usage",
    label: "Context and usage",
    method: "thread/tokenUsage/updated",
    definition: "ThreadTokenUsageUpdatedNotification",
    fields: { threadId: "string", turnId: "string" },
  },
  {
    fact: "agent-preview",
    label: "Agent message previews",
    method: "item/agentMessage/delta",
    definition: "AgentMessageDeltaNotification",
    fields: {
      threadId: "string",
      turnId: "string",
      itemId: "string",
      delta: "string",
    },
  },
  {
    fact: "command-preview",
    label: "Command output previews",
    method: "item/commandExecution/outputDelta",
    definition: "CommandExecutionOutputDeltaNotification",
    fields: {
      threadId: "string",
      turnId: "string",
      itemId: "string",
      delta: "string",
    },
  },
] as const;

export type CodexDisplayFact = (typeof OPTIONAL_SCHEMA_FACTS)[number]["fact"];

type TOptionalSchemaFact = (typeof OPTIONAL_SCHEMA_FACTS)[number];

function optionalFactCompatible(
  schema: z.infer<typeof generatedSchema>,
  definition: TOptionalSchemaFact,
): boolean {
  if ("item" in definition) {
    const item = schema.definitions.v2.ThreadItem.oneOf.find((variant) =>
      variant.properties.type?.enum.includes(definition.item),
    );
    const summary = item?.properties[definition.field];
    return (
      isRecord(summary) &&
      summary.type === "array" &&
      isRecord(summary.items) &&
      summary.items.type === "string"
    );
  }
  const variants = schema.definitions.ServerNotification.oneOf;
  if (
    validateVariants(
      variants,
      "method",
      { [definition.method]: ["method", "params"] },
      "optional notification",
    ) !== undefined ||
    validateVariantReferences(
      variants,
      "method",
      { [definition.method]: `#/definitions/v2/${definition.definition}` },
      "optional notification",
    ) !== undefined
  )
    return false;
  const parsed = optionalShapeSchema.safeParse(
    schema.definitions.v2[definition.definition],
  );
  if (!parsed.success) return false;
  const shape = parsed.data;
  const fields = Object.keys(definition.fields);
  if (
    validateShape(
      shape,
      definition.fact === "usage" ? [...fields, "tokenUsage"] : fields,
      "optional notification",
    ) !== undefined
  )
    return false;
  const checks = Object.entries(definition.fields).map(([field, type]) => {
    const property = shape.properties?.[field];
    return isRecord(property) && property.type === type;
  });
  if (definition.fact === "usage") {
    checks.push(
      validatePropertyReference(
        shape,
        "tokenUsage",
        "#/definitions/v2/ThreadTokenUsage",
        "token usage",
      ) === undefined,
    );
    const usage = optionalShapeSchema.safeParse(
      schema.definitions.v2.ThreadTokenUsage,
    );
    const counters = optionalShapeSchema.safeParse(
      schema.definitions.v2.TokenUsageBreakdown,
    );
    if (!usage.success || !counters.success) return false;
    checks.push(
      validatePropertyReference(
        usage.data,
        "total",
        "#/definitions/v2/TokenUsageBreakdown",
        "total usage",
      ) === undefined,
    );
    checks.push(
      validatePropertyReference(
        usage.data,
        "last",
        "#/definitions/v2/TokenUsageBreakdown",
        "last usage",
      ) === undefined,
    );
    checks.push(
      validateNullableProperty(
        usage.data,
        "modelContextWindow",
        "integer",
        "context window",
      ) === undefined,
    );
    for (const field of [
      "totalTokens",
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ]) {
      const property = counters.data.properties?.[field];
      checks.push(isRecord(property) && property.type === "integer");
    }
  }
  return checks.every(Boolean);
}

export type TSchemaValidation =
  | { readonly ok: true; readonly disabledFacts: ReadonlySet<CodexDisplayFact> }
  | { readonly ok: false; readonly diagnostics: string };

/** Compare the generated stable schema with the structural subset the Adapter
 *  interprets. Additive methods and fields remain compatible. A required fact's
 *  missing variant, discriminator, field, item kind, or terminal status fails
 *  closed before an app-server child is launched; an optional fact's failure
 *  only adds it to `disabledFacts`. Every check runs, so all failures report. */
export function validateRequiredSchema(value: unknown): TSchemaValidation {
  const parsed = generatedSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: `generated schema has no readable stable protocol bundle: ${z.prettifyError(parsed.error)}`,
    };
  }

  const definitions = parsed.data.definitions;
  const checks = [
    validateNullableReference(
      definitions.v2.ThreadStartParams,
      "approvalsReviewer",
      "#/definitions/v2/ApprovalsReviewer",
      "ThreadStartParams",
    ),
    validateNullableReference(
      definitions.v2.ThreadResumeParams,
      "approvalsReviewer",
      "#/definitions/v2/ApprovalsReviewer",
      "ThreadResumeParams",
    ),
    validateNullableReference(
      definitions.v2.TurnStartParams,
      "effort",
      "#/definitions/v2/ReasoningEffort",
      "turn/start",
    ),
    validateNullableReference(
      definitions.v2.Thread,
      "reasoningEffort",
      "#/definitions/v2/ReasoningEffort",
      "thread",
    ),
    validatePropertyReference(
      definitions.InitializeResponse,
      "codexHome",
      "#/definitions/v2/AbsolutePathBuf",
      "initialize",
    ),
    validatePropertyReference(
      definitions.CommandExecutionRequestApprovalParams,
      "kind",
      "#/definitions/CommandExecutionApprovalKind",
      "command approval",
    ),
    validateElicitation(definitions.McpServerElicitationRequestParams),
    validateShape(
      definitions.McpServerElicitationRequestResponse,
      ["action"],
      "elicitation response",
    ),
    validateNullableProperty(
      definitions.v2.ThreadStartParams,
      "config",
      "object",
      "ThreadStartParams",
    ),
    validateNullableProperty(
      definitions.v2.ThreadResumeParams,
      "config",
      "object",
      "ThreadResumeParams",
    ),
    validateNullableProperty(
      definitions.McpServerElicitationRequestParams,
      "turnId",
      "string",
      "elicitation",
    ),
    validateMembers(
      definitions.v2.ApprovalsReviewer.enum,
      ["user"],
      "user reviewer",
    ),
    validateMembers(
      definitions.v2.AppToolApproval.enum,
      ["approve"],
      "MCP pre-approval",
    ),
    validateMembers(
      definitions.McpServerElicitationAction.enum,
      ["accept", "decline"],
      "elicitation action",
    ),
    validateVariants(
      definitions.ClientRequest.oneOf,
      "method",
      CLIENT_REQUESTS,
      "client request",
    ),
    validateVariants(
      definitions.ClientNotification.oneOf,
      "method",
      CLIENT_NOTIFICATIONS,
      "client notification",
    ),
    validateVariants(
      definitions.ServerNotification.oneOf,
      "method",
      SERVER_NOTIFICATIONS,
      "server notification",
    ),
    validateVariants(
      definitions.ServerRequest.oneOf,
      "method",
      SERVER_REQUESTS,
      "server request",
    ),
    validateVariants(
      definitions.v2.ThreadItem.oneOf,
      "type",
      THREAD_ITEMS,
      "thread item",
    ),
    validateVariants(
      definitions.v2.PatchChangeKind.oneOf,
      "type",
      FILE_CHANGE_KINDS,
      "file change kind",
    ),
    validateShape(
      definitions.v2.FileUpdateChange,
      ["path", "kind"],
      "file change",
    ),
    validateNullableStringField(
      definitions.v2.ThreadItem.oneOf,
      "userMessage",
      "clientId",
      "Steer history identity",
    ),
    validateNullableStringField(
      definitions.v2.PatchChangeKind.oneOf,
      "update",
      "move_path",
      "file change kind",
    ),
    validateVariantReferences(
      definitions.ClientRequest.oneOf,
      "method",
      CLIENT_REQUEST_PARAM_REFS,
      "client request",
    ),
    validateVariantReferences(
      definitions.ServerNotification.oneOf,
      "method",
      SERVER_NOTIFICATION_PARAM_REFS,
      "server notification",
    ),
    validateVariantReferences(
      definitions.ServerRequest.oneOf,
      "method",
      SERVER_REQUEST_PARAM_REFS,
      "server request",
    ),
    validateVariantFieldReferencesByDiscriminator(
      definitions.ServerRequest.oneOf,
      "method",
      "id",
      SERVER_REQUEST_ID_REFS,
      "server request",
    ),
    validateVariantFieldTypes(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_FIELD_TYPES,
    ),
    validateVariantFieldReferences(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_FIELD_REFS,
    ),
    validateVariantArrayItemReferences(
      definitions.v2.ThreadItem.oneOf,
      THREAD_ITEM_ARRAY_ITEM_REFS,
    ),
    validateMembers(
      definitions.v2.TurnStatus.enum,
      TURN_STATUSES,
      "terminal Turn status",
    ),
    validateMembers(
      definitions.v2.CommandExecutionStatus.enum,
      ["inProgress", "completed", "failed", "declined"],
      "command status",
    ),
    validateMembers(
      definitions.v2.PatchApplyStatus.enum,
      ["inProgress", "completed", "failed", "declined"],
      "file-change status",
    ),
    validateMembers(
      definitions.v2.McpToolCallStatus.enum,
      ["inProgress", "completed", "failed"],
      "MCP tool status",
    ),
    validateShape(
      definitions.InitializeParams,
      ["clientInfo"],
      "initialize params",
    ),
    validateShape(
      definitions.InitializeResponse,
      ["codexHome", "platformFamily", "platformOs", "userAgent"],
      "initialize response",
    ),
    validateShape(definitions.v2.ThreadStartParams, [], "thread/start params"),
    validateShape(
      definitions.v2.ThreadStartResponse,
      ["approvalPolicy", "cwd", "modelProvider", "sandbox", "thread"],
      "thread/start response",
    ),
    validateShape(
      definitions.v2.ThreadResumeParams,
      ["threadId"],
      "thread/resume params",
    ),
    validateShape(
      definitions.v2.ThreadResumeResponse,
      ["approvalPolicy", "cwd", "modelProvider", "sandbox", "thread"],
      "thread/resume response",
    ),
    validateShape(
      definitions.v2.ThreadReadParams,
      ["threadId"],
      "thread/read params",
    ),
    validateShape(
      definitions.v2.ThreadReadResponse,
      ["thread"],
      "thread/read response",
    ),
    validateShape(
      definitions.v2.TurnStartParams,
      ["input", "threadId"],
      "turn/start params",
    ),
    validateNullableProperty(
      definitions.v2.TurnStartParams,
      "model",
      "string",
      "turn/start params",
    ),
    validateShape(
      definitions.v2.TurnStartResponse,
      ["turn"],
      "turn/start response",
    ),
    validateShape(
      definitions.v2.TurnSteerParams,
      ["expectedTurnId", "input", "threadId"],
      "turn/steer params",
    ),
    validateShape(
      definitions.v2.TurnSteerResponse,
      ["turnId"],
      "turn/steer response",
    ),
    validateShape(
      definitions.v2.TurnInterruptParams,
      ["threadId", "turnId"],
      "turn/interrupt params",
    ),
    validateShape(
      definitions.v2.TurnInterruptResponse,
      [],
      "turn/interrupt response",
    ),
    validateShape(definitions.v2.ModelListParams, [], "model/list params"),
    validateShape(
      definitions.v2.ModelListResponse,
      ["data"],
      "model/list response",
    ),
    validateShape(definitions.v2.GetAccountParams, [], "account/read params"),
    validateShape(
      definitions.v2.GetAccountResponse,
      ["requiresOpenaiAuth"],
      "account/read response",
    ),
    validateShape(definitions.v2.Thread, ["id", "status"], "thread"),
    validateNullableProperty(
      definitions.v2.Thread,
      "model",
      "string",
      "thread",
    ),
    validateShape(
      definitions.v2.ModelReroutedNotification,
      ["threadId", "toModel", "turnId"],
      "model reroute notification",
    ),
    validateShape(definitions.v2.Turn, ["id", "items", "status"], "Turn"),
    validateShape(
      definitions.v2.ErrorNotification,
      ["error", "threadId", "turnId", "willRetry"],
      "error notification",
    ),
    validateShape(
      definitions.v2.TurnStartedNotification,
      ["threadId", "turn"],
      "turn/started notification",
    ),
    validateShape(
      definitions.v2.TurnCompletedNotification,
      ["threadId", "turn"],
      "turn/completed notification",
    ),
    validateShape(
      definitions.v2.ItemStartedNotification,
      ["item", "threadId", "turnId"],
      "item/started notification",
    ),
    validateShape(
      definitions.v2.ItemCompletedNotification,
      ["item", "threadId", "turnId"],
      "item/completed notification",
    ),
    validateShape(
      definitions.v2.ServerRequestResolvedNotification,
      ["requestId", "threadId"],
      "request resolution",
    ),
    validateShape(
      definitions.CommandExecutionRequestApprovalParams,
      ["itemId", "threadId", "turnId"],
      "command approval params",
    ),
    validateNullableProperty(
      definitions.CommandExecutionRequestApprovalParams,
      "command",
      "string",
      "command approval params",
    ),
    validateMembers(
      definitions.CommandExecutionApprovalKind.enum,
      ["command"],
      "command approval kind",
    ),
    validatePrimitiveUnion(
      definitions.v2.RequestId,
      ["string", "integer"],
      "request id",
    ),
    validateShape(
      definitions.CommandExecutionRequestApprovalResponse,
      ["decision"],
      "command approval response",
    ),
    validateLiteralUnion(
      definitions.CommandExecutionApprovalDecision,
      ["accept", "decline"],
      "command approval decision",
    ),
    validateShape(
      definitions.FileChangeRequestApprovalParams,
      ["itemId", "threadId", "turnId"],
      "file approval params",
    ),
    validateShape(
      definitions.FileChangeRequestApprovalResponse,
      ["decision"],
      "file approval response",
    ),
    validateLiteralUnion(
      definitions.FileChangeApprovalDecision,
      ["accept", "decline"],
      "file approval decision",
    ),
  ];
  for (const schemaFact of REQUIRED_SCHEMA_FACTS) {
    checks.push(validateSchemaFact(parsed.data, schemaFact));
  }
  const incompatible = checks.filter((check) => check !== undefined);
  const disabledFacts = new Set<CodexDisplayFact>();
  for (const definition of OPTIONAL_SCHEMA_FACTS) {
    if (!optionalFactCompatible(parsed.data, definition))
      disabledFacts.add(definition.fact);
  }
  if (incompatible.length > 0) {
    return { ok: false, diagnostics: incompatible.join("; ") };
  }
  return { ok: true, disabledFacts };
}

type TVariant = z.infer<typeof variantSchema>;

function validateVariants(
  variants: readonly TVariant[],
  discriminator: "method" | "type" | "mode",
  requiredVariants: TRequiredVariants,
  label: string,
): string | undefined {
  const failures: string[] = [];
  for (const [name, requiredFields] of Object.entries(requiredVariants)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) {
      failures.push(`missing required ${label} '${name}'`);
      continue;
    }
    const required = variant.required ?? [];
    for (const field of requiredFields) {
      if (!required.includes(field))
        failures.push(`${label} '${name}' no longer requires '${field}'`);
      if (!isRecord(variant.properties[field]))
        failures.push(`${label} '${name}' has no schema for '${field}'`);
    }
  }
  return failures.join("; ") || undefined;
}

function validateNullableStringField(
  variants: readonly TVariant[],
  variantName: string,
  field: string,
  label: string,
): string | undefined {
  const variant = variants.find((candidate) =>
    candidate.properties.type?.enum.includes(variantName),
  );
  const property = variant?.properties[field];
  if (!isRecord(property)) return `${label} '${variantName}' has no '${field}'`;
  const types = property.type;
  if (
    !Array.isArray(types) ||
    !types.includes("string") ||
    !types.includes("null")
  ) {
    return `${label} '${variantName}.${field}' is no longer nullable string`;
  }
  return undefined;
}

function validateVariantReferences(
  variants: readonly TVariant[],
  discriminator: "method" | "type",
  expectedRefs: Readonly<Record<string, string>>,
  label: string,
): string | undefined {
  const failures: string[] = [];
  for (const [name, expectedRef] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) continue;
    const params = variant.properties.params;
    if (!isRecord(params) || params.$ref !== expectedRef) {
      failures.push(
        `${label} '${name}' params no longer reference '${expectedRef}'`,
      );
    }
  }
  return failures.join("; ") || undefined;
}

function validateVariantFieldReferencesByDiscriminator(
  variants: readonly TVariant[],
  discriminator: "method" | "type",
  field: string,
  expectedRefs: Readonly<Record<string, string>>,
  label: string,
): string | undefined {
  const failures: string[] = [];
  for (const [name, expectedRef] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties[discriminator]?.enum.includes(name),
    );
    if (variant === undefined) continue;
    if (!schemaHasReference(variant.properties[field], expectedRef)) {
      failures.push(
        `${label} '${name}.${field}' no longer references '${expectedRef}'`,
      );
    }
  }
  return failures.join("; ") || undefined;
}

function validatePrimitiveUnion(
  union: z.infer<typeof primitiveUnionSchema>,
  required: readonly string[],
  label: string,
): string | undefined {
  const actual = union.anyOf.flatMap((variant) =>
    variant.type === undefined ? [] : [variant.type],
  );
  const missing = required.find((type) => !actual.includes(type));
  return missing === undefined ? undefined : `${label} is missing '${missing}'`;
}

function validateVariantFieldTypes(
  variants: readonly TVariant[],
  expectedTypes: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  const failures: string[] = [];
  for (const [name, fields] of Object.entries(expectedTypes)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedType] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (!isRecord(property) || property.type !== expectedType) {
        failures.push(
          `thread item '${name}.${field}' is no longer type '${expectedType}'`,
        );
      }
    }
  }
  return failures.join("; ") || undefined;
}

function validateVariantFieldReferences(
  variants: readonly TVariant[],
  expectedRefs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  const failures: string[] = [];
  for (const [name, fields] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedRef] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (!schemaHasReference(property, expectedRef)) {
        failures.push(
          `thread item '${name}.${field}' no longer references '${expectedRef}'`,
        );
      }
    }
  }
  return failures.join("; ") || undefined;
}

function validateVariantArrayItemReferences(
  variants: readonly TVariant[],
  expectedRefs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  const failures: string[] = [];
  for (const [name, fields] of Object.entries(expectedRefs)) {
    const variant = variants.find((candidate) =>
      candidate.properties.type?.enum.includes(name),
    );
    if (variant === undefined) continue;
    for (const [field, expectedRef] of Object.entries(fields)) {
      const property = variant.properties[field];
      if (
        !isRecord(property) ||
        !schemaHasReference(property.items, expectedRef)
      ) {
        failures.push(
          `thread item '${name}.${field}' items no longer reference '${expectedRef}'`,
        );
      }
    }
  }
  return failures.join("; ") || undefined;
}

function validateNullableProperty(
  shape: z.infer<typeof shapeSchema>,
  field: string,
  expectedType: string,
  label: string,
): string | undefined {
  const property = shape.properties?.[field];
  if (!isRecord(property)) return `${label} has no schema for '${field}'`;
  const types = property.type;
  if (
    !Array.isArray(types) ||
    !types.includes(expectedType) ||
    !types.includes("null")
  ) {
    return `${label} '${field}' is no longer nullable ${expectedType}`;
  }
  return undefined;
}

function validateNullableReference(
  shape: TShape,
  field: string,
  expectedRef: string,
  label: string,
): string | undefined {
  const property = shape.properties?.[field];
  const alternatives = isRecord(property) ? property.anyOf : undefined;
  if (
    !Array.isArray(alternatives) ||
    !alternatives.some(
      (candidate) => isRecord(candidate) && candidate.$ref === expectedRef,
    ) ||
    !alternatives.some(
      (candidate) => isRecord(candidate) && candidate.type === "null",
    )
  ) {
    return `${label} ${field} no longer references nullable '${expectedRef}'`;
  }
  return undefined;
}

function validatePropertyReference(
  shape: TShape,
  field: string,
  expectedRef: string,
  label: string,
): string | undefined {
  return schemaHasReference(shape.properties?.[field], expectedRef)
    ? undefined
    : `${label} '${field}' no longer references '${expectedRef}'`;
}

function schemaHasReference(value: unknown, expectedRef: string): boolean {
  if (!isRecord(value)) return false;
  if ("$ref" in value) return value.$ref === expectedRef;
  return (
    Array.isArray(value.allOf) &&
    value.allOf.some(
      (candidate) => isRecord(candidate) && candidate.$ref === expectedRef,
    )
  );
}

function validateElicitation(
  shape: z.infer<
    typeof generatedSchema
  >["definitions"]["McpServerElicitationRequestParams"],
): string | undefined {
  const contract =
    validateShape(shape, ["serverName", "threadId"], "elicitation params") ??
    validateVariants(
      shape.oneOf,
      "mode",
      {
        form: ["message", "mode"],
        url: ["message", "mode", "url"],
      },
      "elicitation",
    );
  if (contract !== undefined) return contract;
  for (const mode of ["form", "url"]) {
    const variant = shape.oneOf.find((candidate) =>
      candidate.properties.mode?.enum.includes(mode),
    );
    // validateVariants established both consumed modes and their required fields.
    if (variant === undefined) return `missing required elicitation '${mode}'`;
    if (variant.type !== "object")
      return `elicitation '${mode}' is no longer an object`;
    for (const field of mode === "url"
      ? ["message", "mode", "url"]
      : ["message", "mode"]) {
      const property = variant.properties[field];
      if (!isRecord(property) || property.type !== "string") {
        return `elicitation '${mode}.${field}' is no longer type 'string'`;
      }
    }
    if (mode === "form" && variant.properties._meta !== true) {
      return "elicitation form metadata changed from 'true'";
    }
  }
  return undefined;
}

function validateMembers(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): string | undefined {
  return (
    required
      .filter((member) => !actual.includes(member))
      .map((member) => `missing required ${label} '${member}'`)
      .join("; ") || undefined
  );
}

type TShape = z.infer<typeof shapeSchema>;

function validateShape(
  shape: TShape,
  requiredFields: readonly string[],
  label: string,
): string | undefined {
  const required = shape.required ?? [];
  const failures: string[] = [];
  for (const field of requiredFields) {
    if (!required.includes(field))
      failures.push(`${label} no longer requires '${field}'`);
    if (!isRecord(shape.properties?.[field]))
      failures.push(`${label} has no schema for '${field}'`);
  }
  return failures.join("; ") || undefined;
}

type TLiteralUnion = z.infer<typeof literalUnionSchema>;

function validateLiteralUnion(
  union: TLiteralUnion,
  requiredValues: readonly string[],
  label: string,
): string | undefined {
  const values = union.oneOf.flatMap((variant) => variant.enum ?? []);
  return validateMembers(values, requiredValues, label);
}

function fact(
  label: string,
  expected: string | boolean,
  ...path: readonly string[]
): TSchemaFact {
  return { path, expected, label };
}

function validateSchemaFact(
  schema: unknown,
  schemaFact: TSchemaFact,
): string | undefined {
  let current = schema;
  for (const segment of schemaFact.path) {
    if (!isRecord(current) || !(segment in current)) {
      return `${schemaFact.label} schema path is missing`;
    }
    current = current[segment];
  }
  if (current !== schemaFact.expected) {
    return `${schemaFact.label} changed from '${schemaFact.expected}'`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
