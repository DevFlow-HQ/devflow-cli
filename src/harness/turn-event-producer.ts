import { retainCommandOutput } from "./harness.js";
import type {
  TurnEvent,
  ToolCall,
  TurnEventListener,
  TurnSubscription,
} from "./harness.js";

export class TurnEventProducer {
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
  emitPreview(delta: string, messageId?: string): void {
    if (this.closed || messageId === undefined) return;
    const previous = this.previews.get(messageId);
    this.emit({
      kind: "message-preview",
      messageId,
      content: (previous?.content ?? "") + delta,
    });
  }

  clearPreview(messageId?: string): void {
    if (this.closed) return;
    for (const [id, event] of this.previews) {
      if (messageId !== undefined && messageId !== id) continue;
      this.events.splice(this.events.indexOf(event), 1);
      this.previews.delete(id);
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
  }
}

/** Named test Seam carrying normalized events only, without native protocol. */
export function createTurnEventProducerForTest(): Pick<
  TurnEventProducer,
  "subscribe" | "emit" | "settlePreview" | "seal"
> {
  return new TurnEventProducer();
}
