import {
  createDevFlowState,
  type DevFlowState,
} from "./devflowState.js";

export interface ResolvedExecutionRequest {
  projectRoot: string;
  rawTask: string;
  providerId?: string;
  model?: string;
}

export interface RunExecutionRequestOptions {
  devFlowState?: DevFlowState;
}

const NOT_IMPLEMENTED_MESSAGE =
  "Execution orchestration is not implemented yet.";

export class OrchestratorNotImplementedError extends Error {
  readonly request: ResolvedExecutionRequest;

  constructor(request: ResolvedExecutionRequest) {
    super(NOT_IMPLEMENTED_MESSAGE);
    this.name = "OrchestratorNotImplementedError";
    this.request = request;
  }
}

export async function runExecutionRequest(
  request: ResolvedExecutionRequest,
  options: RunExecutionRequestOptions = {},
): Promise<void> {
  const devFlowState =
    options.devFlowState ?? createDevFlowState({ projectRoot: request.projectRoot });
  const projectContext = await devFlowState.readProjectContext();
  const run = await devFlowState.createRun();

  await run.writeIntent(
    JSON.stringify(
      {
        rawTask: request.rawTask,
        ...(request.providerId ? { providerId: request.providerId } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(projectContext ? { projectContext } : {}),
      },
      null,
      2,
    ),
  );

  throw new OrchestratorNotImplementedError(request);
}

export function formatOrchestratorError(
  error: OrchestratorNotImplementedError,
): string {
  return [
    error.message,
    `Project root: ${error.request.projectRoot}`,
    `Task: ${error.request.rawTask}`,
  ].join("\n");
}
