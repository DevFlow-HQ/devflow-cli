import type { ExecutionObserver } from "./execution.js";

const IGNORE: ExecutionObserver = () => {};

/** Resolve and guard delivery at each Run execution entry. */
export function guardedExecutionObserver(
  observer: ExecutionObserver | undefined,
): ExecutionObserver {
  if (observer === undefined) return IGNORE;
  return (event) => {
    try {
      observer(event);
    } catch {
      // Observation never changes a Run or Turn outcome.
    }
  };
}
