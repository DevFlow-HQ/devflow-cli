/** Layout coordinates stay local to each reader. Keys never cross between live
 * Session history and retained transcript entries. */
export interface ContentRow {
  readonly key: string;
  readonly height: number;
  readonly prefix: number;
}

export interface ContentAnchor {
  readonly id: string | undefined;
  /** Zero names the content header; negative offsets name leading decorations. */
  readonly offset: number;
  readonly prior: readonly string[];
}

/** Capture a displayed line relative to its keyed row's content. */
export function contentAnchorAt(
  top: number,
  rows: readonly ContentRow[],
): ContentAnchor {
  let index = 0;
  let line = Math.max(0, top);
  while (index + 1 < rows.length && line >= rows[index]!.height) {
    line -= rows[index]!.height;
    index++;
  }
  const row = rows[index];
  return {
    id: row?.key,
    offset: row === undefined ? 0 : Math.min(line, row.height - 1) - row.prefix,
    prior: rows.map((row) => row.key),
  };
}

/** Resolve a survivor, clamping only within that row. A missing key falls to the
 * nearest survivor in the previous ordering, ties later, at its first display
 * line. With no survivor, the first row (including its dividers) stays visible. */
export function resolveContentAnchor(
  held: ContentAnchor,
  rows: readonly ContentRow[],
) {
  const retained = rows.findIndex((row) => row.key === held.id);
  let index = retained;
  if (index < 0) {
    index = 0;
    const previous = held.prior.findIndex((key) => key === held.id);
    let distance = Infinity;
    if (previous >= 0)
      for (const [priorIndex, key] of held.prior.entries()) {
        const current = rows.findIndex((row) => row.key === key);
        const next = Math.abs(priorIndex - previous);
        if (current >= 0 && next <= distance) {
          distance = next;
          index = current;
        }
      }
  }
  const row = rows[index];
  const offset =
    row === undefined
      ? 0
      : retained < 0
        ? -row.prefix
        : Math.max(
            -row.prefix,
            Math.min(held.offset, row.height - row.prefix - 1),
          );
  const top =
    rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) +
    (row?.prefix ?? 0) +
    offset;
  return {
    row: index,
    top,
    anchor: {
      id: row?.key,
      offset,
      prior: rows.map((row) => row.key),
    } satisfies ContentAnchor,
  };
}
