# Contributing

This page is for people. Agents read `AGENTS.md`, and every engineering rule lives there or in the files it names; nothing is repeated here.

## Set up

Install the Bun version pinned in `package.json` under `packageManager` — the whole toolchain runs on Bun alone, no Node required — then run a clean install:

```sh
bun install --frozen-lockfile
```

## Run

```sh
bun run dev -- --help
```

## Verify

One command is the canonical gate. CI runs the same command after a clean install, and a change is done when it passes:

```sh
bun run check
```

It covers type checking, formatting, lint, the structural step (`bun run structure:check`), the unused-code check (`bun run unused:check`), the recursively discovered deterministic tests, the production build, and compiled-binary smoke tests.
Checks that need an installed Harness, network access, or a real terminal are opt-in and not part of it.

## Find your way

- Vocabulary: `CONTEXT.md` and the glossary cluster it points you to.
- Durable decisions and their reasons: `docs/adr/`.
- Engineering policy: the line in `AGENTS.md` that matches your change, then the file it names.
- Work in progress: GitHub issues. Both wayfinding decisions and implementation tickets carry a "Starting context" comment. Read it before the code.

## Find the logs

Every Secant invocation that does real work (the TUI, or any headless command other than `--help`, `--version`, or a mistyped command) writes one
operational log file to `logs/` in the Secant home: `~/.secant/logs` by default, or `$SECANT_HOME/logs`.

- Each file is named `<UTC timestamp>-<pid>.jsonl`, for example `2026-10-02T09-08-07-006Z-4242.jsonl`, so the newest sorts last.
- Each line is one JSON object: `level`, `time`, `invocationId`, `event`, and that event's own fields. Read them with `jq` or any JSON tool.
- Set `SECANT_LOG_DIR` to write the files somewhere else, such as a CI folder that outlives a throwaway home.
- Set `SECANT_LOG_DETAIL=1` while reproducing a problem to add finer `debug` checkpoints: each Preflight check, each Run Store write Run execution makes,
  and each Harness handshake step. The start record then carries `"detail": true`. Detail adds no prompts, arguments, environment values,
  credentials, or output.
- Startup removes log files last written more than 30 days ago; a locked or unreadable file is left for the next startup.
- A fatal error names its file on stderr. If the folder cannot be written, Secant says so once on stderr and carries on unlogged.
- Logs hold lifecycle facts, never prompts, arguments, environment values, or credentials, and the files are readable only by you where the OS
  supports it.

## Pull requests

- Reference the issue the change implements. Keep the change small enough to review in one sitting.
- Say how you verified it beyond `bun run check`, especially for anything touching a real Harness or terminal.
- Short imperative titles, optionally prefixed `type(#issue):`, for example `docs(#18): record in-place legacy replacement as ADR 0026`.
- No Co-author trailers in commit messages.
