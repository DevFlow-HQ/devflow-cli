// The registry of secrets Secant itself introduces — private to the Harness
// Module, with no register function on its Interface. Whatever mints a secret
// (today the permission bridge's bearer; the ADR 0033 agent-call token when it
// lands) registers it once it is handed out, and the registry keeps it for the
// rest of the Secant invocation: a cause translated after its minter is torn
// down (M11's Detailed diagnostics may translate late) still redacts it. The
// cost is one short token per bridge for the life of the process.
//
// One redaction mechanism serves both outputs: the Seam's shape-preserving
// `redactSecrets` (a failure cause stays an Error on a `HarnessFailure`) and the
// safe cause translator's `redactText`, applied to every string before any cut.

/** Each registered secret and its placeholder, kept for the invocation. */
const registrations = new Map<string, string>();

/** Nested causes kept by the Seam redactor and the safe cause translator. */
export const CAUSE_DEPTH = 4;

/** Error properties Node's `child_process` populates that can carry a launch
 *  argv (and thus a secret) into a diagnostic, including the non-enumerable
 *  `message` and `stack` that `Object.entries` skips. */
const ARGV_BEARING_KEYS = [
  "spawnargs",
  "cmd",
  "path",
  "syscall",
  "message",
  "stack",
] as const;

/** Register a secret under a label naming its kind; its placeholder is
 *  `«redacted-<label>»`. There is no release: it stays redacted until exit. */
export function registerSecret(secret: string, label: string): void {
  registrations.set(secret, `«redacted-${label}»`);
}

/** Replace every occurrence of every registered secret. */
export function redactText(text: string): string {
  let out = text;
  for (const [secret, placeholder] of registrations) {
    out = out.split(secret).join(placeholder);
  }
  return out;
}

/** Scrub a failure cause before it crosses the Seam. Inspect the same bounded
 *  Error chain as the translator; preserve identity if none of its fields change.
 *  A changed chain keeps each Error's name, non-enumerable cause, and scrubbed
 *  launch fields without mutating the original failure. */
export function redactSecrets(value: unknown): unknown {
  const links: Array<{
    fields: Map<string, unknown>;
    hasCause: boolean;
  }> = [];
  let current = value;
  let changed = false;
  for (
    let depth = 0;
    depth <= CAUSE_DEPTH && current instanceof Error;
    depth += 1
  ) {
    const source = current as unknown as Record<string, unknown>;
    const fields = new Map(Object.entries(source));
    fields.delete("cause");
    // Native names and launch fields may be inherited or non-enumerable.
    for (const key of ["name", ...ARGV_BEARING_KEYS]) {
      const raw = source[key];
      if (raw !== undefined) fields.set(key, raw);
    }
    for (const [key, raw] of fields) {
      const safe = scrubValue(raw);
      changed ||= !Object.is(safe, raw);
      fields.set(key, safe);
    }
    current = current.cause;
    links.push({ fields, hasCause: current !== undefined });
    if (current === undefined) break;
  }
  // Never retain an uninspected Error below a redacted chain. The null cause
  // still lets the translator mark its depth cut, without exposing that tail.
  const beyondBound = current instanceof Error;
  let safe = beyondBound ? null : scrubValue(current);
  changed ||= !beyondBound && !Object.is(safe, current);
  if (!changed) return value;

  for (const { fields, hasCause } of links.reverse()) {
    const clone = new Error();
    Object.assign(clone, Object.fromEntries(fields));
    if (hasCause) {
      Object.defineProperty(clone, "cause", {
        value: safe,
        writable: true,
        configurable: true,
      });
    }
    safe = clone;
  }
  return safe;
}

function scrubValue(raw: unknown): unknown {
  if (typeof raw === "string") return redactText(raw);
  if (Array.isArray(raw)) {
    const safe = raw.map((item) =>
      typeof item === "string" ? redactText(item) : item,
    );
    return safe.some((item, index) => !Object.is(item, raw[index]))
      ? safe
      : raw;
  }
  return raw;
}
