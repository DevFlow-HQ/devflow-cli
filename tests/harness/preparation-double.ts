import { createPreparationOwnerForTest } from "../../src/harness/harness.js";

type Owner = ReturnType<typeof createPreparationOwnerForTest>;

/** Script acquisition only; production owns registration, cancellation, cleanup,
 * the exclusive handoff and the immutable deadline report. */
export function ownPreparations(
  adapter: { readonly prepare: Parameters<Owner["prepare"]>[1] },
  clock?: Parameters<typeof createPreparationOwnerForTest>[0],
) {
  const owner = createPreparationOwnerForTest(clock);
  return {
    prepare: (options: Parameters<Owner["prepare"]>[0]) =>
      owner.prepare(options, (scoped, initial) =>
        adapter.prepare(scoped, initial),
      ),
    close: (options?: Parameters<Owner["close"]>[0]) => owner.close(options),
  };
}
