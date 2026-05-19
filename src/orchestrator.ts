export interface ResolvedExecutionRequest {
  projectRoot: string;
  rawTask: string;
  providerId?: string;
  model?: string;
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
): Promise<void> {
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
