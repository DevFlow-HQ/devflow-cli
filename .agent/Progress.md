# DevFlow Progress
_Last updated: 2026-05-22_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript package scaffold exists.
- `package.json` exists with ESM package setup, `devflow` bin mapped to `./dist/cli.js`, and scripts:
  - `build`: `tsup`
  - `dev`: `tsx src/cli.ts`
  - `test`: `tsx --test tests/*.test.ts tests/**/*.test.ts`
  - `typecheck`: `tsc --noEmit`
- Runtime deps installed/listed: `commander`, `chalk`, `ora`, `enquirer`, `execa`, `which`, `fs-extra`, `globby`, `zod`.
- Dev deps installed/listed: `typescript`, `tsx`, `tsup`, `@types/node`, `@types/fs-extra`, `@types/which`.
- `package-lock.json` and `node_modules/` are present.
- `tsconfig.json` exists with strict TypeScript, ESM, bundler module resolution, `outDir: dist`, and Node test types.
- `tsup.config.ts` exists and builds `src/cli.ts` to ESM with a Node shebang banner.
- `.gitignore` currently ignores `node_modules/`, `dist/`, and `.agent/`.
- Completed the adapter and discovery foundation across `src/adapters/`:
  - `providerAdapter.ts` defines the built-in provider registry and shared detect/run contract for Claude, Gemini, Codex, and OpenCode
  - `commandProviderAdapter.ts` implements reusable command-backed detection and interactive run behavior
  - `claudeAdapter.ts`, `geminiAdapter.ts`, `codexAdapter.ts`, and `opencodeAdapter.ts` wire the built-in providers through that shared contract
  - `builtInProviderAdapter.ts` and `providerDiscovery.ts` expose built-in selection plus concurrent installed-provider discovery with stable CLI-facing results
- Completed done issues `001` through `004` under `.agent/issues/done/`:
  - OpenCode now has first-class built-in adapter parity using the canonical `opencode` executable
  - discovery aggregates providers in canonical order, preserves available executable metadata, and supports injected adapter factories for tests
  - unsupported or failing providers degrade into user-safe unavailable entries, with optional internal `debugReason` diagnostics
  - regression coverage locks adapter and discovery behavior so future CLI work can depend on a stable contract
- Completed done issues `001` through `007` for the CLI bootstrap slice:
  - `src/cli.ts` now provides the real `commander` entrypoint with free-form task parsing, help/version passthrough, and clear missing-task failures
  - `src/projectRoot.ts` resolves the Git repo root when present and falls back to the current working directory outside Git before handing off to the orchestrator
  - `src/repoConfig.ts` validates repo-local `.devflow/config.json` with a strict schema, preserves valid saved defaults, and rejects malformed or hand-edited config with repair guidance
  - `src/bootstrapProvider.ts` implements first-run provider setup: zero-provider guidance, single-provider auto-persist, multi-provider prompt flow, and cancellation without side effects
  - `--provider` override semantics are strict: explicit override wins for the invocation only, unknown ids fail immediately, unavailable overrides fail with targeted messaging, and stale saved defaults hard-fail instead of re-prompting
  - `--model` is accepted as an opaque string, passed unchanged into the resolved orchestrator request, and never persisted to config
  - `src/orchestrator.ts` now receives a pinned bootstrap handoff object from the CLI, with the current structured not-implemented failure shape locked by regression tests
- Added regression coverage in `tests/adapters/providerAdapter.contract.test.ts` and `tests/adapters/providerDiscovery.test.ts` for provider identity, detection results, interactive run semantics, OpenCode parity, discovery ordering, availability summaries, unsupported-provider messaging, and failure degradation.
- Added regression coverage in `tests/cli.test.ts` and `tests/repoConfig.test.ts` for task parsing, project-root resolution, provider precedence, first-run persistence/prompt/cancellation behavior, strict config and override failures, exact orchestrator request shape, and repo-local config persistence/validation.
- Completed the `.devflow` filesystem state-boundary stream from `.agent/task_progress.md`:
  - `src/devflowState.ts` now owns repo-local config persistence behind `createDevFlowState({ projectRoot })`, with typed `config.load()`/`config.save()` APIs and malformed persisted config surfaced as `InvalidDevFlowConfigError`
  - the same state facade owns shared project context through canonical `readProjectContext()` and `writeProjectContext(content)` operations
  - `createRun()` creates isolated `.devflow/runs/<opaque-id>/` records with validated 12-character run ids, typed run handles, persisted `run.json` metadata, and canonical run-directory paths
  - run handles write immutable canonical artifacts for `intent.json`, `prd.md`, `validation.json`, and normalized issue markdown files under `issues/`
  - duplicate artifact writes raise `DuplicateDevFlowRunArtifactError`; invalid issue slugs raise `InvalidDevFlowIssueSlugError`
  - the active CLI-to-orchestrator path now threads the typed state facade into the orchestrator, which snapshots resolved requests through shared-context and run-handle APIs before surfacing the current stub
- Added regression coverage in `tests/devflowState.test.ts` and `tests/orchestrator.test.ts` for config validation, shared project context semantics, run creation, artifact immutability, issue slug normalization, duplicate-write failures, and bootstrap/orchestrator compatibility through the public state facade.
- Verified the current slice with `npm run test` (65 passing tests), `npm run typecheck`, and `npm run build`.

## Current State
- The repo now has a working CLI/bootstrap/state boundary across `src/cli.ts`, `src/projectRoot.ts`, `src/bootstrapProvider.ts`, `src/devflowState.ts`, `src/orchestrator.ts`, and `src/adapters/`.
- Built-in provider discovery, repo-root resolution, repo-local default-provider state, explicit provider/model override handling, first-run provider selection, shared context storage, run creation, and immutable run artifact writes are implemented and regression-tested.
- The orchestrator boundary now snapshots the resolved request into `.devflow/runs/<id>/intent.json` through the state facade, but it still raises the structured not-implemented error after that snapshot; downstream real agents and prompt files for the actual pipeline are not implemented yet.

## Next Checkpoint
- Keep the current implementation slice focused on contract-first intent orchestration:
  - expand `src/orchestrator.ts` from a stub into the sequential stage skeleton for intent → bootstrap → grill → PRD → issues → execute → validate
  - require a resolved provider id before running provider-backed stages
  - add `src/providerSessions.ts` with an injectable session-runner contract and a default managed-session-not-implemented runner
  - add `src/agents/intent.ts` and `prompts/intent.md`
  - make intent classify only the raw task, without project context
  - have the provider write `intent.json` to an absolute path and emit a nonce completion marker
  - validate `intent.json` with schema fields: `classification`, `summary`, `rawTask`, and `needsClarification`
  - allow one targeted repair attempt for missing/invalid intent artifacts
  - keep later stages as no-op placeholders for now, without writing fake PRD/issues/validation artifacts
- Intent tests should use a fake injected session runner that writes the artifact; real PTY-backed provider execution is a follow-up.

## Follow-Up
1. Project context freshness before expanding bootstrap:
  - Add `.devflow/project-context.meta.json`.
  - Store `generatedAt`, `gitHead`, `dirtyFingerprint`, `contextVersion`, and `refreshReason`.
  - Use Git diff/status with context-relevant path rules to decide whether `.devflow/project-context.md` is fresh.
  - Include uncommitted changes via a dirty fingerprint so repeated runs do not refresh for the same dirty tree.
  - In non-Git repos, fall back to missing metadata/context and max age checks.
  - Use a 3-day max age.

2. Migrate provider adapters to managed session control:
  Current provider adapters support one-shot interactive runs. DevFlow’s real pipeline needs session-oriented control so each stage can:
  - start a provider session
  - inject a stage prompt
  - remain interactive for permissions/questions
  - wait for a nonce completion marker
  - validate provider-written artifacts
  - run one targeted repair attempt when a provider-written artifact is invalid
  - inject a provider-specific exit command, such as `/exit`, when known
  - close cleanly before the next session

  MVP can add `runSession(...)` alongside the existing `run(...)` API, but the adapter layer should later migrate fully to session control.

3. PTY-based managed sessions:
  - add `node-pty` and `strip-ansi` to the stack
  - bridge user input/output through a PTY so providers still see an interactive terminal
  - scan stripped PTY output for nonce completion markers
  - inject provider-specific `/exit` when known
  - terminate the child process as fallback after successful marker detection and artifact validation
