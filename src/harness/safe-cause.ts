// The safe cause translator (#316, ADR 0041): the one bounded, redacting view of
// an unknown failure cause that diagnostics may record. M8's operational log and
// M11's Detailed diagnostics both call it through the Harness Interface rather
// than each building a second translator.
//
// It copies only known fields and never serializes an arbitrary object. The
// bounds are fixed here, not parameters; changing one is an Interface change.
// Every bound counts UTF-8 bytes of the JSON the record serializes to, so
// escaping (a control character, a backslash-heavy Windows stack) cannot carry
// a record past its total.

import { CAUSE_DEPTH, redactText } from "./secrets.js";

/** Serialized bytes kept of a message, and of each other short field. */
const MESSAGE_BOUND = 1024;
/** Serialized bytes kept of a stack. */
const STACK_BOUND = 4096;
/** Serialized bytes of the whole record. */
const TOTAL_BOUND = 16 * 1024;

/** A failure cause translated to a bounded plain record. `type` is an Error's
 *  name, or the type label a non-Error value reduces to (`string`, `object`,
 *  `array`, `null`, …). Every string has had Secant-introduced secrets redacted
 *  before any cut. `truncated` is set, on the top-level record only, when any
 *  string or nested cause was cut to fit a bound. */
export interface SafeCause {
  readonly type: string;
  readonly message?: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly signal?: string;
  readonly stack?: string;
  readonly cause?: SafeCause;
  readonly truncated?: true;
}

/** The known fields of one link in the cause chain. */
type LinkFields = Omit<SafeCause, "cause" | "truncated">;

const encoder = new TextEncoder();

/** Translate any value to a bounded plain record. Never throws. */
export function translateCause(value: unknown): SafeCause {
  let truncated = false;
  const links: LinkFields[] = [];
  let current = value;
  for (;;) {
    const link = linkOf(current);
    links.push(link.fields);
    truncated ||= link.truncated;
    const next = isError(current) ? field(current, "cause") : undefined;
    if (next === undefined) break;
    // A cyclic chain ends here too, at the depth bound, rather than looping.
    if (links.length > CAUSE_DEPTH) {
      truncated = true;
      break;
    }
    current = next;
  }

  // Over the total bound the deepest causes go first. The field bounds keep a
  // lone record near 9 KiB, so dropping causes always fits: the top-level stack
  // and message are never dropped.
  let record = assemble(links, truncated);
  while (links.length > 1 && serializedBytes(record) > TOTAL_BOUND) {
    links.pop();
    record = assemble(links, true);
  }
  return record;
}

/** One link's known fields: an Error's, or a non-Error's type label. */
function linkOf(value: unknown): {
  readonly fields: LinkFields;
  readonly truncated: boolean;
} {
  if (!isError(value))
    return { fields: { type: labelOf(value) }, truncated: false };
  let truncated = false;
  const text = (key: string, bytes = MESSAGE_BOUND) => {
    const raw = field(value, key);
    if (typeof raw !== "string") return undefined;
    const bounded = cut(raw, bytes);
    truncated ||= bounded.cut;
    return bounded.text;
  };
  const rawCode = field(value, "code");
  const errno = field(value, "errno");
  const name = text("name");
  const fields = omitUndefined({
    type: name !== undefined && name.length > 0 ? name : "Error",
    message: text("message"),
    code:
      typeof rawCode === "number" && Number.isFinite(rawCode)
        ? String(rawCode)
        : text("code"),
    errno:
      typeof errno === "number" && Number.isFinite(errno) ? errno : undefined,
    syscall: text("syscall"),
    signal: text("signal"),
    stack: text("stack", STACK_BOUND),
  });
  return { fields, truncated };
}

/** Redact, then cut to `bytes` of serialized JSON on a code-point boundary:
 *  redacting first means a cut can never leave a fragment of a secret. */
function cut(raw: string, bytes: number): { text: string; cut: boolean } {
  const text = redactText(raw);
  if (escapedBytes(text) <= bytes) return { text, cut: false };
  let kept = 0;
  let used = 0;
  for (const char of text) {
    used += escapedBytes(char);
    if (used > bytes) break;
    kept += char.length;
  }
  return { text: text.slice(0, kept), cut: true };
}

/** UTF-8 bytes a string occupies inside a JSON string literal. */
function escapedBytes(text: string): number {
  return serializedBytes(text) - 2;
}

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function assemble(links: readonly LinkFields[], truncated: boolean): SafeCause {
  let nested: SafeCause | undefined;
  for (let index = links.length - 1; index > 0; index -= 1) {
    nested = { ...links[index]!, ...(nested ? { cause: nested } : {}) };
  }
  return {
    ...links[0]!,
    ...(nested ? { cause: nested } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

// `instanceof`, `Array.isArray`, and property reads can run foreign code (a
// Proxy trap, a getter); the translator must never throw, so each is guarded.

function labelOf(value: unknown): string {
  if (value === null) return "null";
  try {
    if (Array.isArray(value)) return "array";
  } catch {
    // A revoked Proxy: still an object.
  }
  return typeof value;
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function field(value: Error, key: string): unknown {
  try {
    return (value as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function omitUndefined(fields: Record<string, unknown>): LinkFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, raw]) => raw !== undefined),
  ) as unknown as LinkFields;
}
