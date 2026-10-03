// The Claude Code control-frame channel (#346), private to the Claude Code
// Adapter. One channel serves one process's stdin: it mints each
// `control_request` id, writes the request, and correlates the
// `control_response` that echoes the id within a bounded timeout. Ids are per
// process, so a process close settles every request still pending on it.
// The native Interrupt is the first caller; the settings probe (#347), live
// model change (#348), and Steer (#359) reuse it.

import { randomUUID } from "node:crypto";
import {
  encodeControlRequest,
  type ControlRequest,
  type ControlResponseFrame,
} from "./frames.js";

/** How one control request ended. Only `success` means Claude Code accepted
 *  it; every other outcome leaves the caller to its fallback. */
export type ControlOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "write-failed" }
  | { readonly kind: "closed" };

export class ControlChannel {
  private readonly pending = new Map<
    string,
    (outcome: ControlOutcome) => void
  >();
  private closed = false;

  constructor(
    private readonly write: (bytes: Uint8Array) => Promise<void>,
    private readonly timeoutMs: number,
  ) {}

  /** Write one request and resolve with its correlated outcome. Never rejects:
   *  a failed write, the timeout, and a close each resolve their own outcome. */
  request(request: ControlRequest): Promise<ControlOutcome> {
    if (this.closed) return Promise.resolve({ kind: "closed" });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ kind: "timeout" }),
        this.timeoutMs,
      );
      const settle = (outcome: ControlOutcome): void => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        resolve(outcome);
      };
      this.pending.set(requestId, settle);
      this.write(encodeControlRequest(requestId, request)).catch(() =>
        settle({ kind: "write-failed" }),
      );
    });
  }

  /** Correlate one response. A response naming no pending request (a late
   *  answer after its timeout, or an id this process never minted) is dropped. */
  accept(frame: ControlResponseFrame): void {
    const { subtype, request_id: requestId, error } = frame.response;
    this.pending.get(requestId)?.(
      subtype === "success"
        ? { kind: "success" }
        : {
            kind: "refused",
            detail: error ?? `control response ${subtype ?? "without subtype"}`,
          },
    );
  }

  /** The process closed or is being stopped: every pending request resolves
   *  `closed`, and later requests resolve `closed` without a write. */
  close(): void {
    this.closed = true;
    for (const settle of [...this.pending.values()]) settle({ kind: "closed" });
  }
}
