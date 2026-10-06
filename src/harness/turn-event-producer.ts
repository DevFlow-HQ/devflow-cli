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
