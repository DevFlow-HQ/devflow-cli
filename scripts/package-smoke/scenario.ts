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

/** Runs verification, then its cleanup. A cleanup failure fails passing verification, but it
 *  never replaces the verification error: a failed scenario can leave a child
 *  holding a file in the temporary directory, which Windows refuses to delete.
 *  Both errors then print, the verification error first. */
export async function withCleanup<Result>(
  verify: () => Promise<Result>,
  cleanup: () => Promise<void>,
  caller = "Package smoke",
): Promise<Result> {
  let result: Result;
  try {
    result = await verify();
  } catch (failure) {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        `${caller} failed, and its temporary directory could not be removed.`,
        { cause: cleanupFailure },
      );
    }
    throw failure;
  }
  await cleanup();
  return result;
}
