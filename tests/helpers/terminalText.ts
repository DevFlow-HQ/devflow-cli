/** SGR, OSC hyperlinks, BEL, BS, C1 CSI/ST, C0 controls, DEL, Unicode formats and bare CR. */
export const UNTRUSTED_TERMINAL_TEXT =
  "\u001b[31mA\u001b[0m\u001b]8;;https://example.com\u0007B\u001b]8;;\u0007\u0007\b\u009b31mC\u009c\u0000\u000b\f\u007f\u0085\u061c\u202e\u2066\u200b\u{e0001}\r";
export const UNSAFE_TERMINAL_CHARACTERS = /[^\P{Cc}\n\t]|\p{Cf}/u;
