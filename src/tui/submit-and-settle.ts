import { createSignal, type Accessor } from "solid-js";
import type {
  OperationSnapshot,
  Problem,
  ProjectionPort,
  Submission,
} from "../application/projection-port.js";

/** A submitted Operation as a write seam observes it: `pending` until it settles,
 *  then `applied` or `refused` (a not-admitted or not-applied Problem). */
export type SettleOutcome =
  | { readonly kind: "pending" }
  | {
      readonly kind: "applied";
      readonly modelChoiceChange?: OperationSnapshot["modelChoiceChange"];
    }
  | { readonly kind: "refused"; readonly problem: Problem };

/** Submit intent and translate the Application-owned settled receipt into a
 * reactive outcome. Admission refusals are available immediately. */
export function submitAndSettle(
  port: ProjectionPort,
  submission: Submission,
): Accessor<SettleOutcome> {
  const [outcome, setOutcome] = createSignal<SettleOutcome>({
    kind: "pending",
  });
  const admission = port.submit(submission);
  if (!admission.admitted) {
    setOutcome({ kind: "refused", problem: admission.problem });
    return outcome;
  }
  void port.settledOperation(admission.operationId).then((snapshot) => {
    if (snapshot.outcome.status === "applied") {
      setOutcome({
        kind: "applied",
        ...(snapshot.modelChoiceChange === undefined
          ? {}
          : { modelChoiceChange: snapshot.modelChoiceChange }),
      });
    } else {
      setOutcome({ kind: "refused", problem: snapshot.outcome.problem });
    }
  });
  return outcome;
}
