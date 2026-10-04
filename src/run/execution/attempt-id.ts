/** The instance key for a (Step, Iteration): the Iteration is a number, so its
 *  digits before the separator make the key unambiguous whatever the Step id is. */
export function instanceKey(stepId: string, iteration: number): string {
  return `${iteration}:${stepId}`;
}

/** Encode an Attempt id from its Step, Iteration, and Attempt number. The numeric
 *  fields lead so the id parses back unambiguously for any Step id, and it stays
 *  human-readable where it surfaces (e.g. a Review checkpoint's Gate Attempt). */
export function encodeAttemptId(
  stepId: string,
  iteration: number,
  attempt: number,
): string {
  return `${iteration}.${attempt}:${stepId}`;
}

/** Parse an Attempt id back to its parts, or undefined for an id this Module did
 *  not mint (the Run Store's reconciliation marker is a random UUID). */
export function decodeAttemptId(
  id: string,
): { stepId: string; iteration: number; attempt: number } | undefined {
  const match = /^(\d+)\.(\d+):([\s\S]*)$/.exec(id);
  if (match === null) return undefined;
  return {
    iteration: Number(match[1]),
    attempt: Number(match[2]),
    stepId: match[3]!,
  };
}
