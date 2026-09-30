export async function runNamedScenario<Result>(
  name: string,
  scenario: () => Promise<Result>,
): Promise<Result> {
  try {
    return await scenario();
  } catch (cause) {
    throw new Error(`Package smoke scenario "${name}" failed.`, { cause });
  }
}

/** Runs the smoke, then its cleanup. A cleanup failure fails a passing smoke, but it
 *  never replaces a failed smoke's own error: a failed scenario can leave a child
 *  holding a file in the smoke root, which Windows refuses to delete. Both errors
 *  then print, the smoke's first. */
export async function withCleanup<Result>(
  smoke: () => Promise<Result>,
  cleanup: () => Promise<void>,
): Promise<Result> {
  let result: Result;
  try {
    result = await smoke();
  } catch (failure) {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "Package smoke failed, and its temporary directory could not be removed.",
        { cause: cleanupFailure },
      );
    }
    throw failure;
  }
  await cleanup();
  return result;
}
