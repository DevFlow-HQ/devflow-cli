import assert from "node:assert/strict";
import type {
  HarnessFailure,
  PrepareResult,
} from "../../src/harness/harness.js";
import { ownPreparations } from "./preparation-double.js";
import { qualificationAdapter } from "../helpers/wiringDoubles.js";

/** Hold dedicated Run acquisition; production owns cancellation and handoff.
 * Catalog qualification remains independent of the Run's held preparation. */
export function heldRunPreparation(startupFailure?: HarnessFailure) {
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<PrepareResult>();
  const qualified = qualificationAdapter([]);
  const adapter = ownPreparations({
    async prepare(options, initial) {
      if (options.writableDirectory === undefined)
        return qualified.prepare(options);
      if (startupFailure !== undefined) initial.failed(startupFailure);
      const signal = options.signal;
      assert.ok(signal);
      const cancel = () =>
        finish.resolve({
          ok: false,
          failure: {
            phase: "prepare",
            category: "preparation-cancelled",
            possibleEffects: "none",
          },
        });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      entered.resolve(signal);
      try {
        return await finish.promise;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
  return {
    adapter,
    entered: entered.promise,
    fail(
      failure: HarnessFailure = {
        phase: "prepare",
        category: "authentication",
        possibleEffects: "none",
      },
    ) {
      finish.resolve({ ok: false, failure });
    },
  };
}
