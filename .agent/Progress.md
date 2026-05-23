# DevFlow Progress
_Last updated: 2026-05-23_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript CLI scaffold exists with strict ESM TypeScript, `devflow` bin mapping, `tsup` build config, repo `.gitignore`, package lock, and installed runtime/dev dependencies.
- Completed the adapter and discovery foundation across `src/adapters/`:
  - `managedSessionAdapter.ts` defines the shared managed-session detect/runSession contract for Claude, Gemini, Codex, and OpenCode
  - `commandManagedSessionAdapter.ts` implements reusable command-backed detection and the intentional managed-session not-implemented boundary
  - built-in adapters wire each provider through that shared contract
  - `builtInManagedSessionAdapter.ts` and `providerDiscovery.ts` expose built-in managed-session selection plus concurrent installed-provider discovery with stable CLI-facing results
- Completed done issues `001` through `004` under `.agent/issues/done/`:
  - OpenCode now has first-class built-in adapter parity using the canonical `opencode` executable
  - discovery aggregates providers in canonical order, preserves available executable metadata, and supports injected adapter factories for tests
  - unsupported or failing providers degrade into user-safe unavailable entries, with optional internal `debugReason` diagnostics
  - regression coverage locks adapter and discovery behavior so future CLI work can depend on a stable contract
- Completed done issues `001` through `007` for the CLI bootstrap slice:
  - `src/cli.ts` provides the real `commander` entrypoint with free-form task parsing, help/version passthrough, and clear missing-task failures
  - `src/projectRoot.ts` resolves the Git repo root when present and falls back to the current working directory outside Git
  - `src/repoConfig.ts` validates repo-local `.devflow/config.json` with a strict schema, preserves valid saved defaults, and rejects malformed config with repair guidance
  - `src/bootstrapProvider.ts` implements first-run provider setup, cancellation without side effects, and strict `--provider` override semantics
  - `--model` is accepted as an opaque invocation-only string and passed unchanged into the resolved orchestrator request
  - `src/orchestrator.ts` receives a pinned bootstrap handoff object from the CLI, with the structured not-implemented failure shape locked by regression tests
- Added regression coverage in `tests/adapters/managedSessionAdapter.contract.test.ts`, `tests/adapters/providerDiscovery.test.ts`, `tests/cli.test.ts`, and `tests/repoConfig.test.ts` for provider behavior, discovery ordering, task parsing, project-root resolution, provider precedence, first-run persistence, strict config/override failures, and orchestrator request shape.
- Completed the `.devflow` filesystem state-boundary stream from `.agent/task_progress.md` issues `001` through `010`:
  - `src/devflowState.ts` owns repo-local config persistence behind `createDevFlowState({ projectRoot })`, with typed `config.load()`/`config.save()` APIs and malformed persisted config surfaced as `InvalidDevFlowConfigError`
  - the state facade owns shared project context through canonical `readProjectContext()` and `writeProjectContext(content)` operations
  - `createRun()` creates isolated `.devflow/runs/<opaque-id>/` records with validated 12-character run ids, typed run handles, persisted `run.json` metadata, and canonical run-directory paths
  - run handles write immutable canonical artifacts for `intent.json`, `prd.md`, `validation.json`, and normalized issue markdown files under `issues/`
  - duplicate artifact writes raise `DuplicateDevFlowRunArtifactError`; invalid issue slugs raise `InvalidDevFlowIssueSlugError`
  - the active CLI-to-orchestrator path threads the typed state facade into the orchestrator
  - `runExecutionRequest()` now creates a run, renders the markdown intent prompt with raw task, absolute artifact path, schema requirements, and nonce completion marker, invokes an injected `ProviderSessionRunner`, and validates the provider-written intent artifact
  - orchestration emits the MVP stage order: `intent`, `bootstrap`, `grill`, `prd`, `issues`, `execute`, `validate`
  - orchestration rejects missing provider ids before creating a run, invokes the intent provider runner against the canonical intent artifact path, and leaves PRD, issue, validation, and downstream artifacts absent for no-op stages
  - missing, invalid JSON, and schema-invalid intent artifacts each trigger exactly one explicit repair prompt that may replace the invalid provider-owned artifact
  - failed intent repair raises `StageArtifactValidationError`
- Added regression coverage in `tests/devflowState.test.ts` and `tests/orchestrator.test.ts` for config validation, shared project context semantics, run creation, artifact immutability, issue slug normalization, duplicate-write failures, bootstrap/orchestrator compatibility, provider-session-backed intent, MVP stage ordering, missing-provider rejection, no-op downstream stages, one-shot artifact repair, and structured validation failures.
- Verified the state-boundary slice with `npm run test` (65 passing tests), `npm run typecheck`, and `npm run build`.
- Wrote `.agent/prd.md` for the managed-session adapter contract migration:
  - replace one-shot provider adapter semantics with managed-session adapter semantics
  - extract neutral provider metadata into `providers.ts`
  - rename shared/core adapter modules to managed-session vocabulary while keeping individual provider modules unless they become confusing
  - keep provider discovery focused on availability detection
  - defer real PTY transport to the next checkpoint
- Completed the managed-session contract and wiring migration:
  - neutral provider identity metadata now lives outside the managed-session execution contract
  - shared/core adapter module names and factory seams now use managed-session vocabulary
  - adapters expose discovery plus `runSession(...)`, validation callbacks, optional in-session repair prompts, typed lifecycle failures, and structured success metadata
  - provider discovery stays focused on availability detection and canonical built-in ordering
  - the orchestrator resolves managed-session adapters through an injectable factory, validates built-in provider ids before run creation, and delegates intent artifact validation plus one targeted repair to the managed session
  - the CLI handles adapter-layer lifecycle failures as concise user-facing errors
- Completed the PTY-based managed-session checkpoint:
  - added `node-pty` and `strip-ansi`, plus `src/adapters/ptyManagedSessionRunner.ts` for command-backed interactive sessions
  - built-in Claude, Gemini, Codex, and OpenCode adapters now resolve executables, pass opaque model overrides through provider-native flags, launch via the shared PTY runner, and issue provider cleanup commands
  - PTY output is mirrored to stdout, stripped for bounded completion-marker scanning, and validated before cleanup
  - TTY stdin is bridged in raw mode, first Ctrl-C is forwarded to the provider, second Ctrl-C kills the child, and interrupted sessions are reported with typed errors
  - terminal resize events are forwarded when supported
  - invalid intent artifacts can be repaired inside the same PTY session with a repair marker; failed repair maps to `StageArtifactValidationError`
  - the active intent stage can now complete through a built-in provider adapter with fake PTY execution in tests
- Added PTY/session regression coverage in `tests/adapters/ptyManagedSessionRunner.test.ts`, `tests/adapters/managedSessionAdapter.contract.test.ts`, `tests/cli.test.ts`, and `tests/orchestrator.test.ts` for launch failures, cleanup failures, incomplete markers, interrupts, resize forwarding, in-session repair, provider args/model wiring, and built-in intent execution.
- Verified the PTY/session slice with `npm run test` (96 passing tests), `npm run typecheck`, and `npm run build`.

## Current State
- The repo now has a working CLI/bootstrap/state/orchestration boundary across `src/cli.ts`, `src/projectRoot.ts`, `src/bootstrapProvider.ts`, `src/devflowState.ts`, `src/orchestrator.ts`, provider session code, and `src/adapters/`.
- Built-in provider discovery, repo-root resolution, repo-local default-provider state, explicit provider/model override handling, first-run provider selection, shared context storage, run creation, immutable run artifact writes, MVP stage ordering, PTY-backed managed sessions, strict intent validation, and in-session intent repair are implemented and regression-tested.
- The MVP pipeline currently has only intent active; bootstrap, grill, PRD, issues, execute, and validate are observable no-op placeholders that do not write fake artifacts.
- The managed-session contract, PTY transport, CLI error mapping, and active intent-stage adapter path are complete enough for local provider-backed intent runs.
- There are no remaining AFK tasks in the `.devflow` filesystem state-boundary workstream from `.agent/task_progress.md`.

## Next Checkpoint
1. Add orchestrator-level whole-stage retry:
  - Treat artifact repair and whole-stage retry as separate policies.
  - After PTY session failures are typed, add orchestrator-level retry around provider-backed stages when `runSession(...)` throws or a stage fails.
  - Keep the in-session artifact repair path for marker-plus-invalid-artifact failures that need provider context.

2. Project context freshness before expanding bootstrap:
  - Add `.devflow/project-context.meta.json`.
  - Store `generatedAt`, `gitHead`, `dirtyFingerprint`, `contextVersion`, and `refreshReason`.
  - Use Git diff/status with context-relevant path rules to decide whether `.devflow/project-context.md` is fresh.
  - Include uncommitted changes via a dirty fingerprint so repeated runs do not refresh for the same dirty tree.
  - In non-Git repos, fall back to missing metadata/context and max age checks.
  - Use a 3-day max age.
