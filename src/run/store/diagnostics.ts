import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMAND_OUTPUT_TAIL_CHARACTERS,
  redactDiagnosticText,
  translateCause,
  type SafeCause,
} from "../../harness/harness.js";
import type { CommandOutputTail, DiagnosticContent } from "./store.js";

// Detailed diagnostics (ADR 0041, spec #527 decisions 12 and 13). Every writer
// calls `writeDiagnostic` inside its guarded transaction, after the epoch check
// and before the row that references the file: a fenced owner writes nothing,
// and a crash or rollback after the write leaves only an orphan file, which the
// 90-day prune at group open removes.

/** Write `content` as a new diagnostic under `dir` and return its Store-minted id. */
export function writeDiagnostic(
  dir: string,
  content: string | Uint8Array,
): string {
  const diagnosticId = randomUUID();
  mkdirSync(dir, {
    recursive: true,
    mode: process.platform === "win32" ? undefined : 0o700,
  });
  writeFileSync(join(dir, diagnosticId), content, {
    mode: process.platform === "win32" ? undefined : 0o600,
  });
  return diagnosticId;
}

/** Render a diagnostic as plain UTF-8 text with labelled sections in a fixed
 *  order; only present sections are written. The cause passes through the safe
 *  cause translator, which bounds it and redacts Secant-introduced secrets. */
export function renderDiagnostic(content: DiagnosticContent): string {
  const sections = [`Kind: ${content.kind}`];
  if (content.cause !== undefined) {
    sections.push(renderCause(translateCause(content.cause)));
  }
  if (present(content.stdoutTail)) {
    sections.push(renderTail("Command stdout tail", content.stdoutTail));
  }
  if (present(content.stderrTail)) {
    sections.push(renderTail("Command stderr tail", content.stderrTail));
  }
  const harnessSections: readonly (readonly [string, string | undefined])[] = [
    ["Partial output", content.partialOutput],
    ["Retry evidence", content.retryEvidence],
    ["Harness diagnostics", content.harnessDiagnostics],
    ["Last authoritative observation", content.lastObservation],
  ];
  for (const [label, text] of harnessSections) {
    if (text !== undefined)
      sections.push(`${label}:\n${boundDiagnosticText(text, label)}`);
  }
  if (content.command !== undefined) {
    sections.push(`Command: ${content.command}`);
  }
  return `${sections.join("\n\n")}\n`;
}

// Spec #527 decision 13: a Command tail keeps M10's retained-output bound of
// last characters, exactly as captured, behind one omission marker.
const OMISSION_MARKER = "[secant: earlier output omitted]";

/** An empty stream with nothing dropped has no tail to write. */
function present(
  tail: CommandOutputTail | undefined,
): tail is CommandOutputTail {
  return tail !== undefined && (tail.text.length > 0 || tail.omitted);
}

function renderTail(label: string, tail: CommandOutputTail): string {
  // Count code points, so the cut never splits a surrogate pair.
  const characters = Array.from(tail.text);
  const cut = characters.length > COMMAND_OUTPUT_TAIL_CHARACTERS;
  const kept = cut
    ? characters.slice(-COMMAND_OUTPUT_TAIL_CHARACTERS).join("")
    : tail.text;
  return cut || tail.omitted
    ? `${label}:\n${OMISSION_MARKER}\n${kept}`
    : `${label}:\n${kept}`;
}

function renderCause(cause: SafeCause): string {
  const lines: string[] = [];
  let link: SafeCause | undefined = cause;
  let label = "Cause";
  while (link !== undefined) {
    lines.push(`${label}: ${link.type}`);
    if (link.message !== undefined) lines.push(`Message: ${link.message}`);
    if (link.code !== undefined) lines.push(`Code: ${link.code}`);
    if (link.stack !== undefined) lines.push(`Stack:\n${link.stack}`);
    link = link.cause;
    label = "Caused by";
  }
  if (cause.truncated === true) lines.push("(Secant shortened this cause.)");
  return lines.join("\n");
}

/** Each section shares the existing registry and keeps a UTF-8 code-point cut.
 * The established Harness-diagnostics omission wording remains unchanged. */
function boundDiagnosticText(raw: string, label: string): string {
  const text = redactDiagnosticText(raw);
  const encoder = new TextEncoder();
  const bound = 16 * 1024;
  if (encoder.encode(text).length <= bound) return text;
  const marker =
    label === "Harness diagnostics"
      ? "\n(Secant omitted further Harness diagnostics.)"
      : "\n… diagnostic text omitted";
  const limit = bound - encoder.encode(marker).length;
  let kept = 0;
  let bytes = 0;
  for (const char of text) {
    bytes += encoder.encode(char).length;
    if (bytes > limit) break;
    kept += char.length;
  }
  return text.slice(0, kept) + marker;
}
