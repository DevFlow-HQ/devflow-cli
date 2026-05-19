# DevFlow Progress
_Last updated: 2026-05-19_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript package scaffold exists.
- `package.json` exists with ESM package setup, `devflow` bin mapped to `./dist/cli.js`, and scripts:
  - `build`: `tsup`
  - `dev`: `tsx src/cli.ts`
  - `test`: `tsx --test tests/**/*.test.ts`
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
- Verified the current slice with `npm run test`, `npm run typecheck`, and `npm run build`.

## Current State
- The repo now has a working CLI/bootstrap boundary across `src/cli.ts`, `src/projectRoot.ts`, `src/repoConfig.ts`, `src/bootstrapProvider.ts`, `src/orchestrator.ts`, and `src/adapters/`.
- Built-in provider discovery, repo-root resolution, repo-local default-provider state, explicit provider/model override handling, and first-run provider selection are implemented and regression-tested.
- The orchestrator boundary exists but is still a stubbed handoff target; downstream state helpers, agents, and prompt files for the actual pipeline are not implemented yet.

## Next Checkpoint
- Implement the filesystem state helpers under `src/state/` for config reuse, context/bootstrap artifacts, and timestamped run directories.
- Expand `src/orchestrator.ts` from a stub into the stage sequencer for intent → bootstrap → grill → PRD → issues → execute → validate.
- Add the first real agent slice, starting with `src/agents/intent.ts` and `prompts/intent.md`, so one provider-backed stage can run end to end.
