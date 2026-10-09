import type {
  ObserverEnd,
  ProjectionSnapshot,
  ProjectionUpdate,
} from "./projection-port.js";

type ClosedUpdate = Extract<ProjectionUpdate, { kind: "closed" }>;
type DeliveredUpdate<S extends ProjectionSnapshot> = Exclude<
  ProjectionUpdate<S>,
  { kind: "closed" }
>;

// The bound on one opened subscription's unread backlog (#306), taken from T3 Code's
// LiveStreamBudget (1,000 items, 8 MiB of serialized JSON). Payload is estimated
// rather than serialized: the UTF-16 code units of its strings plus one unit per
// other value and per key name, so measuring never allocates a copy or throws.
// Producer and consumers share one event loop, so a reading consumer drains its
// backlog between producer turns; the bound is reached by an observer that stopped
// reading, or by any observer within one synchronous burst past it — either way
// only that subscription ends, and it recovers by reopening.
const RETAINED_UPDATES = 1_000;
const RETAINED_UNITS = 8 * 1024 * 1024;

// Snapshots and overlays are immutable and shared across a fan-out: measure each
// once, without keeping it alive.
const measured = new WeakMap<object, number>();

/**
 * One opened Projection subscription. Session history retains the latest unread
 * page and later whole-row previews (#488); other families deliver FIFO (#306).
 * Its unread backlog is bounded by count and retained payload; an empty backlog always admits one
 * update, so an observer that is only between reads never loses a large snapshot.
 * An update that would pass either bound ends the subscription `observer-lagged`.
 *
 * Ending (`end`) is the one terminal path: it releases the undelivered backlog,
 * delivers exactly one `closed` update ahead of it, then completes the iterator,
 * and every later push is ignored. The producer is never slowed or failed.
 */
export class UpdateStream<
  S extends ProjectionSnapshot = ProjectionSnapshot,
> implements AsyncIterable<ProjectionUpdate<S>> {
  private queue: {
    readonly update: DeliveredUpdate<S>;
    readonly units: number;
  }[] = [];
  private retainedUnits = 0;
  private waiting?: (result: IteratorResult<ProjectionUpdate<S>>) => void;
  private terminal?: ClosedUpdate;
  private finished = false;

  constructor(private onFinish?: () => void) {}

  push(update: DeliveredUpdate<S>): void {
    if (this.finished) return;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: update, done: false });
      return;
    }
    if (
      update.kind === "durable" &&
      update.snapshot.family === "session-history"
    ) {
      this.queue = [];
      this.retainedUnits = 0;
    } else if (update.kind === "history-preview") {
      // Keep previews in delivery order so a newer window is applied last.
      this.queue = this.queue.filter((entry) => {
        const previous = entry.update;
        if (
          previous.kind === "history-preview" &&
          (previous.row.id === update.row.id ||
            previous.row.position < update.windowStart)
        ) {
          this.retainedUnits -= entry.units;
          return false;
        }
        return true;
      });
    }
    const units = unitsOf(update);
    if (
      this.queue.length >= RETAINED_UPDATES ||
      (this.queue.length > 0 && this.retainedUnits + units > RETAINED_UNITS)
    ) {
      this.end("observer-lagged");
      return;
    }
    this.queue.push({ update, units });
    this.retainedUnits += units;
  }

  /** End the subscription for a non-caller reason, ahead of any backlog. */
  end(reason: ObserverEnd): void {
    if (this.finished) return;
    this.finish();
    const closed: ClosedUpdate = { kind: "closed", reason };
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: closed, done: false });
    } else {
      this.terminal = closed;
    }
  }

  /** The caller's close: nothing further is delivered, not even a terminal. */
  close(): void {
    this.finish();
    this.terminal = undefined;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProjectionUpdate<S>> {
    return {
      next: () => {
        const head = this.queue.shift();
        if (head !== undefined) {
          this.retainedUnits -= head.units;
          return Promise.resolve({ value: head.update, done: false });
        }
        const terminal = this.terminal;
        if (terminal !== undefined) {
          this.terminal = undefined;
          return Promise.resolve({ value: terminal, done: false });
        }
        if (this.finished) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.queue = [];
    this.retainedUnits = 0;
    const onFinish = this.onFinish;
    this.onFinish = undefined;
    onFinish?.();
  }
}

function unitsOf(update: DeliveredUpdate<ProjectionSnapshot>): number {
  const payload =
    update.kind === "durable"
      ? update.snapshot
      : update.kind === "history-preview"
        ? update
        : update.overlay;
  const cached = measured.get(payload);
  if (cached !== undefined) return cached;
  const units = measure(payload);
  measured.set(payload, units);
  return units;
}

function measure(root: object): number {
  let units = 0;
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      units += value.length;
    } else if (typeof value !== "object" || value === null) {
      units += 1;
    } else if (!seen.has(value)) {
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        units += key.length;
        pending.push(child);
      }
    }
  }
  return units;
}
