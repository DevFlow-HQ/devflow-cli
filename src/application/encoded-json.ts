// Exact UTF-8 byte counts of `JSON.stringify` output for plain data, computed
// without serializing a copy. Session history budgets its deliveries in these
// bytes (#490), so escaping and multibyte text cannot pass the allowance.

/** Encoded bytes of one code point (or lone surrogate) at `index`, and its width. */
function codePoint(
  text: string,
  index: number,
): [bytes: number, units: number] {
  const unit = text.charCodeAt(index);
  if (unit < 0x20)
    return [
      unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13
        ? 2
        : 6,
      1,
    ];
  if (unit === 0x22 || unit === 0x5c) return [2, 1];
  if (unit < 0x80) return [1, 1];
  if (unit < 0x800) return [2, 1];
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    // A well-formed pair is four bytes; a lone surrogate is escaped as \uXXXX.
    return next >= 0xdc00 && next <= 0xdfff ? [4, 2] : [6, 1];
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) return [6, 1];
  return [3, 1];
}

/** The quoted JSON string's encoded bytes. */
export function encodedStringBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length;) {
    const [size, units] = codePoint(text, index);
    bytes += size;
    index += units;
  }
  return bytes;
}

/** `Buffer.byteLength(JSON.stringify(value))` for plain JSON-shaped data. */
export function encodedJsonBytes(value: unknown): number {
  if (typeof value === "string") return encodedStringBytes(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (value === null || typeof value !== "object") return 4;
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value)
      bytes += item === undefined ? 4 : encodedJsonBytes(item);
    return bytes;
  }
  let bytes = 2,
    fields = 0;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function") continue;
    bytes += encodedStringBytes(key) + 1 + encodedJsonBytes(item);
    fields++;
  }
  return bytes + Math.max(0, fields - 1);
}

/** The value when its quoted encoding fits both limits; otherwise its longest
 * whole-code-point prefix that fits with a trailing ellipsis. */
export function fitEncoded(text: string, units: number, bytes: number): string {
  if (text.length <= units && encodedStringBytes(text) <= bytes) return text;
  // Reserve the quotes and the three-byte, one-unit ellipsis.
  let used = 2 + 3,
    end = 0;
  while (end < text.length) {
    const [size, width] = codePoint(text, end);
    if (end + width > units - 1 || used + size > bytes) break;
    used += size;
    end += width;
  }
  return text.slice(0, end) + "…";
}
