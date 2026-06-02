# DevFlow Progress
_Last updated: 2026-06-02_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md` and `new_spec.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, provider integration direction, and implementation order are captured in `HANDOFF_2.md`, `new_spec.md`, and `.agent/task_progress.md`.
- Node/TypeScript CLI scaffold is in place with strict ESM TypeScript, `devflow` bin mapping, `tsup`, package lock, runtime/dev dependencies, and repo `.gitignore`.
- CLI/bootstrap foundation is complete:
  - `src/cli.ts` handles free-form task parsing, help/version passthrough, Git-root resolution through `src/projectRoot.ts`, provider/model overrides, first-run provider setup, and concise provider/session error mapping
  - repo-local default-provider config is strictly validated, persisted through the state facade, and repaired with clear malformed-config guidance
- `.devflow` state boundary is complete:
  - `src/devflowState.ts` owns config, shared project context, run creation, canonical run paths, immutable intent/PRD/validation artifacts, normalized issue markdown writes, grill transcripts/checkpoints, and provider-session recovery metadata
  - duplicate writes, malformed config/context/metadata/session state, invalid issue slugs, and invalid run ids surface as typed domain errors
- Project-context freshness and bootstrap are complete:
  - `.devflow/project-context.md` is bounded and paired with metadata carrying `generatedAt`, baseline `gitHead`, `dirtyFingerprint`, `contextVersion`, and `refreshReason`
  - Git freshness compares committed changes since baseline plus streamed staged/unstaged/untracked dirty fingerprints, while hardcoded ignores are limited to DevFlow/agent/Git internal paths
  - bootstrap reuses fresh context, repairs missing/invalid metadata without provider work, generates or refreshes stale context through the provider, validates candidates, supports repair, and records provenance: `reused`, `generated`, `refreshed`, or `metadata-updated`
- Managed-session adapter foundation is complete:
  - built-in Claude, Gemini, Codex, and OpenCode identity metadata lives in `src/adapters/providers.ts`
  - adapters expose discovery, `runSession(...)`, optional `resumeSession(...)`, validation callbacks, repair/continuation config, normalized provider events, capabilities, and typed lifecycle failures
  - provider discovery preserves canonical ordering, degrades unavailable/failing providers safely, and remains testable through injected factories
- PTY fallback transport is complete:
  - `src/adapters/ptyManagedSessionRunner.ts` launches provider CLIs, mirrors output, scans ANSI-stripped bounded output for fallback markers, validates artifacts, sends cleanup, and supports same-session repair/continuations
  - TTY stdin raw-mode bridging, first/second Ctrl-C behavior, terminal resize forwarding, launch failures, incomplete sessions, interruptions, cleanup failures, transcript callbacks, and event callback failures are typed and covered
- Provider event/capability architecture is complete:
  - normalized events are `session-start`, `submitted-user-message`, `turn-completed`, and `session-completed`
  - provider-specific hook/JSONL schemas stay inside adapters; orchestration sees provider-neutral events with source, structured/unstructured status, provider session ids, submitted-message origin, and phase metadata
  - completion markers are authoritative from structured `turn-completed.assistantMessage` for structured providers and from terminal output only for PTY fallback providers
- Structured provider sources are complete for Codex:
  - Codex hook mode is the default structured data plane, with PTY used only for control transport
  - Codex JSONL mode is selectable internally, discovers scoped rollout logs, tails with watcher-backed offset reads, normalizes rollout records, supports fresh launch and resume, and preserves PTY interactivity
  - Codex resume uses `codex resume` with reliable provider session ids for hook and JSONL selected data planes
- Structured provider sources are complete for Claude:
  - Claude hook mode normalizes `SessionStart`, `UserPromptSubmit`, and `Stop`, uses scoped hook artifacts/settings, classifies managed vs human submissions, preserves PTY control behavior, reports provider session ids, and supports resume through Claude's native `--resume`
  - Claude JSONL mode is explicitly selectable, uses scoped provider home and credential seeding without hook settings, discovers fresh/resume transcripts under the scoped home, tails from offset 0 or resume end offset, normalizes assistant/user records, supports JSONL resume, and reports JSONL capabilities only for that selected path
  - Claude adapter contract coverage locks hook/JSONL/PTY fallback routing, selected-path capabilities, no source mixing, and no automatic hook-failure relaunch into JSONL
- Structured grill transcript capture is complete:
  - `src/grillTranscriptRecorder.ts` records assistant content from `turn-completed.assistantMessage`, records only human-origin submitted messages, excludes managed/unknown submissions, strips active markers and post-marker text, and keeps capture open through accepted repair discussion
  - structured transcript failures remain `ProviderSessionTranscriptCaptureError`, distinct from provider event capture failures and retryable through provider-backed stage retry
- Provider session recovery is complete:
  - runs persist advisory `provider-session.json` with provider identity, optional reliable provider session id, phase metadata, status, and timestamps
  - recovery uses durable artifacts first; malformed/stale provider-session state degrades to completed grill/PRD artifacts where possible
  - resumable reliable adapters can recover interrupted grill and PRD phases before falling back to fresh partial-transcript grill or PRD-only synthesis
- Active provider-backed stages are complete through PRD:
  - intent writes and strictly validates `intent.json`, supports one in-session repair, and has a two-attempt whole-stage retry budget
  - grill always runs after intent/bootstrap, asks one question at a time, persists `grill-transcript.md`, writes/recreates durable `grill-checkpoint.json`, resumes reliable interrupted sessions when possible, and avoids repeating completed interviews
  - PRD synthesis continues in the accepted live grill session when healthy, writes canonical `prd.md`, validates non-empty content, supports targeted repair, resumes reliable interrupted PRD sessions, and falls back to PRD-only synthesis from completed grill artifacts
  - provider-backed retry classification keeps interruptions and cleanup failures non-retryable while allowing incomplete sessions, launch/event/transcript capture failures, and artifact validation failures to retry
- Issue decomposition is complete:
  - run paths expose the run-scoped `issues/` directory, and the orchestrator runs a real provider-backed `issues` stage after `prd` and before placeholder `execute`/`validate`
  - `prompts/issues.md` gives providers the canonical PRD path, project-context path, issues directory, and completion marker; it requires direct markdown issue writes, vertical slices, acceptance criteria, blocked-by sibling slugs, HITL/AFK tags, and one headless self-critique without external skills or tracker publishing
  - `validateIssueArtifacts()` enforces only the ADR-0009 durable contract: at least one non-empty markdown file in the issues directory
  - issue sessions support same-session targeted repair, two-attempt whole-stage retry with clean issues-directory retry setup, provider-session diagnostic metadata, and no issue-session resume
  - regression coverage locks the fixed stage order and proves downstream placeholder stages do not read, parse, rewrite, delete, mark complete, or otherwise consume provider-authored issue files
- Maintainer documentation/tests now pin structured provider constraints, structured grill transcript policy, and provider-native boundary isolation.

## Current State
- The working pipeline is active through `intent`, `bootstrap`, `grill`, `prd`, and `issues`.
- `execute` and `validate` remain stage-order placeholders in `src/orchestrator.ts`; they start for progress reporting but do not yet consume issues or write execution/validation artifacts.
- Gemini, OpenCode, and Claude PTY fallback sessions remain PTY-marker/transcript fallback providers without reliable provider session ids or resume support.
- Codex hook/JSONL and Claude hook/JSONL structured paths use PTY as control transport and normalized provider events as the data plane.
- No AFK issues remain in the project-context freshness, managed-session/retry, bootstrap, grill/PRD, issue decomposition, structured transcript, provider-session recovery, Codex JSONL resume, Claude hook-mode, or Claude JSONL workstreams from `.agent/task_progress.md`.
- Latest verification: `npm run test` on 2026-06-01 passed with 359 tests.

## Remaining MVP Tasks
1. Activate execution:
  - run each MVP issue sequentially through provider-backed sessions
  - pass bounded context, PRD, issue content, and prior issue outputs
  - record execution summaries without inventing success when provider work fails
2. Activate validation:
  - run configured or inferred lint/tests/build checks
  - retry failed validation once through the provider
  - write `validation.json` and escalate clearly after the second failure
3. Finish MVP CLI UX:
  - expose concise stage progress
  - map new stage/artifact validation failures to user-facing errors
  - produce a final run summary with artifact paths and next manual steps
4. Future provider work:
  - keep PTY marker completion and transcript callbacks as fallback behavior
  - graduate Gemini and OpenCode from PTY fallback only when their structured sources can truthfully support the normalized event contract
