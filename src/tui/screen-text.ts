import stripAnsi from "strip-ansi";

/** Text already screened at the display boundary. Layout keeps this value separate from raw content. */
export interface ScreenedText {
  readonly text: string;
}

/** Terminal display only. Retained content and JSON keep their original bytes. */
export function screenText(text: string): ScreenedText {
  return {
    text: stripAnsi(text)
      .replace(/\r\n?/g, "\n")
      .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
        character === "\n" || character === "\t" ? character : "",
      ),
  };
}
