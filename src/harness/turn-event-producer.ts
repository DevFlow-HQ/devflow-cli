import type {
  TurnEvent,
  TurnEventListener,
  TurnSubscription,
} from "./harness.js";

/** Retains normalized Turn history independently of native result settlement.
 * Sealing ends live production; historical subscription replay remains available. */
export class TurnEventProducer {
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private preview:
    | {
        readonly index: number;
        readonly text: string;
        readonly messageId?: string;
      }
    | undefined;
  private readonly messagePreviews = new Map<string, string>();
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
    if (this.closed) return;
    const previous =
      messageId === undefined
        ? this.preview?.messageId === undefined
          ? (this.preview?.text ?? "")
          : ""
        : (this.messagePreviews.get(messageId) ?? "");
    const text = previous + delta;
    if (messageId !== undefined) this.messagePreviews.set(messageId, text);
    const index = this.preview?.index ?? this.events.length;
    this.preview = {
      index,
      text,
      ...(messageId === undefined ? {} : { messageId }),
    };
    const event: TurnEvent = { kind: "preview", text };
    this.events[index] = event;
    for (const listener of this.listeners) listener(event);
  }

  clearPreview(messageId?: string): void {
    if (this.closed) return;
    if (messageId !== undefined) this.messagePreviews.delete(messageId);
    if (
      this.preview === undefined ||
      (messageId !== undefined && this.preview.messageId !== messageId)
    )
      return;
    this.events.splice(this.preview.index, 1);
    this.preview = undefined;
  }

  /** A terminal boundary retains only a preview with qualified message identity.
   * Its known text is partial, never an invented completed message. */
  settlePreview(): void {
    if (this.closed) return;
    this.clearPreview();
    const pending = [...this.messagePreviews];
    this.messagePreviews.clear();
    for (const [messageId, content] of pending)
      this.emit({
        kind: "assistant-content",
        messageId,
        content,
        incomplete: true,
      });
  }

  seal(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
