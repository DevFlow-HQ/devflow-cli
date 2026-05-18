# DevFlow Progress
_Last updated: 2026-05-17_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript package scaffold exists.
- `package.json` exists with ESM package setup, `devflow` bin mapped to `./dist/cli.js`, and scripts:
j  - `build`: `tsup`
  - `dev`: `tsx src/cli.ts`
- `test`: `tsx --test tests/**/*.test.ts`
- `typecheck`: `tsc --noEmit`
- Runtime deps installed/listed: `commander`, `chalk`, `ora`, `enquirer`, `execa`, `which`, `fs-extra`, `globby`, `zod`.
- Dev deps installed/listed: `typescript`, `tsx`, `tsup`, `@types/node`, `@types/fs-extra`, `@types/which`.
- `package-lock.json` and `node_modules/` are present.
- `tsconfig.json` exists with strict TypeScript, ESM, bundler module resolution, `outDir: dist`, and Node test types.
- `tsup.config.ts` exists and builds `src/cli.ts` to ESM with a Node shebang banner.
- `.gitignore` currently ignores `node_modules/`, `dist/`, and `.agent/`.
- Completed the provider adapter foundation from the handoff’s adapter layer scope:
  - `src/adapters/providerAdapter.ts` defines the built-in provider source of truth for Claude, Gemini, Codex, and OpenCode, plus the shared async detect/run contract and constrained run input
  - `src/adapters/commandProviderAdapter.ts` implements shared command-backed detection and interactive run semantics with private executable resolution and structured process results
  - `src/adapters/claudeAdapter.ts`, `src/adapters/geminiAdapter.ts`, and `src/adapters/codexAdapter.ts` wire built-in providers through that shared contract
  - `src/adapters/builtInProviderAdapter.ts` exposes orchestration-facing built-in provider selection without leaking CLI-specific process details
- Added contract-level regression coverage in `tests/adapters/providerAdapter.contract.test.ts` for:
  - provider constants and identity lookup alignment
  - adapter shape and run input exclusions
  - detection success/failure semantics
  - interactive run success, non-zero exit, and launch-failure behavior
  - built-in provider wiring for the currently implemented adapters
- Verified this slice with `npm run test` and `npm run typecheck`.

## Current State
- Provider adapter contract exists under `src/adapters/providerAdapter.ts`.
- Shared command-backed adapter behavior exists under `src/adapters/commandProviderAdapter.ts`.
- Built-in Claude, Gemini, and Codex adapters exist under `src/adapters/`.
- Built-in provider selection exists under `src/adapters/builtInProviderAdapter.ts`; `opencode` is still listed in the contract constants but not wired there yet.
- Contract-level regression coverage covers provider constants, identity lookup alignment, detection outcomes, run exit metadata, launch-failure rejection, and built-in wiring for the implemented adapters.
- No prompt templates exist yet under `prompts/`.
- Contract tests exist under `tests/adapters/providerAdapter.contract.test.ts`.
- Build/dev scripts will not work until `src/cli.ts` is created.
- `ISSUE-001` through `ISSUE-005` are complete.

## Next Checkpoint
- Continue from the handoff order after the adapter slice:
  1. Add `src/utils/detect-cli.ts` on top of the adapter seam.
  2. Add `src/cli.ts` with first-run provider selection and `.devflow/config.json` persistence.
  3. Stub `src/orchestrator.ts`, stage agents, and prompt templates.
