# DevFlow Progress
_Last updated: 2026-05-24_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md`.
Hard limit: 100 lines.

## Done
- Architecture, MVP scope, library choices, state layout, and implementation order are locked in `HANDOFF_2.md`.
- Node/TypeScript CLI scaffold exists with strict ESM TypeScript, `devflow` bin mapping, `tsup` build config, repo `.gitignore`, package lock, and installed runtime/dev dependencies.
- Completed the adapter and discovery foundation:
  - built-in Claude, Gemini, Codex, and OpenCode provider identity metadata lives in `src/adapters/providers.ts`
  - managed-session adapters expose discovery plus `runSession(...)`, validation callbacks, optional in-session repair prompts, typed lifecycle failures, and structured success metadata
  - provider discovery stays focused on availability detection, canonical built-in ordering, unavailable-provider degradation, and injected adapter factories for tests
- Completed the CLI/bootstrap slice:
  - `src/cli.ts` provides the `commander` entrypoint with free-form task parsing, help/version passthrough, clear missing-task failures, and concise provider/session error mapping
  - `src/projectRoot.ts` resolves the Git repo root when present and falls back to the current working directory outside Git
  - repo-local default-provider config is validated strictly, saved through the state facade, and repaired with clear malformed-config guidance
  - first-run provider setup, cancellation without side effects, strict `--provider` overrides, and opaque invocation-only `--model` forwarding are implemented and tested
- Completed the `.devflow` filesystem state boundary:
  - `src/devflowState.ts` owns config persistence, shared project context, run creation, canonical run paths, immutable `intent.json`/`prd.md`/`validation.json` artifacts, and normalized issue markdown writes
  - duplicate artifact writes, invalid issue slugs, invalid run ids, malformed config, invalid project context, and invalid metadata surface as typed domain errors
  - the active CLI-to-orchestrator path threads the typed state facade into `src/orchestrator.ts`
- Completed project-context freshness tracking:
  - `.devflow/project-context.md` writes reject empty content and content over 150 lines
  - `.devflow/project-context.meta.json` stores `generatedAt`, baseline `gitHead`, `dirtyFingerprint`, `contextVersion`, and `refreshReason`
  - freshness checks return structured fresh/stale results for missing context, missing metadata, invalid metadata, version changes, max age, unavailable Git baselines, and relevant changes
  - Git freshness uses committed changes since the stored baseline plus staged, unstaged, and untracked dirty-tree fingerprints
  - repeated runs on the same dirty tree stay fresh; clean trees store `dirtyFingerprint: null`
  - hardcoded freshness ignores are limited to DevFlow/agent/Git internal paths; Git-ignored untracked files are ignored by Git itself
  - untracked fingerprinting is streamed through file paths/byte lengths instead of eagerly buffering all content
  - non-Git repos use metadata/context presence, metadata validity, context version, and a three-day max-age fallback
  - the public state contract now exposes project context only through the grouped `projectContext` capability
- Completed the active intent stage:
  - `runExecutionRequest()` creates a run, renders `prompts/intent.md` with the raw task, canonical artifact path, schema requirements, and nonce completion marker, then invokes the selected managed-session adapter
  - intent artifact validation is strict JSON/schema validation over the provider-owned `intent.json`
  - invalid intent artifacts can be repaired once inside the same PTY session with a targeted repair prompt
  - intent gets 2 total whole-stage attempts inside one run; retryable failures clean failed output before retry and retry exhaustion preserves the final failed artifact for inspection
  - setup/config failures, interruptions, and cleanup failures stay outside retry
- Completed bootstrap/project-context activation:
  - run handles expose `.devflow/runs/<run-id>/project-context.candidate.md` for provider-written context candidates
  - bootstrap reuses fresh project context, repairs missing/invalid metadata without provider work, and generates missing context through the managed provider
  - stale context refresh handles version, age, unavailable baseline, and relevant-change freshness results with prior context plus changed-path hints
  - bootstrap candidate validation uses the exported project-context content validator, supports one in-session repair attempt, and has an independent 2-attempt whole-stage retry budget
  - successful candidates persist through `projectContext.write(...)`, refresh metadata even for unchanged text, and best-effort cleanup failures are non-fatal
  - orchestrator results now expose parsed canonical intent, the intent managed-session result, and bootstrap provenance: `reused`, `generated`, `refreshed`, or `metadata-updated`
- Completed the PTY-based managed-session transport:
  - `node-pty` and `strip-ansi` are wired through `src/adapters/ptyManagedSessionRunner.ts`
  - built-in adapters resolve executables at launch, pass model overrides through provider-native flags, mirror stripped/bounded output for marker scanning, and send cleanup after successful validation
  - TTY stdin raw-mode bridging, first/second Ctrl-C behavior, terminal resize forwarding, launch failures, incomplete sessions, interruptions, cleanup failures, and in-session repair are typed and covered by regression tests
- Regression coverage now spans adapter contracts, provider discovery, CLI parsing/bootstrap/error handling, repo config, state boundary, project-context Git freshness, PTY sessions, orchestrator intent/bootstrap execution, in-session repair, and whole-stage retry.

## Current State
- The repo has a working CLI/bootstrap/state/orchestration boundary across `src/cli.ts`, `src/projectRoot.ts`, `src/bootstrapProvider.ts`, `src/devflowState.ts`, `src/orchestrator.ts`, provider session code, and `src/adapters/`.
- Built-in provider discovery, repo-root resolution, default-provider state, provider/model override handling, first-run provider selection, shared context storage/freshness, run creation, immutable run artifact writes, PTY-backed managed sessions, strict intent validation, active bootstrap/project-context generation, in-session repair, and whole-stage retry are implemented and regression-tested.
- The MVP pipeline currently has `intent` and `bootstrap` active; `grill`, `prd`, `issues`, `execute`, and `validate` are observable no-op placeholders that do not write fake artifacts.
- There are no remaining AFK tasks in the project-context freshness, managed-session/retry, or bootstrap project-context workstreams from `.agent/task_progress.md`.
- Latest verification: `npm run test` on 2026-05-24 passed with 146 tests.

## Remaining MVP Tasks
1. Activate the grill stage:
  - always run a provider-backed user-facing grill session after intent/bootstrap
  - persist an append-only `grill-transcript.md` with provider output and submitted user messages, across retry attempts
  - write a durable grill completion boundary plus immutable `grill-checkpoint.json` before PRD synthesis
  - synthesize canonical `prd.md` from the completed grill transcript in the coupled PRD phase and validate it as non-empty
  - keep downstream stages consuming only `prd.md`
2. Add resume support for completed grill sessions:
  - expose a CLI resume path that uses `grill-transcript.md`/`grill-checkpoint.json` to regenerate missing or invalid `prd.md`
  - never repeat the interactive grill when the transcript completion boundary proves grill completion
3. Activate issue decomposition:
  - add an issues prompt template and artifact contract
  - produce normalized issue markdown files under the run `issues/` directory
  - validate issue slugs, ordering, file-scope hints, and actionable acceptance criteria
4. Activate execution:
  - run each MVP issue sequentially through provider-backed sessions
  - pass bounded context, PRD, issue content, and prior issue outputs
  - record execution summaries without inventing success when provider work fails
5. Activate validation:
  - run configured or inferred lint/tests/build checks
  - retry failed validation once through the provider
  - write `validation.json` and escalate clearly after the second failure
6. Finish MVP CLI UX:
  - expose concise stage progress
  - map new stage/artifact validation failures to user-facing errors
  - produce a final run summary with artifact paths and next manual steps
