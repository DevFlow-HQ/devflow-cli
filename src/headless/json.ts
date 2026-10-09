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
  ).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" || character === "\t"
      ? character
      : character
          .split("")
          .map(
            (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
          .join(""),
  );
}
