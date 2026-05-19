# DevFlow Progress
_Last updated: 2026-05-18_

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
- Added regression coverage in `tests/adapters/providerAdapter.contract.test.ts` and `tests/adapters/providerDiscovery.test.ts` for provider identity, detection results, interactive run semantics, OpenCode parity, discovery ordering, availability summaries, unsupported-provider messaging, and failure degradation.
- Verified this slice with `npm run test` and `npm run typecheck`.

## Current State
- The repo currently contains only the adapter/discovery slice under `src/adapters/` plus its tests.
- Built-in provider discovery is stable enough for CLI integration and returns canonical provider lists, installed-provider subsets, and availability summaries.
- Contract and regression tests exist only for adapters/discovery; no CLI, orchestrator, state, agents, or prompt files exist yet.
- `src/cli.ts` is still missing, so `npm run build` and `npm run dev` remain blocked even though package/build config is in place.

## Next Checkpoint
- Implement the CLI bootstrap layer:
  - create `src/cli.ts` with `commander` entry wiring, raw task argument parsing, provider discovery integration, and a first-run/default-provider flow
- Implement the config and state foundation:
  - add repo-root `.devflow/config.json` management plus `src/state/reader.ts` and `src/state/writer.ts` helpers for config, context, and run-folder creation
- Implement the orchestration skeleton:
  - add `src/orchestrator.ts` and stage contracts so DevFlow can sequence intent → bootstrap → grill → PRD → issues → execute → validate even if most agents are still thin
- Implement the first agent slice:
  - add `src/agents/intent.ts` and `prompts/intent.md` so the orchestrator can run one real provider-backed stage end to end
