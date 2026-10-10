import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translateCause, type SafeCause } from "../../harness/harness.js";
import type { DiagnosticContent } from "./store.js";

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
  return `${sections.join("\n\n")}\n`;
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
