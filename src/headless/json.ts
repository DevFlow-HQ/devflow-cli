/** Keep operational causes private in every headless JSON envelope. */
export function headlessJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, value: unknown) => {
      // Problems can be top-level failures, receipt outcomes, or nested findings.
      // Problem details are opaque string records, even with Problem-shaped keys.
      if (
        key !== "details" &&
        value !== null &&
        typeof value === "object" &&
        "code" in value &&
        "explanation" in value &&
        "remediation" in value &&
        "possibleEffects" in value &&
        "cause" in value
      ) {
        const { cause: _cause, ...problem } = value;
        return problem;
      }
      return value;
    },
    2,
  );
}
