import type {
  TurnEvent,
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
    if (event.kind === "tool-call" || event.kind === "tool-preview") {
      const previous = this.calls.get(event.call.callId);
      if (previous !== undefined && previous.call.outcome.kind !== "running")
        return;
      if (event.kind === "tool-preview") {
        const preview = this.toolPreviews.get(event.call.callId);
        if (preview === undefined) this.events.push(event);
        else this.events[this.events.indexOf(preview)] = event;
        this.toolPreviews.set(event.call.callId, event);
        for (const listener of this.listeners) listener(event);
        return;
      }
      if (event.call.outcome.kind === "running" && previous !== undefined)
        return;
      this.calls.set(event.call.callId, event);
      if (event.call.outcome.kind !== "running") {
        const preview = this.toolPreviews.get(event.call.callId);
        if (preview !== undefined)
          this.events.splice(this.events.indexOf(preview), 1);
        this.toolPreviews.delete(event.call.callId);
      }
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
    const event: Extract<TurnEvent, { kind: "message-preview" }> = {
      kind: "message-preview",
      messageId,
      content: (previous?.content ?? "") + delta,
    };
    this.previews.set(messageId, event);
    if (previous === undefined) this.events.push(event);
    else this.events[this.events.indexOf(previous)] = event;
    for (const listener of this.listeners) listener(event);
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
    if (this.closed || this.settledThoughts.has(summaryId) || !content.trim())
      return;
    const previous = this.thoughts.get(summaryId);
    const event: Extract<TurnEvent, { kind: "thought-preview" }> = {
      kind: "thought-preview",
      summaryId,
      content,
    };
    this.thoughts.set(summaryId, event);
    if (previous === undefined) this.events.push(event);
    else this.events[this.events.indexOf(previous)] = event;
    for (const listener of this.listeners) listener(event);
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
