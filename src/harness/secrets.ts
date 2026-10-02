// The registry of secrets Secant itself introduces — private to the Harness
// Module, with no register function on its Interface. Whatever mints a secret
// (today the permission bridge's bearer; the ADR 0033 agent-call token when it
// lands) registers it while the secret is live and releases it when it is torn
// down, so the registry never grows across bridges in a long session.
//
// One redaction mechanism serves both outputs: the Seam's shape-preserving
// `redactSecrets` (a failure cause stays an Error on a `HarnessFailure`) and the
// safe cause translator's `redactText`, applied to every string before any cut.

/** One live registration; releasing it removes exactly this entry. */
interface Registration {
  readonly secret: string;
  readonly placeholder: string;
}

const registrations = new Set<Registration>();

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

/** Register a live secret under a label naming its kind; its placeholder is
 *  `«redacted-<label>»`. Returns the idempotent release. */
export function registerSecret(secret: string, label: string): () => void {
  const registration = { secret, placeholder: `«redacted-${label}»` };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

/** Replace every occurrence of every registered secret. */
export function redactText(text: string): string {
  let out = text;
  for (const { secret, placeholder } of registrations) {
    out = out.split(secret).join(placeholder);
  }
  return out;
}

/** Scrub every registered secret from a value about to cross the Seam as a
 *  failure cause or diagnostic. An Error is cloned with its message, stack, and
 *  argv-bearing fields scrubbed so the failure keeps its shape without carrying
 *  the secret; a string is scrubbed; anything else passes through. */
export function redactSecrets(value: unknown): unknown {
  if (value instanceof Error) {
    const source = value as unknown as Record<string, unknown>;
    const clone = new Error(redactText(value.message));
    const target = clone as unknown as Record<string, unknown>;
    // Every enumerable own field (Node puts spawnargs/path/syscall/code here).
    for (const [key, raw] of Object.entries(source)) {
      target[key] = scrubValue(raw);
    }
    for (const key of ARGV_BEARING_KEYS) {
      const raw = source[key];
      if (raw !== undefined) target[key] = scrubValue(raw);
    }
    return clone;
  }
  return scrubValue(value);
}

function scrubValue(raw: unknown): unknown {
  if (typeof raw === "string") return redactText(raw);
  if (Array.isArray(raw)) {
    return raw.map((item) =>
      typeof item === "string" ? redactText(item) : item,
    );
  }
  return raw;
}
