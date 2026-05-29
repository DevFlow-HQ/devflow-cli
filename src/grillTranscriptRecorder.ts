import stripAnsi from "strip-ansi";

import {
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
} from "./adapters/managedSessionAdapter.js";
import type { ProviderIdentity } from "./adapters/providers.js";

export interface GrillTranscriptArtifact {
  appendProviderMessage(content: string): Promise<void>;
  appendUserMessage(content: string): Promise<void>;
  complete(): Promise<void>;
}

export interface StructuredGrillTranscriptRecorder {
  recordEvent(event: ManagedProviderSessionEvent): Promise<void>;
  acceptCompletion(): Promise<void>;
}

export interface StructuredGrillTranscriptRecorderOptions {
  provider: ProviderIdentity;
  artifact: GrillTranscriptArtifact;
  getActiveCompletionMarker(): string | undefined;
}

export function createStructuredGrillTranscriptRecorder(
  options: StructuredGrillTranscriptRecorderOptions,
): StructuredGrillTranscriptRecorder {
  let captureOpen = false;
  let closed = false;

  async function recordEvent(event: ManagedProviderSessionEvent): Promise<void> {
    if (closed) {
      return;
    }

    if (event.type === "turn-completed") {
      if (event.assistantMessage === undefined) {
        return;
      }

      captureOpen = true;
      const transcriptContent = stripCompletionMarker(
        event.assistantMessage,
        options.getActiveCompletionMarker(),
      );

      if (isEmptyTranscriptBlock(transcriptContent)) {
        return;
      }

      await capture(() =>
        options.artifact.appendProviderMessage(transcriptContent),
      );
      return;
    }

    if (
      event.type !== "submitted-user-message" ||
      !captureOpen ||
      event.origin !== "human"
    ) {
      return;
    }

    if (isEmptyTranscriptBlock(event.message)) {
      return;
    }

    await capture(() => options.artifact.appendUserMessage(event.message));
  }

  async function acceptCompletion(): Promise<void> {
    if (closed) {
      return;
    }

    await capture(() => options.artifact.complete());
    closed = true;
  }

  async function capture(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      throw new ProviderSessionTranscriptCaptureError(options.provider, error);
    }
  }

  return {
    recordEvent,
    acceptCompletion,
  };
}

function stripCompletionMarker(content: string, marker: string | undefined): string {
  if (!marker) {
    return content;
  }

  const markerIndex = content.indexOf(marker);

  return markerIndex === -1 ? content : content.slice(0, markerIndex);
}

function isEmptyTranscriptBlock(content: string): boolean {
  return stripAnsi(content)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim().length === 0;
}
