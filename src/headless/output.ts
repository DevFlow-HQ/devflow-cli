import type { HeadlessIO } from "./headless.js";
import stripAnsi from "strip-ansi";

/** Terminal display only. Retained content and JSON keep their original bytes. */
function screenText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/** Commands distinguish serialized JSON from terminal text at the output Seam. */
export interface CommandIO extends HeadlessIO {
  json(serialized: string): void;
}

export function screenOutput(io: HeadlessIO): CommandIO {
  return {
    out: (text) => io.out(screenText(text)),
    err: (text) => io.err(screenText(text)),
    json: (serialized) => io.out(serialized),
    cwd: () => io.cwd(),
  };
}
