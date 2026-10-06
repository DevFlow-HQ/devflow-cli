import { realpathSync } from "node:fs";
import { z } from "zod";
import type { OwnedProcess } from "../../process/process.js";
import type {
  ContextObservation,
  UsageObservation,
  TurnEvent,
} from "../harness.js";
import { JsonlLineReader } from "../jsonl.js";

const rpcIdSchema = z.union([z.string(), z.number()]);
const rpcEnvelopeSchema = z.looseObject({
  id: rpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

export type CodexRpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export interface CodexProtocolObserver {
  stdin(bytes: Uint8Array): void;
  stdout(bytes: Uint8Array): void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly onAccepted?: (result: unknown) => void;
}

interface TCodexRequest {
  readonly method: string;
  readonly params: object;
  readonly onAccepted?: (result: unknown) => void;
}

export interface CodexRuntimeHandlers {
  message(message: CodexRpcEnvelope): void;
  ended(cause?: unknown): void;
}

export class CodexProtocolError extends Error {}

export class CodexRpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`${method} returned RPC error ${code}: ${rpcMessage}`);
  }
}

export class CodexExchangeTimeoutError extends Error {}

/** Owns one app-server stdout iterator, decoder remainder, and client request-id
 * sequence across qualification and runtime. Runtime starts exactly once after
 * the bounded qualification exchange has finished. */
export class CodexJsonlConnection {
  private readonly reader: JsonlLineReader;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private runtimeStarted = false;

  constructor(
    private readonly process: OwnedProcess,
    private readonly observer: CodexProtocolObserver | undefined,
  ) {
    this.reader = new JsonlLineReader(process.stdout);
  }

  async qualificationRequest(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    await this.write({ id, method, params });
    for (;;) {
      const message = await this.readMessage();
      if (message.id === undefined) continue;
      if (message.method !== undefined) {
        throw new Error(
          `unexpected server request '${message.method}' during qualification`,
        );
      }
      if (message.id !== id) {
        throw new Error(`unexpected response id '${String(message.id)}'`);
      }
      return responseResult(method, message);
    }
  }

  qualificationNotify(method: string): Promise<void> {
    return this.write({ method });
  }

  startRuntime(handlers: CodexRuntimeHandlers): void {
    if (this.runtimeStarted) {
      throw new Error("Codex runtime reader already started");
    }
    this.runtimeStarted = true;
    void this.consume(handlers);
  }

  request(method: string, params: object): Promise<unknown> {
    return this.sendRequest({ method, params });
  }

  requestControl(options: TCodexRequest): Promise<unknown> {
    return this.sendRequest(options);
  }

  private sendRequest(options: TCodexRequest): Promise<unknown> {
    if (!this.runtimeStarted) {
      return Promise.reject(new Error("Codex runtime reader is not started"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method: options.method,
        resolve,
        reject,
        onAccepted: options.onAccepted,
      });
      void this.write({
        id,
        method: options.method,
        params: options.params,
      }).catch((cause) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.reject(cause);
      });
    });
  }

  respondToServerRequest(id: string | number, result: object): Promise<void> {
    if (!this.runtimeStarted) {
      return Promise.reject(new Error("Codex runtime reader is not started"));
    }
    return this.write({ id, result });
  }

  private async consume(handlers: CodexRuntimeHandlers): Promise<void> {
    try {
      for (;;) {
        const message = await this.readMessage();
        if (message.id !== undefined && message.method === undefined) {
          this.acceptResponse(message);
          continue;
        }
        handlers.message(message);
      }
    } catch (cause) {
      for (const pending of this.pending.values()) pending.reject(cause);
      this.pending.clear();
      handlers.ended(cause);
    }
  }

  private acceptResponse(message: CodexRpcEnvelope): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    try {
      const result = responseResult(pending.method, message);
      pending.onAccepted?.(result);
      pending.resolve(result);
    } catch (cause) {
      pending.reject(cause);
    }
  }

  private write(message: object): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    this.observer?.stdin(bytes);
    return this.process.writeStdin(bytes);
  }

  private async readMessage(): Promise<CodexRpcEnvelope> {
    const line = await this.nextLine();
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (cause) {
      throw new CodexProtocolError("Codex emitted malformed JSON", { cause });
    }
    const parsed = rpcEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new CodexProtocolError(
        `Codex emitted an incompatible RPC envelope: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async nextLine(): Promise<string> {
    for (;;) {
      const next = await this.reader.next();
      if (next.kind === "line") {
        if (next.value.trim().length > 0) {
          this.observer?.stdout(new TextEncoder().encode(next.raw));
          return next.value;
        }
        continue;
      }
      if (next.kind === "truncated" && next.value.trim().length > 0) {
        throw new CodexProtocolError("Codex emitted a truncated JSON frame");
      }
      throw new Error("Codex app-server stdout closed");
    }
  }
}

function responseResult(method: string, message: CodexRpcEnvelope): unknown {
  if (message.error !== undefined) {
    throw new CodexRpcResponseError(
      method,
      message.error.code,
      message.error.message,
    );
  }
  if (!("result" in message)) {
    throw new Error(`${method} response has neither result nor error`);
  }
  return message.result;
}

const threadResultSchema = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
  sandbox: z
    .looseObject({
      type: z.string(),
      writableRoots: z.array(z.string()).optional(),
    })
    .optional()
    .catch(undefined),
});

/** Whether the thread's acknowledged native sandbox admits writes to `directory`
 *  (#214). Only positive evidence refuses: a `workspaceWrite` sandbox whose
 *  writable roots omit it, i.e. the override was not applied. Every other posture
 *  stays the user's: `readOnly` routes writes through their approval policy (the
 *  recorded default is read-only with on-request approvals), and full access or an
 *  external sandbox needs no root. Roots compare canonically, since Codex may
 *  report a resolved path. */
export function sandboxAdmitsDirectory(
  value: unknown,
  directory: string,
): boolean {
  const sandbox = threadResultSchema.safeParse(value).data?.sandbox;
  if (sandbox?.type !== "workspaceWrite") return true;
  const wanted = canonicalPath(directory);
  return (sandbox.writableRoots ?? []).some(
    (root) => canonicalPath(root) === wanted,
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

const turnStartResultSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});
const turnSteerResultSchema = z.looseObject({
  turnId: z.string().min(1),
});
const turnInterruptResultSchema = z.looseObject({});

export function parseThreadStartResult(value: unknown): string {
  return parseResult(value, threadResultSchema, "thread/start").thread.id;
}

export function parseThreadResumeResult(value: unknown): string {
  return parseResult(value, threadResultSchema, "thread/resume").thread.id;
}

// The thread's configured model and effort (#345): null or absent is a value
// Codex did not report; any other non-string is incompatible data.
const threadReadResultSchema = z.looseObject({
  thread: z.looseObject({
    id: z.string().min(1),
    model: z.string().min(1).nullish(),
    reasoningEffort: z.string().min(1).nullish(),
  }),
});

/** The model and effort `thread/read` reports for `threadId`, each absent when
 *  Codex reports none. A reply for another thread is incompatible data. */
export function parseThreadReadResult(
  value: unknown,
  threadId: string,
): { readonly model?: string; readonly effort?: string } {
  const { thread } = parseResult(value, threadReadResultSchema, "thread/read");
  if (thread.id !== threadId) {
    throw new CodexProtocolError(
      "thread/read reported a different Codex thread",
    );
  }
  return {
    ...(thread.model != null ? { model: thread.model } : {}),
    ...(thread.reasoningEffort != null
      ? { effort: thread.reasoningEffort }
      : {}),
  };
}

export function parseTurnStartResult(value: unknown): string {
  return parseResult(value, turnStartResultSchema, "turn/start").turn.id;
}

export function parseTurnSteerResult(value: unknown): string {
  return parseResult(value, turnSteerResultSchema, "turn/steer").turnId;
}

export function parseTurnInterruptResult(value: unknown): void {
  parseResult(value, turnInterruptResultSchema, "turn/interrupt");
}

const correlatedParamsSchema = z.looseObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
const turnSchema = z
  .looseObject({
    id: z.string().min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: z
      .looseObject({ message: z.string().min(1) })
      .nullable()
      .optional(),
  })
  .superRefine((turn, context) => {
    if (turn.status === "failed" && turn.error == null) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "a failed Turn must carry its terminal error",
      });
    }
  });
const turnStartedSchema = z.looseObject({
  threadId: z.string().min(1),
  turn: turnSchema,
});
const turnCompletedSchema = turnStartedSchema;
const agentDeltaSchema = correlatedParamsSchema.extend({
  itemId: z.string().optional(),
  delta: z.string(),
});
const itemLifecycleSchema = correlatedParamsSchema.extend({
  item: z.unknown(),
});
const commandItemSchema = z.looseObject({
  command: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
});
const fileChangeItemSchema = z.looseObject({
  changes: z.array(
    z.looseObject({
      path: z.string().min(1),
      kind: z.looseObject({
        type: z.enum(["add", "delete", "update"]),
        move_path: z.string().nullable().optional(),
      }),
    }),
  ),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
});
const mcpItemSchema = z.looseObject({
  server: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed"]),
});
const collabItemSchema = z.looseObject({
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});
const dynamicToolItemSchema = z.looseObject({
  tool: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed"]),
});
const webSearchItemSchema = z.looseObject({ query: z.string() });
const imageViewItemSchema = z.looseObject({ path: z.string() });
const imageGenerationItemSchema = z.looseObject({ status: z.string() });
const errorNotificationSchema = correlatedParamsSchema.extend({
  error: z.looseObject({ message: z.string().min(1) }),
  willRetry: z.boolean(),
});
const commandApprovalSchema = correlatedParamsSchema.extend({
  itemId: z.string().min(1),
  command: z.string().min(1),
  kind: z.literal("command").optional(),
});
const fileApprovalSchema = correlatedParamsSchema.extend({
  itemId: z.string().min(1),
});
const elicitationSchema = z.looseObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullish(),
  serverName: z.string().min(1),
  message: z.string(),
  mode: z.string(),
  url: z.string().optional(),
  _meta: z.unknown().optional(),
});
const toolApprovalMetadata = z.looseObject({
  codex_approval_kind: z.literal("mcp_tool_call"),
});
const toolApprovalInput = toolApprovalMetadata.extend({
  tool_params: z.record(z.string(), z.unknown()),
});
const userInputSchema = correlatedParamsSchema.extend({
  itemId: z.string().min(1),
  questions: z.array(z.unknown()),
});

const modelReroutedSchema = correlatedParamsSchema.extend({
  toModel: z.string().min(1),
});
const requestResolvedSchema = z.looseObject({
  requestId: rpcIdSchema,
  threadId: z.string().min(1),
});

// Authentic codex-cli 0.160.0 / codex-probe-3 test-repair traffic qualifies
// these meanings. Total/last usage is never context occupancy. Optional facts
// degrade independently; malformed accounting cannot fail a Turn.
const reportedNumber = z.number().optional().catch(undefined);
const usageCountersSchema = z.looseObject({
  totalTokens: reportedNumber,
  inputTokens: reportedNumber,
  cachedInputTokens: reportedNumber,
  cacheWriteInputTokens: reportedNumber,
  outputTokens: reportedNumber,
  reasoningOutputTokens: reportedNumber,
});
const tokenUsageSchema = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z
    .looseObject({
      total: usageCountersSchema.optional().catch(undefined),
      last: usageCountersSchema.optional().catch(undefined),
      modelContextWindow: reportedNumber,
    })
    .optional()
    .catch(undefined),
});

function usageSummary(
  counters: z.infer<typeof usageCountersSchema> | undefined,
): string {
  if (counters === undefined) return "";
  return [
    ["total", counters.totalTokens],
    ["input", counters.inputTokens],
    ["cache read", counters.cachedInputTokens],
    ["cache write", counters.cacheWriteInputTokens],
    ["output", counters.outputTokens],
    ["reasoning output", counters.reasoningOutputTokens],
  ]
    .flatMap(([meaning, value]) =>
      value === undefined ? [] : [`${meaning} ${value} tokens`],
    )
    .join(", ");
}

export type CodexRuntimeNotification =
  | {
      readonly kind: "turn-started";
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "turn-completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: "completed" | "interrupted" | "failed" | "inProgress";
      readonly error?: string;
    }
  | {
      readonly kind: "preview";
      readonly messageId?: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "item-event";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly userMessageClientId?: string;
      /** The model produced this item, so it saw every input taken before it. */
      readonly modelOutput: boolean;
      readonly event?: TurnEvent;
      readonly approvalInput?: string;
    }
  | {
      readonly kind: "error";
      readonly threadId: string;
      readonly turnId: string;
      readonly message: string;
      readonly willRetry: boolean;
    }
  | {
      readonly kind: "observations";
      readonly threadId: string;
      readonly turnId: string;
      readonly context: ContextObservation;
      readonly usage: UsageObservation;
    }
  | {
      readonly kind: "elicitation";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
      readonly turnId?: string;
      readonly server: string;
      readonly message: string;
      readonly url?: string;
      readonly approvalInput?: string;
    }
  | {
      readonly kind: "user-input";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "approval-request";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
      readonly turnId: string;
      readonly tool: string;
      readonly responseKind?: "elicitation";
      readonly itemId: string;
      readonly input?: string;
    }
  | {
      readonly kind: "server-request-resolved";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
    }
  | {
      readonly kind: "unsupported-server-request";
      readonly method: string;
    }
  | {
      readonly kind: "model-rerouted";
      readonly threadId: string;
      readonly turnId: string;
      readonly toModel: string;
    };

export function parseRuntimeNotification(
  message: CodexRpcEnvelope,
): CodexRuntimeNotification | undefined {
  const method = message.method;
  if (method === undefined) return undefined;
  if (message.id !== undefined) {
    if (method === "mcpServer/elicitation/request") {
      const params = parseResult(message.params, elicitationSchema, method);
      const approval = toolApprovalMetadata.safeParse(params._meta).success
        ? parseResult(params._meta, toolApprovalInput, method)
        : undefined;
      return {
        kind: "elicitation",
        nativeRequestId: message.id,
        threadId: params.threadId,
        ...(params.turnId == null ? {} : { turnId: params.turnId }),
        server: params.serverName,
        message: params.message,
        ...(params.url === undefined ? {} : { url: params.url }),
        ...(approval === undefined
          ? {}
          : {
              approvalInput: `${params.message}\n${JSON.stringify(approval.tool_params)}`,
            }),
      };
    }
    if (method === "item/tool/requestUserInput") {
      const params = parseResult(message.params, userInputSchema, method);
      return {
        kind: "user-input",
        nativeRequestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
      };
    }
    if (method === "item/commandExecution/requestApproval") {
      const params = parseResult(message.params, commandApprovalSchema, method);
      return {
        kind: "approval-request",
        nativeRequestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        tool: "command",
        itemId: params.itemId,
        input: params.command,
      };
    }
    if (method === "item/fileChange/requestApproval") {
      const params = parseResult(message.params, fileApprovalSchema, method);
      return {
        kind: "approval-request",
        nativeRequestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        tool: "file-change",
        itemId: params.itemId,
      };
    }
    return { kind: "unsupported-server-request", method };
  }
  switch (method) {
    case "thread/tokenUsage/updated": {
      const parsed = tokenUsageSchema.safeParse(message.params);
      if (!parsed.success) return undefined;
      const { threadId, turnId, tokenUsage } = parsed.data;
      const limitTokens = tokenUsage?.modelContextWindow;
      const total = usageSummary(tokenUsage?.total);
      const last = usageSummary(tokenUsage?.last);
      return {
        kind: "observations",
        threadId,
        turnId,
        context: limitTokens === undefined ? {} : { limitTokens },
        usage: {
          summary: [
            total === "" ? "" : `total: ${total}`,
            last === "" ? "" : `last: ${last}`,
          ]
            .filter(Boolean)
            .join("; "),
        },
      };
    }
    case "turn/started": {
      const params = parseResult(message.params, turnStartedSchema, method);
      return {
        kind: "turn-started",
        threadId: params.threadId,
        turnId: params.turn.id,
      };
    }
    case "turn/completed": {
      const params = parseResult(message.params, turnCompletedSchema, method);
      return {
        kind: "turn-completed",
        threadId: params.threadId,
        turnId: params.turn.id,
        status: params.turn.status,
        ...(params.turn.error?.message !== undefined
          ? { error: params.turn.error.message }
          : {}),
      };
    }
    case "item/agentMessage/delta": {
      const params = parseResult(message.params, agentDeltaSchema, method);
      return {
        kind: "preview",
        ...(params.itemId === undefined ? {} : { messageId: params.itemId }),
        threadId: params.threadId,
        turnId: params.turnId,
        delta: params.delta,
      };
    }
    case "item/started":
    case "item/completed": {
      const params = parseResult(message.params, itemLifecycleSchema, method);
      return {
        kind: "item-event",
        threadId: params.threadId,
        turnId: params.turnId,
        ...normalizeItem(params.item, method === "item/started"),
      };
    }
    case "error": {
      const params = parseResult(
        message.params,
        errorNotificationSchema,
        method,
      );
      return {
        kind: "error",
        threadId: params.threadId,
        turnId: params.turnId,
        message: params.error.message,
        willRetry: params.willRetry,
      };
    }
    case "model/rerouted": {
      const params = parseResult(message.params, modelReroutedSchema, method);
      return {
        kind: "model-rerouted",
        threadId: params.threadId,
        turnId: params.turnId,
        toModel: params.toModel,
      };
    }
    case "serverRequest/resolved": {
      const params = parseResult(message.params, requestResolvedSchema, method);
      return {
        kind: "server-request-resolved",
        nativeRequestId: params.requestId,
        threadId: params.threadId,
      };
    }
    default:
      return undefined;
  }
}

/** Item types a model request produces. A hook prompt, compaction, review marker,
 *  or tool output is not evidence that the model saw the input before it. */
const MODEL_OUTPUT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

function normalizeItem(
  value: unknown,
  started: boolean,
): {
  readonly itemId: string;
  readonly userMessageClientId?: string;
  readonly modelOutput: boolean;
  readonly event?: TurnEvent;
  readonly approvalInput?: string;
} {
  const item = parseResult(
    value,
    z.looseObject({ id: z.string().min(1), type: z.string().min(1) }),
    "item lifecycle",
  );
  return {
    ...normalizeItemContent(item, started),
    modelOutput: MODEL_OUTPUT_ITEM_TYPES.has(item.type),
  };
}

function normalizeItemContent(
  item: { readonly id: string; readonly type: string },
  started: boolean,
): {
  readonly itemId: string;
  readonly userMessageClientId?: string;
  readonly event?: TurnEvent;
  readonly approvalInput?: string;
} {
  const type = item.type;
  if (type === "reasoning") return { itemId: item.id };
  if (type === "userMessage") {
    const message = parseResult(
      item,
      z.looseObject({
        content: z.array(z.unknown()),
        clientId: z.string().nullish(),
      }),
      "userMessage item",
    );
    return {
      itemId: item.id,
      ...(message.clientId != null
        ? { userMessageClientId: message.clientId }
        : {}),
    };
  }
  if (type === "agentMessage") {
    const message = parseResult(
      item,
      z.looseObject({ text: z.string() }),
      "agentMessage item",
    );
    return {
      itemId: item.id,
      ...(!started
        ? {
            event: {
              kind: "assistant-content",
              messageId: item.id,
              content: message.text,
            } as const,
          }
        : {}),
    };
  }
  const phase = started ? "started" : "completed";
  switch (type) {
    case "commandExecution": {
      const command = parseResult(
        item,
        commandItemSchema,
        "commandExecution item",
      );
      return {
        itemId: item.id,
        event: toolActivity("command", phase, command.command),
      };
    }
    case "fileChange": {
      const fileChange = parseResult(
        item,
        fileChangeItemSchema,
        "fileChange item",
      );
      return {
        itemId: item.id,
        event: toolActivity(
          "file-change",
          phase,
          changeSummary(fileChange.changes.length),
        ),
        approvalInput: fileChangeApprovalInput(fileChange.changes),
      };
    }
    case "mcpToolCall": {
      const call = parseResult(item, mcpItemSchema, "mcpToolCall item");
      return {
        itemId: item.id,
        event: toolActivity(
          `mcp:${call.server}/${call.tool}`,
          phase,
          call.status,
        ),
      };
    }
    case "collabAgentToolCall": {
      const call = parseResult(
        item,
        collabItemSchema,
        "collabAgentToolCall item",
      );
      return {
        itemId: item.id,
        event: toolActivity("subagent", phase, call.status),
      };
    }
    case "dynamicToolCall": {
      const call = parseResult(
        item,
        dynamicToolItemSchema,
        "dynamicToolCall item",
      );
      return {
        itemId: item.id,
        event: toolActivity("other", phase, `${call.tool} · ${call.status}`),
      };
    }
    case "webSearch": {
      const search = parseResult(item, webSearchItemSchema, "webSearch item");
      return {
        itemId: item.id,
        event: toolActivity("web-search", phase, search.query),
      };
    }
    case "imageView": {
      const image = parseResult(item, imageViewItemSchema, "imageView item");
      return {
        itemId: item.id,
        event: toolActivity("image-view", phase, image.path),
      };
    }
    case "imageGeneration": {
      const image = parseResult(
        item,
        imageGenerationItemSchema,
        "imageGeneration item",
      );
      return {
        itemId: item.id,
        event: toolActivity("image-generation", phase, image.status),
      };
    }
    default:
      return { itemId: item.id };
  }
}

function fileChangeApprovalInput(
  changes: z.infer<typeof fileChangeItemSchema>["changes"],
): string {
  return changes
    .map((change) => {
      if (change.kind.type !== "update" || change.kind.move_path == null) {
        return `${change.kind.type} ${change.path}`;
      }
      return `move ${change.path} to ${change.kind.move_path}`;
    })
    .join("; ");
}

function toolActivity(
  tool: string,
  phase: "started" | "completed",
  summary: string | undefined,
): TurnEvent {
  return {
    kind: "tool-activity",
    activity: { tool, phase, summary: summary ?? `${tool} ${phase}` },
  };
}

function changeSummary(changes: number): string {
  return `${changes} file change${changes === 1 ? "" : "s"}`;
}

function parseResult<T>(
  value: unknown,
  schema: z.ZodType<T>,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${method} returned incompatible data: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function boundedCodexExchange<T>(options: {
  readonly operation: () => Promise<T>;
  readonly timeoutMs: number;
  readonly label: string;
}): Promise<T> {
  // Unlike settleWithin (undefined observation) and AbortSignal.timeout (active abort), boundedCodexExchange rejects a stalled protocol exchange with a typed timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexExchangeTimeoutError(`${options.label} timed out`));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([options.operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Codex 0.160.0 turn_metadata.rs retains immediate parent identity but strips
// parent/root Turn ids from external MCP metadata. Helpers keep their own ids.
const nativeTurnMetadataSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z.object({
    thread_id: z.string().min(1),
    turn_id: z.string().min(1),
    parent_thread_id: z.string().min(1).optional(),
  }),
);
const agentCallMetadataSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    "x-codex-turn-metadata": nativeTurnMetadataSchema.optional(),
  })
  .transform((value) => ({
    threadId: value.threadId ?? value["x-codex-turn-metadata"]?.thread_id,
    turnId: value.turnId ?? value["x-codex-turn-metadata"]?.turn_id,
    parentThreadId: value["x-codex-turn-metadata"]?.parent_thread_id,
  }));

/** Opaque MCP metadata is only a cross-check, never Session attribution. */
export function parseAgentCallMetadata(value: unknown) {
  return agentCallMetadataSchema.safeParse(value ?? {});
}
