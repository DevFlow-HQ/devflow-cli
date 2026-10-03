import { z } from "zod";
import type { OwnedProcess } from "../../process/process.js";
import type { HarnessDefaults, ModelChoice, ModelEntry } from "../harness.js";
import {
  boundedCodexExchange,
  CodexExchangeTimeoutError,
  CodexJsonlConnection,
  type CodexProtocolObserver,
} from "./runtime-protocol.js";

declare const __SECANT_VERSION__: string;

const MAX_STDERR_BYTES = 64 * 1024;

const initializeResultSchema = z.looseObject({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
});
const accountResultSchema = z.looseObject({
  account: z
    .union([
      z.null(),
      z.looseObject({
        type: z.enum(["apiKey", "chatgpt", "amazonBedrock"]),
      }),
    ])
    .optional(),
  requiresOpenaiAuth: z.boolean(),
});
const modelResultSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      model: z.string().min(1),
      displayName: z.string().min(1),
      hidden: z.boolean(),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z.array(
        z.looseObject({ reasoningEffort: z.string().min(1) }),
      ),
      defaultReasoningEffort: z.string().min(1),
    }),
  ),
});
const configReadResultSchema = z.looseObject({
  config: z.looseObject({
    model: z.string().min(1).nullish(),
    model_reasoning_effort: z.string().min(1).nullish(),
  }),
});

/** What `model/list` observed: the non-hidden models in order, each with its
 *  efforts and default effort, and the model Codex marks as its default. */
export interface CodexModelList {
  readonly models: readonly ModelEntry[];
  readonly defaultModel?: string;
}

export interface CodexRecordingObserver extends CodexProtocolObserver {
  version(version: string): void;
  schema(schema: string, probeRevision: string): void;
  stdin(bytes: Uint8Array): void;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  closed(kind: string, status: number | undefined): void;
}

/** Owns the bounded pre-thread JSONL exchange with one app-server child. */
export class CodexQualificationConnection {
  private readonly connection: CodexJsonlConnection;
  private transferred = false;

  constructor(
    private readonly process: OwnedProcess,
    private readonly timeoutMs: number,
    private readonly observer: CodexRecordingObserver | undefined,
  ) {
    this.connection = new CodexJsonlConnection(process, observer);
  }

  async initialize(): Promise<void> {
    const version =
      typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";
    const result = await this.request("initialize", {
      clientInfo: { name: "secant", title: "Secant", version },
      capabilities: { experimentalApi: false },
    });
    parseResult(result, initializeResultSchema, "initialize");
    await this.notify("initialized");
  }

  async readAccount(): Promise<z.infer<typeof accountResultSchema>> {
    const result = await this.request("account/read", { refreshToken: false });
    return parseResult(result, accountResultSchema, "account/read");
  }

  /** Run `model/list` and return the observed, non-hidden models in order with
   *  their efforts as reported — the list Codex's profile declares and a requested
   *  model is validated against — and Codex's default model among them. */
  async listModels(): Promise<CodexModelList> {
    const result = await this.request("model/list", {
      cursor: null,
      includeHidden: false,
      limit: null,
    });
    const parsed = parseResult(result, modelResultSchema, "model/list");
    const listed = parsed.data.filter((entry) => !entry.hidden);
    const defaultModel = listed.find((entry) => entry.isDefault)?.model;
    return {
      models: listed.map((entry) => {
        const efforts = entry.supportedReasoningEfforts.map(
          (option) => option.reasoningEffort,
        );
        // A model without efforts has no default effort, whatever the field says.
        return {
          model: entry.model,
          label: entry.displayName,
          efforts,
          ...(efforts.length === 0
            ? {}
            : { defaultEffort: entry.defaultReasoningEffort }),
        };
      }),
      ...(defaultModel === undefined ? {} : { defaultModel }),
    };
  }

  runtimeConnection(): CodexJsonlConnection {
    if (this.transferred) {
      throw new Error("Codex qualification connection already transferred");
    }
    this.transferred = true;
    return this.connection;
  }

  private request(method: string, params: object): Promise<unknown> {
    return boundedCodexExchange({
      operation: () => this.unboundedRequest(method, params),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification exchange`,
    });
  }

  private async unboundedRequest(
    method: string,
    params: object,
  ): Promise<unknown> {
    return this.connection.qualificationRequest(method, params);
  }

  private notify(method: string): Promise<void> {
    return boundedCodexExchange({
      operation: () => this.connection.qualificationNotify(method),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification notification`,
    });
  }
}

/** Codex's default Model choice for the Workspace (ADR 0034): the model and
 *  effort `config/read` names, else the `model/list` default model at its own
 *  default effort, the fallback, with the reason. `read` is the bounded exchange;
 *  any failure of it falls back too. A configured effort the model does not offer
 *  gives way to that model's default effort, as a model change does. */
export async function readCodexDefaults(
  read: () => Promise<unknown>,
  list: CodexModelList,
): Promise<HarnessDefaults> {
  let configured: z.infer<typeof configReadResultSchema>["config"];
  try {
    configured = parseResult(
      await read(),
      configReadResultSchema,
      "config/read",
    ).config;
  } catch (cause) {
    // The reason crosses the Seam to a person, so it names no RPC and carries no
    // raw native message; only whether Codex answered at all.
    return codexFallback(
      list,
      cause instanceof CodexExchangeTimeoutError
        ? "Codex did not report its configuration in time."
        : "Codex could not report its configuration.",
    );
  }
  if (configured.model === undefined || configured.model === null) {
    return codexFallback(list, "Codex's configuration names no model.");
  }
  const entry = list.models.find(
    (candidate) => candidate.model === configured.model,
  );
  if (entry === undefined) {
    return codexFallback(
      list,
      `Codex's configuration names '${configured.model}', which is not one of Codex's listed models.`,
    );
  }
  const effort =
    typeof configured.model_reasoning_effort === "string" &&
    entry.efforts.includes(configured.model_reasoning_effort)
      ? configured.model_reasoning_effort
      : entry.defaultEffort;
  return { kind: "reported", choice: choiceOf(entry.model, effort) };
}

function codexFallback(list: CodexModelList, reason: string): HarnessDefaults {
  const entry = list.models.find(
    (candidate) => candidate.model === list.defaultModel,
  );
  if (entry === undefined) {
    return {
      kind: "unavailable",
      reason: `${reason} Codex lists no default model to start from.`,
    };
  }
  return {
    kind: "fallback",
    choice: choiceOf(entry.model, entry.defaultEffort),
    reason: `${reason} Starting from Codex's default model at its default effort.`,
  };
}

function choiceOf(model: string, effort: string | undefined): ModelChoice {
  return effort === undefined ? { model } : { model, effort };
}

/** Drains stderr independently of protocol stdout and retains bounded evidence. */
export class CodexDiagnosticCapture {
  private readonly decoder = new TextDecoder();
  private readonly completion: Promise<Error | undefined>;
  private captured = "";
  private bytes = 0;

  constructor(
    stream: AsyncIterable<Uint8Array>,
    private readonly observer?: CodexRecordingObserver,
  ) {
    this.completion = this.consume(stream).then(
      () => undefined,
      (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Codex stderr reader failed", { cause }),
    );
  }

  async settle(timeoutMs: number): Promise<CodexDiagnosticResult> {
    let cause: Error | undefined;
    try {
      cause = await boundedCodexExchange({
        operation: () => this.completion,
        timeoutMs,
        label: "Codex stderr drain",
      });
    } catch (error) {
      cause =
        error instanceof Error
          ? error
          : new Error("Codex stderr drain failed", { cause: error });
    }
    if (cause === undefined) return { text: this.captured.trim() };
    return { text: this.captured.trim(), cause };
  }

  private async consume(stream: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of stream) {
      this.observer?.stderr(chunk);
      if (this.bytes >= MAX_STDERR_BYTES) continue;
      const remaining = MAX_STDERR_BYTES - this.bytes;
      const accepted = chunk.subarray(0, remaining);
      this.bytes += accepted.byteLength;
      this.captured += this.decoder.decode(accepted, { stream: true });
    }
    this.captured += this.decoder.decode();
  }
}

interface CodexDiagnosticResult {
  readonly text: string;
  readonly cause?: Error;
}

function parseResult<T>(
  value: unknown,
  schema: z.ZodType<T>,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${method} returned an incompatible result: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
