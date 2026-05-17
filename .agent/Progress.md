# DevFlow Progress
_Last updated: 2026-05-17_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript package scaffold exists.
- `package.json` exists with ESM package setup, `devflow` bin mapped to `./dist/cli.js`, and scripts:
  - `build`: `tsup`
  - `dev`: `tsx src/cli.ts`
  - `test`: `node --experimental-vm-modules node_modules/.bin/jest`
- Runtime deps installed/listed: `commander`, `chalk`, `ora`, `enquirer`, `execa`, `which`, `fs-extra`, `globby`, `zod`.
- Dev deps installed/listed: `typescript`, `tsx`, `tsup`, `@types/node`, `@types/fs-extra`.
- `package-lock.json` and `node_modules/` are present.
- `tsconfig.json` exists with strict TypeScript, ESM, bundler module resolution, `outDir: dist`, and Node test types.
- `tsup.config.ts` exists and builds `src/cli.ts` to ESM with a Node shebang banner.
- Empty structure exists for:
  - `src/adapters/`
  - `src/agents/`
  - `src/state/`
  - `src/utils/`
  - `prompts/`
  - `tests/adapters/`
  - `tests/agents/`
- `.gitignore` currently ignores `node_modules/`, `dist/`, and `.agent/`.
- Added provider adapter contract in `src/adapters/providerAdapter.ts`:
  - runtime built-in provider constants for Claude, Gemini, Codex, and OpenCode
  - derived provider identity types
  - shared async detection and run contract
  - run input limited to `prompt`, `workingDirectory`, and optional `model`
- Replaced the broken Jest placeholder with working scripts:
  - `test`: `tsx --test tests/**/*.test.ts`
  - `typecheck`: `tsc --noEmit`
- Added contract coverage in `tests/adapters/providerAdapter.contract.test.ts` for provider constants, adapter shape, and run input exclusions.
- Added a representative built-in Codex adapter in `src/adapters/codexAdapter.ts` with private executable resolution against `PATH` and structured non-interactive detection outcomes.
- Extended `tests/adapters/providerAdapter.contract.test.ts` to prove representative detection success and failure semantics through temporary local `PATH` state.
- Implemented representative Codex interactive run behavior in `src/adapters/codexAdapter.ts` with private executable resolution, target `cwd` launch, prompt/model argv construction, and structured process exit metadata.
- Extended `tests/adapters/providerAdapter.contract.test.ts` to prove run semantics for successful launch, non-zero exit resolution, distinct launch-failure rejection, and working-directory/model propagation via a temporary local `codex` executable.
- Wired built-in provider selection through `src/adapters/builtInProviderAdapter.ts`, so orchestration-facing code can select `codex` by built-in provider id and consume only the shared adapter contract.
- Extended `tests/adapters/providerAdapter.contract.test.ts` to prove end-to-end built-in provider wiring by selecting `codex` generically, then detecting and launching it through the shared contract.
- Added `getBuiltInProviderIdentity` in `src/adapters/providerAdapter.ts`, reused it from `src/adapters/codexAdapter.ts`, and extended `tests/adapters/providerAdapter.contract.test.ts` with regression coverage that binds provider identity lookup to the built-in provider constant list.
- Verified this slice with `npm run test` and `npm run typecheck`.

## Current State
- Provider adapter contract exists under `src/adapters/providerAdapter.ts`.
- Representative Codex detection and run behavior exist under `src/adapters/codexAdapter.ts`.
- Built-in provider selection for the wired Codex path exists under `src/adapters/builtInProviderAdapter.ts`.
- Contract-level regression coverage now covers provider constants, identity lookup alignment, detection outcomes, run exit metadata, and launch-failure rejection semantics.
- No prompt templates exist yet under `prompts/`.
- Contract tests exist under `tests/adapters/providerAdapter.contract.test.ts`.
- Build/dev scripts will not work until `src/cli.ts` is created.
- `ISSUE-001` through `ISSUE-005` are complete.

## Next Checkpoint
- Provider adapter tracer-bullet and regression AFK issues are complete; pick the next non-provider task from the handoff order.
