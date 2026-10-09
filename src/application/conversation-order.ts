/** Shared conversation comparator for history, transcript pages and exports. */
export function compareConversationOrder(
  a: {
    readonly turnSequence: number;
    readonly position: number;
    readonly seq?: number;
  },
  b: {
    readonly turnSequence: number;
    readonly position: number;
    readonly seq?: number;
  },
): number {
  return (
    a.turnSequence - b.turnSequence ||
    a.position - b.position ||
    (a.seq ?? 0) - (b.seq ?? 0)
  );
}
