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
  settlePreview(): void {
    if (this.closed) return;
    const pending = [...this.previews.values()];
    this.clearPreview();
    for (const event of pending)
      this.emit({
        kind: "assistant-content",
        messageId: event.messageId,
        content: event.content,
        incomplete: true,
      });
  }
  seal(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
