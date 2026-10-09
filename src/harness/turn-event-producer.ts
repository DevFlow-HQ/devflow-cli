import { retainCommandOutput } from "./harness.js";
import { redactText, secretPrefixLength } from "./secrets.js";
import type {
  TurnEvent,
  ToolCall,
  TurnEventListener,
  TurnSubscription,
} from "./harness.js";

export class TurnEventProducer {
  private readonly messageText = new Map<string, string>();
  private readonly commandText = new Map<string, CommandText>();
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private readonly previews = new Map<
    string,
    Extract<TurnEvent, { kind: "message-preview" }>
  >();
  private readonly toolPreviews = new Map<
    string,
    Extract<TurnEvent, { kind: "tool-preview" }>
  >();
  private readonly calls = new Map<
    string,
    Extract<TurnEvent, { kind: "tool-call" }>
  >();
  private readonly thoughts = new Map<
    string,
    Extract<TurnEvent, { kind: "thought-preview" }>
  >();
  private readonly settledThoughts = new Set<string>();
  private diffPreview:
    Extract<TurnEvent, { kind: "turn-diff-preview" }> | undefined;
  private diffSettled = false;
  private closed = false;
  get sealed(): boolean {
    return this.closed;
  }
  subscribe(listener: TurnEventListener): TurnSubscription {
    for (const event of this.events) listener(event);
    if (!this.closed) this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }
  emit(event: TurnEvent): void {
    if (this.closed) return;
    if (event.kind === "tool-call") {
      if (event.call.outcome.kind !== "running")
        this.commandText.delete(event.call.callId);
      else if (
        event.call.output !== undefined &&
        !this.commandText.has(event.call.callId)
      )
        this.commandText.set(
          event.call.callId,
          new CommandText(event.call.output),
        );
    }
    event = this.redact(event);
    if (event.kind === "assistant-content") this.clearPreview(event.messageId);
    if (event.kind === "message-preview") {
      const previous = this.previews.get(event.messageId);
      this.previews.set(event.messageId, event);
      if (previous === undefined) this.events.push(event);
      else this.events[this.events.indexOf(previous)] = event;
      for (const listener of this.listeners) listener(event);
      return;
    }
    if (event.kind === "thought-preview") {
      if (this.settledThoughts.has(event.summaryId) || !event.content.trim())
        return;
      const previous = this.thoughts.get(event.summaryId);
      this.thoughts.set(event.summaryId, event);
      if (previous === undefined) this.events.push(event);
      else this.events[this.events.indexOf(previous)] = event;
      for (const listener of this.listeners) listener(event);
      return;
    }
    if (event.kind === "turn-diff-preview" || event.kind === "turn-diff") {
      if (this.diffSettled) return;
      if (event.kind === "turn-diff-preview") {
        if (this.diffPreview === undefined) this.events.push(event);
        else this.events[this.events.indexOf(this.diffPreview)] = event;
        this.diffPreview = event;
        for (const listener of this.listeners) listener(event);
        return;
      }
      if (this.diffPreview !== undefined)
        this.events.splice(this.events.indexOf(this.diffPreview), 1);
      this.diffPreview = undefined;
      this.diffSettled = true;
    }
    if (
      event.kind === "tool-call" ||
      event.kind === "tool-preview" ||
      event.kind === "tool-partial"
    ) {
      let toolEvent: Extract<
        TurnEvent,
        { kind: "tool-call" | "tool-preview" | "tool-partial" }
      > = event;
      const retained =
        this.toolPreviews.get(toolEvent.call.callId)?.call ??
        this.calls.get(toolEvent.call.callId)?.call;
      const output =
        toolEvent.call.output ??
        (toolEvent.call.outcome.kind !== "running" &&
        retained?.output !== undefined
          ? { ...retained.output, incomplete: true as const }
          : undefined);
      const facts =
        output === undefined ? {} : { output: retainCommandOutput(output) };
      if (toolEvent.kind === "tool-call")
        toolEvent = {
          kind: "tool-call",
          call: { ...retained, ...toolEvent.call, ...facts },
        };
      else if (toolEvent.kind === "tool-partial")
        toolEvent = {
          kind: "tool-partial",
          call: {
            ...retained,
            ...toolEvent.call,
            output: {
              ...retainCommandOutput(toolEvent.call.output),
              incomplete: true,
            },
            outcome: { kind: "running" },
          },
        };
      else
        toolEvent = {
          kind: "tool-preview",
          call: {
            ...retained,
            ...toolEvent.call,
            outcome: { kind: "running" },
            ...facts,
          },
        };

      const previous = this.calls.get(toolEvent.call.callId);
      if (previous !== undefined && previous.call.outcome.kind !== "running")
        return;
      if (toolEvent.kind === "tool-preview") {
        const preview = this.toolPreviews.get(toolEvent.call.callId);
        if (preview === undefined) this.events.push(toolEvent);
        else this.events[this.events.indexOf(preview)] = toolEvent;
        this.toolPreviews.set(toolEvent.call.callId, toolEvent);
        for (const listener of this.listeners) listener(toolEvent);
        return;
      }
      if (
        toolEvent.kind === "tool-call" &&
        toolEvent.call.outcome.kind === "running" &&
        previous !== undefined
      )
        return;
      if (toolEvent.kind === "tool-partial") {
        const preview = this.toolPreviews.get(toolEvent.call.callId);
        if (preview !== undefined)
          this.events.splice(this.events.indexOf(preview), 1);
        this.toolPreviews.delete(toolEvent.call.callId);
      } else this.calls.set(toolEvent.call.callId, toolEvent);
      if (toolEvent.call.outcome.kind !== "running") {
        const preview = this.toolPreviews.get(toolEvent.call.callId);
        if (preview !== undefined)
          this.events.splice(this.events.indexOf(preview), 1);
        this.toolPreviews.delete(toolEvent.call.callId);
      }
      this.events.push(toolEvent);
      for (const listener of this.listeners) listener(toolEvent);
      return;
    }
    if (event.kind === "thought") {
      if (this.settledThoughts.has(event.summaryId)) return;
      this.settledThoughts.add(event.summaryId);
      const observed = this.thoughts.has(event.summaryId);
      this.clearThoughtPreview(event.summaryId);
      if (!observed && !event.content.trim()) return;
    }
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  redact<T extends object>(value: T): T {
    const safe = structuredClone(value);
    const visit = (object: object): void => {
      for (const [key, field] of Object.entries(object)) {
        if (typeof field === "string")
          Reflect.set(object, key, redactText(field));
        else if (typeof field === "object" && field !== null) visit(field);
      }
    };
    visit(safe);
    return safe;
  }

  emitPreview(delta: string, messageId?: string): void {
    if (this.closed || messageId === undefined) return;
    const content = (this.messageText.get(messageId) ?? "") + delta;
    this.messageText.set(messageId, content);
    this.emit({
      kind: "message-preview",
      messageId,
      content,
    });
  }

  emitCommandOutput(delta: string, callId: string): void {
    if (this.closed) return;
    const call =
      this.toolPreviews.get(callId)?.call ?? this.calls.get(callId)?.call;
    if (
      call === undefined ||
      call.tool !== "command" ||
      call.outcome.kind !== "running"
    )
      return;
    let text = this.commandText.get(callId);
    if (text === undefined) {
      text = new CommandText(call.output ?? { text: "" });
      this.commandText.set(callId, text);
    }
    this.emit({
      kind: "tool-preview",
      call: {
        ...call,
        outcome: { kind: "running" },
        output: text.append(delta),
      },
    });
  }

  clearPreview(messageId?: string): void {
    if (this.closed) return;
    for (const [id, event] of this.previews) {
      if (messageId !== undefined && messageId !== id) continue;
      this.events.splice(this.events.indexOf(event), 1);
      this.previews.delete(id);
      this.messageText.delete(id);
    }
  }
  emitThoughtPreview(content: string, summaryId: string): void {
    this.emit({ kind: "thought-preview", summaryId, content });
  }

  private clearThoughtPreview(summaryId: string): void {
    const previous = this.thoughts.get(summaryId);
    if (previous === undefined) return;
    this.events.splice(this.events.indexOf(previous), 1);
    this.thoughts.delete(summaryId);
  }
  settlePreview(): void {
    if (this.closed) return;
    const pending = this.events.filter(
      (event) =>
        event.kind === "message-preview" || event.kind === "thought-preview",
    );
    const tools = new Map<string, { readonly call: ToolCall }>([
      ...this.calls,
      ...this.toolPreviews,
    ]);
    for (const { call } of tools.values()) {
      if (call.outcome.kind !== "running" || call.output === undefined)
        continue;
      this.emit({
        kind: "tool-partial",
        call: {
          ...call,
          outcome: { kind: "running" },
          output: { ...call.output, incomplete: true },
        },
      });
    }
    this.clearPreview();
    if (this.diffPreview !== undefined)
      this.emit({ kind: "turn-diff", diff: this.diffPreview.diff });
    for (const event of pending) {
      if (event.kind === "thought-preview") {
        this.emit({
          kind: "thought",
          summaryId: event.summaryId,
          content: event.content,
          incomplete: true,
        });
      } else if (event.kind === "message-preview")
        this.emit({
          kind: "assistant-content",
          messageId: event.messageId,
          content: event.content,
          incomplete: true,
        });
    }
  }
  seal(): void {
    this.closed = true;
    this.listeners.clear();
    this.messageText.clear();
    this.commandText.clear();
  }
}

/** Named test Seam carrying normalized events only, without native protocol. */
export function createTurnEventProducerForTest(): Pick<
  TurnEventProducer,
  "subscribe" | "emit" | "settlePreview" | "seal"
> {
  return new TurnEventProducer();
}

// Keep only the redacted tail plus a suffix that may complete a registered secret
// on the next delta. That suffix must survive even when the visible tail is cut.
class CommandText {
  private tail: NonNullable<ToolCall["output"]> = { text: "" };
  private pending = "";
  constructor(output: NonNullable<ToolCall["output"]>) {
    this.tail = { ...output, text: "" };
    this.append(output.text);
  }
  append(delta: string): NonNullable<ToolCall["output"]> {
    const text = redactText(this.tail.text + this.pending + delta);
    const length = secretPrefixLength(text);
    this.pending = text.slice(text.length - length);
    this.tail = retainCommandOutput({
      ...this.tail,
      text: text.slice(0, text.length - length),
    });
    const output = retainCommandOutput({
      ...this.tail,
      text: this.tail.text + this.pending,
    });
    if (output.secantDropped) this.tail = { ...this.tail, secantDropped: true };
    return output;
  }
}
