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
    { readonly index: number; readonly text: string } | undefined;
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

  emitPreview(delta: string): void {
    if (this.closed) return;
    const text = (this.preview?.text ?? "") + delta;
    const index = this.preview?.index ?? this.events.length;
    this.preview = { index, text };
    const event: TurnEvent = { kind: "preview", text };
    this.events[index] = event;
    for (const listener of this.listeners) listener(event);
  }

  clearPreview(): void {
    if (this.closed || this.preview === undefined) return;
    this.events.splice(this.preview.index, 1);
    this.preview = undefined;
  }

  seal(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
