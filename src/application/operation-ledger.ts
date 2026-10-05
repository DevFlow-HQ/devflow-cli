import type { ApplicationObserver } from "./observer.js";
import {
  operationIdReused,
  operationNotFound,
  runExecutionFault,
} from "./problems.js";
import type {
  OpenedProjection,
  OperationOutcome,
  OperationSnapshot,
  Submission,
  SubmissionAdmission,
} from "./projection-port.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import type { UpdateStream } from "./update-stream.js";

/** Settlement carries metadata only when the effect applied. The pending state
 * belongs to the ledger, never to a settler. */
export type OperationSettlement =
  | {
      readonly status: "applied";
      readonly modelChoiceChange?: NonNullable<
        OperationSnapshot["modelChoiceChange"]
      >;
    }
  | Extract<OperationOutcome, { status: "not-applied" }>;

type OperationIdentity = Pick<Submission, "operationId" | "operation"> & {
  readonly replayKey: string;
};

type FreshAuthorization =
  | Extract<SubmissionAdmission, { admitted: false }>
  | {
      readonly admitted: true;
      readonly runId?: string;
      readonly settle: () => OperationSettlement | Promise<OperationSettlement>;
    };

interface Receipt {
  readonly identity: OperationIdentity;
  readonly admission: Extract<SubmissionAdmission, { admitted: true }>;
  snapshot: OperationSnapshot;
  readonly observers: Set<UpdateStream<OperationSnapshot>>;
}

/** Private receipt ownership. Authorization and settlement retain their domain
 * dependencies in the use case; the ledger sees only identity and receipt data. */
export class OperationLedger {
  private readonly receipts = new Map<string, Receipt>();

  constructor(
    private readonly deps: {
      readonly subscriptions: SubscriptionLifecycle;
      readonly observe: ApplicationObserver;
      readonly scheduleSettlement?: (
        settle: () => void | Promise<void>,
      ) => void | Promise<void>;
    },
  ) {}

  submit(
    identity: OperationIdentity,
    authorizeFresh: () => FreshAuthorization,
  ): SubmissionAdmission {
    const existing = this.receipts.get(identity.operationId);
    if (existing !== undefined) {
      if (
        existing.identity.operation !== identity.operation ||
        existing.identity.replayKey !== identity.replayKey
      )
        return this.refuse(identity, operationIdReused(identity.operationId));
      this.deps.observe({
        kind: "operation-admission",
        operationId: identity.operationId,
        operation: identity.operation,
        admission: "replayed",
        ...(existing.admission.runId === undefined
          ? {}
          : { runId: existing.admission.runId }),
      });
      return existing.admission;
    }
    const authorized = authorizeFresh();
    if (!authorized.admitted) return this.refuse(identity, authorized.problem);
    const admission = {
      admitted: true,
      operationId: identity.operationId,
      ...(authorized.runId === undefined ? {} : { runId: authorized.runId }),
    } satisfies Extract<SubmissionAdmission, { admitted: true }>;
    const receipt: Receipt = {
      identity,
      admission,
      snapshot: {
        family: "operation",
        operationId: identity.operationId,
        outcome: { status: "pending" },
      },
      observers: new Set(),
    };
    this.receipts.set(identity.operationId, receipt);
    this.deps.observe({
      kind: "operation-admission",
      operationId: identity.operationId,
      operation: identity.operation,
      admission: "admitted",
      ...(admission.runId === undefined ? {} : { runId: admission.runId }),
    });
    // Admission precedes even inline settlement. A scheduler can hold the work,
    // but cannot drive an admitted effect more than once.
    let started = false;
    const settle = (): void | Promise<void> => {
      if (started) return;
      started = true;
      const recordFault = (error: unknown): void =>
        this.record(receipt, {
          status: "not-applied",
          problem: runExecutionFault(
            admission.runId,
            error,
            identity.operationId,
          ),
        });
      try {
        const result = authorized.settle();
        if (result instanceof Promise)
          return result.then(
            (settlement) => this.record(receipt, settlement),
            recordFault,
          );
        this.record(receipt, result);
      } catch (error) {
        recordFault(error);
      }
    };
    if (this.deps.scheduleSettlement === undefined) void settle();
    else void this.deps.scheduleSettlement(settle);
    return admission;
  }

  open(operationId: string): OpenedProjection<OperationSnapshot> {
    const receipt = this.receipts.get(operationId);
    const updates = this.deps.subscriptions.open<OperationSnapshot>(
      (updates) => {
        if (receipt?.snapshot.outcome.status !== "pending") return () => {};
        receipt.observers.add(updates);
        return () => {
          receipt.observers.delete(updates);
        };
      },
    );
    return {
      snapshot: receipt?.snapshot ?? {
        family: "operation",
        operationId,
        outcome: {
          status: "not-applied",
          problem: operationNotFound(operationId),
        },
      },
      catchUp: "fresh",
      updates,
      close() {
        updates.close();
      },
    };
  }

  private refuse(
    identity: OperationIdentity,
    problem: Extract<SubmissionAdmission, { admitted: false }>["problem"],
  ): SubmissionAdmission {
    this.deps.observe({
      kind: "operation-admission",
      operationId: identity.operationId,
      operation: identity.operation,
      admission: "not-admitted",
      code: problem.code,
    });
    return { admitted: false, problem };
  }

  private record(receipt: Receipt, settlement: OperationSettlement): void {
    const outcome: OperationOutcome =
      settlement.status === "applied" ? { status: "applied" } : settlement;
    receipt.snapshot = {
      family: "operation",
      operationId: receipt.identity.operationId,
      outcome,
      ...(settlement.status === "applied" &&
      settlement.modelChoiceChange !== undefined
        ? { modelChoiceChange: settlement.modelChoiceChange }
        : {}),
    };
    this.deps.observe({
      kind: "operation-outcome",
      operationId: receipt.identity.operationId,
      operation: receipt.identity.operation,
      outcome: settlement.status,
      ...(receipt.admission.runId === undefined
        ? {}
        : { runId: receipt.admission.runId }),
      ...(settlement.status === "not-applied"
        ? { code: settlement.problem.code }
        : {}),
    });
    for (const observer of receipt.observers)
      observer.push({ kind: "durable", snapshot: receipt.snapshot });
    // Idle receipts stay open in SubscriptionLifecycle without retaining a
    // producer registration. Shutdown and later explicit opens share its policy.
    receipt.observers.clear();
  }
}
