import type { TurnFact } from "../../src/run/store/store.js";

/** The data a Turn fact of `K` carries. */
export type TurnFactData<K extends TurnFact["kind"]> = Extract<
  TurnFact,
  { kind: K }
>["data"];

/** One Turn fact from a fixture's kind and its data, typed against that kind. */
export function turnFact<K extends TurnFact["kind"]>(
  kind: K,
  data: TurnFactData<K>,
): TurnFact {
  // The signature ties `data` to `kind`; TypeScript cannot correlate the pair here.
  return { kind, data } as TurnFact;
}
