# DevFlow Progress
_Last updated: 2026-06-06_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md` and `new_spec.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, provider integration direction, and implementation order are captured in `HANDOFF_2.md`, `new_spec.md`, and `.agent/task_progress.md`.
- Node/TypeScript CLI scaffold is in place with strict ESM TypeScript, `devflow` bin mapping, `tsup`, package lock, runtime/dev dependencies, and repo `.gitignore`.
- CLI/bootstrap foundation is complete:
  - `src/cli.ts` handles free-form task parsing, help/version passthrough, Git-root resolution through `src/projectRoot.ts`, provider/model overrides, first-run provider setup, and concise provider/session error mapping
  - repo-local default-provider config is strictly validated, persisted through the state facade, and repaired with clear malformed-config guidance
- `.devflow` state boundary is complete:
  - `src/devflowState.ts` owns config, shared project context, run creation, canonical run paths, immutable intent/PRD/execution artifacts, normalized issue markdown writes, grill transcripts/checkpoints, diagnostic log paths, and provider-session recovery metadata
  - duplicate writes, malformed config/context/metadata/session state, invalid issue slugs, and invalid run ids surface as typed domain errors
  - repo-local state initialization appends `.devflow/` to target Git repositories' `.gitignore` idempotently, preserves existing content, and skips non-Git projects
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
  - run paths expose the run-scoped `issues/` directory, and the orchestrator runs a real provider-backed `issues` stage after `prd` and before `execute`
  - `prompts/issues.md` gives providers the canonical PRD path, project-context path, issues directory, and completion marker; it requires direct markdown issue writes, vertical slices, acceptance criteria, blocked-by sibling slugs, HITL/AFK tags, and one headless self-critique without external skills or tracker publishing
  - `validateIssueArtifacts()` enforces only the ADR-0009 durable contract: at least one non-empty markdown file in the issues directory
  - issue sessions support same-session targeted repair, two-attempt whole-stage retry with clean issues-directory retry setup, provider-session diagnostic metadata, and no issue-session resume
  - regression coverage locks provider-owned issue decomposition and proves downstream execution does not parse, rewrite, delete, mark complete, or otherwise arbitrate provider-authored issue files
- Execution stage activation is complete:
  - managed sessions accept iteration and terminal completion markers, report the matched marker, and give terminal markers precedence across structured assistant events and PTY fallback output
  - `prompts/execute.md` and `prompts/tdd.md` provide the execution prompt package with open issue contents, recent commit context, canonical PRD/project-context/TDD path references, AFK/HITL movement rules, and provider-owned issue selection
  - state exposes recent commit/head ground truth plus immutable `execution.json` ledgers with per-iteration marker/session/head records and final stop/issue-filename summaries
  - the orchestrator runs a bounded fresh-session execute loop, captures the initial active issue count once, stops on terminal/no-file success, writes cap/error ledgers before surfacing failures, and never resumes execution sessions
  - the CLI exposes execution-iteration boundaries, maps cap/error stops to clear failures, and keeps upstream grill/PRD/issues artifacts intact after execute failures
- MVP CLI UX is complete:
  - the pipeline stage list is `intent`, `bootstrap`, `grill`, `prd`, `issues`, and `execute`; the `validate` placeholder, runner, `validation.json` artifact mapping, and writer are removed
  - the CLI prints plain stage-start one-liners, maps stage/artifact validation and retry exhaustion errors to user-facing messages, and routes unexpected failures through redacted terminal errors with diagnostic correlation refs
  - successful and failed execute-stage stops render a Run summary from on-disk `execution.json`, including artifact paths, completed/remaining issue filenames, stop reason, next steps, and wrapped per-iteration final assistant messages with `(no summary available)` fallback
- Diagnostic logging is complete:
  - `src/logger.ts` provides injected JSONL logging with `debug`/`info`/`warn`/`error`/`critical`, append-only daily files, critical correlation refs, full serialized errors for `error`/`critical`, repo-local-to-home fallback, never-throw behavior, and 30-day startup pruning
  - CLI failures are split cleanly: anticipated typed failures log at `error` while keeping tailored terminal messages; unexpected fall-throughs log at `critical` and print only a generic message, correlation ref, and diagnostic log path
  - the orchestrator emits `info` lifecycle entries for run/stage/iteration/summary milestones and `warn` entries for retries, repairs, provider-session recovery, artifact fallback recovery, stale-context refreshes, and repaired config/metadata
  - adapter-deep `debug` traces now cover metadata-only data-plane resolution, structured events, marker matches/misses, phase transitions, PTY spawn/exit/events, hook socket lifecycle, malformed hook payloads, and Codex/Claude JSONL session-log locator resolution without copying prompt, payload, transcript, or log bodies
- Completion-marker prompt discipline is complete:
  - `CONTEXT.md` defines completion markers as DevFlow's authoritative per-stage done signal and defines grill conclusion confirmation as the grill-only approval handshake before marker emission
  - `intent`, `bootstrap-project-context`, `prd`, `issues`, and execute prompts now explain exactly-once marker emission, immediate DevFlow advancement, no further turns for completed work, and omission/premature-emission failure modes
  - grill prompts require a marker-free conclusion question, resolution of any remaining user concerns, and a marker-only completion turn after explicit approval to conclude
  - interrupted grill/PRD resume prompts plus intent, bootstrap, PRD, and issues repair prompts carry the same critical marker guidance, with stable prompt-rendering/orchestrator coverage
- Maintainer documentation/tests now pin structured provider constraints, structured grill transcript policy, and provider-native boundary isolation.

## Current State
- The working pipeline is active through `intent`, `bootstrap`, `grill`, `prd`, `issues`, and `execute`.
- MVP no longer includes a `validate` stage; `execute` is the terminal provider-backed stage.
- Gemini, OpenCode, and Claude PTY fallback sessions remain PTY-marker/transcript fallback providers without reliable provider session ids or resume support.
- Codex hook/JSONL and Claude hook/JSONL structured paths use PTY as control transport and normalized provider events as the data plane.
- No AFK issues remain in the project-context freshness, managed-session/retry, bootstrap, grill/PRD, issue decomposition, execution, MVP CLI UX, structured transcript, provider-session recovery, Codex JSONL resume, Claude hook-mode, Claude JSONL, diagnostic logging, or completion-marker prompt workstreams from `.agent/task_progress.md`.
- Latest task-progress entry: `05-session-log-locator-resolution` is complete.

## Known Remaining Work
1. Future provider work:
  - keep PTY marker completion and transcript callbacks as fallback behavior
  - defer Gemini and OpenCode from supported MVP claims; keep them documented as PTY fallback/experimental until their structured sources can truthfully support the normalized event contract
2. PTY duplication audit:
  - review Codex hook/JSONL, Claude hook/JSONL, and fallback PTY control paths for duplicated runner/control logic before release
3. Release/docs readiness:
  - replace the current bad `README.md`, clean package metadata, and point `package.json` `main` at `dist/cli.js`
4. End-to-end testing (HITL):
  - run real provider smoke tests through tiny repositories for Codex/Claude happy paths, resume behavior, execute loop stops, and HITL/AFK issue handling
