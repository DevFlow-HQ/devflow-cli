import {
  decodePasteBytes,
  stripAnsiSequences,
  type KeyBinding,
  type PasteEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { untrack } from "solid-js";
import { useTheme } from "./vendor/theme-context.js";

// The multi-line box a `text` Launch input is typed into (#287). Rebuilt against
// OpenCode's prompt (component/prompt/index.tsx), not copied: ADR 0018 rebuilds a
// state-coupled piece, and `UPSTREAM` records what was taken and what differs.
// The box reports the full value on every edit, so the draft — and so Review and
// the launch — never sees a paste placeholder; the placeholder is display only.

// Enter submits and never inserts a newline; the modified Enters and Ctrl+J do.
// Ctrl+J is bound as `ctrl+j` because that is how it arrives under the kitty
// keyboard protocol; without it Ctrl+J arrives as `linefeed`, which the textarea
// default already maps to a newline. OpenTUI reports Alt as `meta`.
const KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

const PASTE_TYPE = "launch-input-paste";

/** OpenCode's summary rule: three or more lines, or over 150 characters,
 *  measured on the trimmed paste. */
function pasteSummary(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lines = (trimmed.match(/\n/g)?.length ?? 0) + 1;
  return lines >= 3 || trimmed.length > 150
    ? `[Pasted ~${lines} lines]`
    : undefined;
}

/** What the step's Up/Down bindings ask of a focused box. */
export interface LaunchTextBoxHandle {
  /** Moves the cursor one visual line, or returns false from the box's first
   *  (delta -1) or last (delta 1) line so the step can move to another input. */
  moveLine(delta: -1 | 1): boolean;
}

export function LaunchTextBox(props: {
  initialValue: string;
  focused: boolean;
  width: number;
  onValue: (value: string) => void;
  onSubmit: () => void;
  ref: (handle: LaunchTextBoxHandle) => void;
}) {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  // OpenCode's prompt height: one line at least, at most max(6, a third of the
  // terminal), then the textarea scrolls inside.
  const maxHeight = () => Math.max(6, Math.floor(dimensions().height / 3));
  let box: TextareaRenderable | undefined;
  let pasteType = 0;

  // The draft value: the box's text with each placeholder replaced by the paste
  // it stands for. Each placeholder is a virtual extmark carrying its paste in
  // `data`, which the extmark undo history keeps; offsets are the textarea's own,
  // so `getTextRange` slices without any display-width arithmetic.
  const fullValue = (textarea: TextareaRenderable): string => {
    const pastes = textarea.extmarks
      .getAllForTypeId(pasteType)
      .slice()
      .sort((a, b) => a.start - b.start);
    if (pastes.length === 0) return textarea.plainText;
    let value = "";
    let from = 0;
    for (const paste of pastes) {
      value += textarea.getTextRange(from, paste.start) + String(paste.data);
      from = paste.end;
    }
    return value + textarea.getTextRange(from, Number.MAX_SAFE_INTEGER);
  };
  // Read once: the box owns its text after mount, so a draft write never resets
  // it (which would also drop its placeholders).
  const initialValue = untrack(() => props.initialValue);
  // Mounting fires a content change too; reporting only real changes keeps an
  // input nobody touched unset in the draft rather than empty.
  let reported = initialValue;
  const report = () => {
    if (box === undefined) return;
    const value = fullValue(box);
    if (value === reported) return;
    reported = value;
    props.onValue(value);
  };

  const paste = (event: PasteEvent) => {
    const textarea = box;
    if (textarea === undefined) return;
    event.preventDefault();
    // Windows ConPTY can send CR-only line endings: CRLF first, then lone CR.
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const summary = pasteSummary(text);
    if (summary === undefined) {
      textarea.insertText(text);
      return;
    }
    const start = textarea.cursorOffset;
    textarea.insertText(summary);
    textarea.extmarks.create({
      start,
      end: textarea.cursorOffset,
      virtual: true,
      typeId: pasteType,
      data: text,
    });
  };

  return (
    <textarea
      ref={(textarea: TextareaRenderable) => {
        box = textarea;
        pasteType = textarea.extmarks.registerType(PASTE_TYPE);
        props.ref({
          moveLine(delta) {
            const row = textarea.scrollY + textarea.visualCursor.visualRow;
            const last = textarea.editorView.getTotalVirtualLineCount() - 1;
            if (delta < 0 ? row <= 0 : row >= last) return false;
            if (delta < 0) textarea.moveCursorUp();
            else textarea.moveCursorDown();
            return true;
          },
        });
      }}
      initialValue={initialValue}
      focused={props.focused}
      width={props.width}
      minHeight={1}
      maxHeight={maxHeight()}
      wrapMode="word"
      keyBindings={KEY_BINDINGS}
      textColor={theme.text}
      focusedTextColor={theme.text}
      backgroundColor={theme.backgroundPanel}
      focusedBackgroundColor={theme.backgroundElement}
      cursorColor={theme.text}
      onContentChange={report}
      onPaste={paste}
      onSubmit={() => props.onSubmit()}
    />
  );
}
