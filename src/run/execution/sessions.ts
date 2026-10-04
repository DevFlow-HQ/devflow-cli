import {
  agentCompletionCalls,
  flattenSteps,
  FRESH_SESSION,
  type AgentStep,
  type RoutingNode,
  type Step,
} from "../../workflow/workflow.js";
import type { AgentCallDeclaration } from "../../harness/harness.js";

/** Fresh Sessions and interactive Repeat Sessions belong to one Attempt. */
function sharesNamedSession(
  routing: readonly RoutingNode[],
  step: AgentStep,
): boolean {
  return (
    step.session !== FRESH_SESSION &&
    (step.kind === "agent" ||
      !routing.some(
        (node) =>
          "repeat" in node && node.repeat.steps.some((s) => s.id === step.id),
      ))
  );
}

export function attemptSession(
  routing: readonly RoutingNode[],
  step: AgentStep,
  attemptId: string,
): string {
  return sharesNamedSession(routing, step)
    ? step.session
    : `${step.session}-${attemptId}`;
}

/** Bind the fixed tool union to actual Session sharing, including Attempt scope. */
export function sessionAgentCalls(
  routing: readonly RoutingNode[],
  step: Step,
): readonly AgentCallDeclaration[] {
  if (step.kind !== "agent" && step.kind !== "interactive-agent") return [];
  const steps = sharesNamedSession(routing, step)
    ? flattenSteps(routing).filter(
        (s) =>
          (s.kind === "agent" || s.kind === "interactive-agent") &&
          s.session === step.session &&
          sharesNamedSession(routing, s),
      )
    : [step];
  const calls = new Set(steps.flatMap((s) => agentCompletionCalls(routing, s)));
  return [...calls].sort().map((call) => ({
    id: `${call}_done`,
    description: `Declare the ${call} done with a one-line reason. Takes effect when this Turn finishes cleanly.`,
    maxReasonLength: 400,
  }));
}
