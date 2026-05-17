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
- Verified this slice with `npm run test` and `npm run typecheck`.

## Current State
- Provider adapter contract exists under `src/adapters/providerAdapter.ts`.
- Representative Codex detection exists under `src/adapters/codexAdapter.ts`.
- No prompt templates exist yet under `prompts/`.
- Contract tests exist under `tests/adapters/providerAdapter.contract.test.ts`.
- Build/dev scripts will not work until `src/cli.ts` is created.
- `ISSUE-001` and `ISSUE-002` are complete.

## Next Checkpoint
- Start coding from the handoff order:
  1. Implement representative interactive run semantics with subprocess outcomes.
  2. Wire one built-in provider end to end through the shared adapter.
  3. Add broader regression coverage around detection and run behavior.
