# Type App Commands in the Compose and Refuse Harness-Reserved Words

The Run Workbench's always-editable compose ([ADR 0036](./0036-the-run-workbench-mirrors-the-agent.md)) also takes typed **Slash commands**,
and any text Secant sends a **Harness** must satisfy that Harness's declared **Harness input rules**. The question came from
[Decide how typed commands work in the Run Workbench compose](https://github.com/secantdev/secant/issues/267). Live probes found that Claude Code
runs a leading `/name` from Secant's frames as its own command: `/clear` starts a conversation under a new session id, `/model` and `/effort`
change the session outside the Run's Model choice ([ADR 0034](./0034-choose-and-change-model-and-effort-as-one-run-wide-model-choice.md)), and
`/config` writes the user's global Claude Code settings. Codex's app-server passes the same words to the model as plain text
([research](../research/harness-slash-text-and-file-mentions.md)).

**App commands and one catalog.** The single command catalog from
[Decide what the home screen offers](https://github.com/secantdev/secant/issues/246) is Secant's own, in the TUI, not `@opentui/keymap`'s command
registry: the registry's reachable view is built from keymap layers, and the Workbench takes keys from the Renderer Port, not the keymap. Each
**App command** is owned by the owner of its action (the shell for Themes and Quit, Home for its navigation, the Workbench for entries derived
only from current Action Offers) and carries an optional slash name and key hint. The 2026-10-09 amendment gives each command
owner its declared numeric order, shared by Home, Ctrl+P, and Slash discovery, so no command falls ahead of declared entries
because its id is absent from a separate order list. The Workbench adds:

| Typed                   | App command                                               | Key      |
| ----------------------- | --------------------------------------------------------- | -------- |
| `/end-step`             | End Step                                                  | `ctrl+e` |
| `/continue`             | Continue a human-controlled Repeat                        | `ctrl+n` |
| `/end-stage`            | End Stage, after its confirmation                         | none     |
| `/model`                | Model choice picker (model and effort committed together) | none     |
| `/effort`               | The same picker, focused on effort                        | none     |
| `/themes`               | Themes                                                    | none     |
| `/quit` (alias `/exit`) | Quit                                                      | `ctrl+c` |

`ctrl+e` means End Step and nothing else; End Stage has no key. Interrupt, Expand, the details panel, and resume, cancel, and delete stay
key-only or in the details panel. Ctrl+P opens a palette dialog listing every App command available now with its key hint, claimed through the
Workbench's own key path and yielding to a Harness Request or Human Gate like any modal. A palette or slash invocation runs the same arm-then-confirm
path as the key. Model and Effort ship with the Model choice Operation and headless command, and Themes with saved Preferences
([ADR 0037](./0037-own-saved-presentation-preferences-in-catalog-and-apply-themes-independently.md)), never as dead entries.

**The `/` list.** It opens when `/` is the draft's first character, before any whitespace, filters with the catalog's shared search, highlights
only a prefix match (so `/tmp/x` never lands on a command), and runs the highlighted entry on Enter or Tab. Up and Down move the highlight
while it is open; Esc closes it and keeps the text. Unavailable App commands are hidden; an exact typed unavailable name gets "isn't available
right now". Availability follows the Offers: during a working Turn and in an Agent step only Model, Effort, Themes, and Quit; when a Harness
Request, Human Gate, or Review checkpoint holds the bottom region, no `/` list but the same four in Ctrl+P; after the Run ends, Themes and Quit.
The 2026-10-09 amendment adds `Recover unsent text` in Ctrl+P while the prompt holds the bottom and earlier-input text is saved,
including during a working Turn. Distinct bottom controls offer `Copy unsent text` instead. A finished Run also saves its typed
but unsent draft for Copy; a failed clipboard copy leaves that text saved. Neither recovery command has a slash name.
Their order follows Model, Effort and available Step endings, before Themes and Quit.
An entry leaves the open list when its Offer does, reads its Offer when it runs, and a stale Operation is refused with a notice by the existing
fresh-state admission.

**A Secant name is never forwarded.** A draft whose first word is a Slash command's name is that App command. The 2026-10-07 implementation settles the spelling and draft choices:
known names ignore leading whitespace and case, while discovery still requires a literal first-character `/`; a successful invocation clears its command
draft before the action opens its picker or confirmation. There are no inline arguments:
`/model haiku` or `/continue working on it` is refused with a notice and the draft kept. Every other draft goes to the Harness unchanged,
including skills, `/compact`, paths, and unknown names, unless a Harness input rule refuses it. There is no escape syntax.

**Harness input rules.** A Harness input rule is closed data, `{ kind, ...data }`, with one kind today: `reserved-leading-words`. Each Harness
Adapter declares its rules as a static list, independent of transport, so a command that a transport currently disables stays reserved. Claude
Code reserves `/clear /new /reset /resume /continue /fork /model /effort /fast /config`: each names a conversation, Model choice, or permission
change that Secant owns. Codex reserves nothing. One matcher, owned by the Workflow Module, applies every rule: leading whitespace is skipped,
the first word runs to the first whitespace or line break, and comparison is case-insensitive. It is deliberately broader than Claude Code's own
exact match, because a near-miss such as ` /clear` makes the model claim a reset that never happened.

- **Declaration and aggregation.** The Adapter declares against its own structurally identical type (the Harness Module imports only `process`);
  the composition root, which alone owns the Harness registry, puts each Harness's rules on its registration, and Application merges them. The
  Workflow Module never learns why a rule exists.
- **Human Turns.** Application refuses a send whose text breaks the selected Harness's rules at admission, beside the blank-text check, before
  any Operation, state write, or stdin, and the TUI keeps the draft.
- **Steers.** Steer admission checks Harness Steer availability first, then blank text, then the rules. While a Turn works, a Claude Code Steer
  whose first word is a command Claude Code listed for the Session is also refused ("send it when the Turn ends"): Claude Code runs a command
  after the Turn instead of delivering it inside, and a `/compact` there would settle the Turn with empty text. The listed commands rise as a
  Harness-neutral session fact beside the tool list. Both Steer checks ship with ADR 0035's Claude Code Steer, not before. At a Turn boundary a
  non-reserved command such as `/compact` is sent as its own Turn, and Interrupt stops it cleanly.
- **Bundles.** Bundle build and install refuse an asset prompt whose authored text breaks any supported Harness's rules, reusing the Composition
  check's failure. Launch Preparation adds a correctable finding against the selected Harness, whose correction is the Harness choice. At Turn
  start, the rendered prompt, slots filled, is checked against the selected Harness's rules: an Agent step's Attempt fails as an ordinary
  failure without writing a Turn, and an Interactive agent step's Entry Turn leaves the Run `blocked`. Resume adds no separate check.

No Harness Interface query is added and [ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)'s Interface is unchanged: rules are declared data,
and Secant owns the matching and the refusal.

**Headless** gains no typed commands, since it has subcommands and no compose. Model and Effort map to the live Model choice command ADR 0034
decided; End Step, Continue, and End Stage stay behind the existing Interactive-step gap; Themes maps to `secant settings`.

## Considered options

- Forward every slash word: one typo resets the Session. Launching Claude Code with `--disable-slash-commands`, whose help reads "Disable all
  skills", turns off the user's skills too.
- One Secant-wide reserved list refusing the same words on every Harness: refuses harmless text on Codex, which honours none of them.
- An Adapter-side "may I send this text?" query on the Harness Interface: needed only while the rules were private; declared data serves the
  send, Steer, Turn-start, and Bundle checks from one declaration.
- A non-retryable failure for a refused Bundle prompt: execution has no such outcome, and the case reaches Turn start only through a filled slot
  or an upgrade that reserves a new word.
- Inline arguments (`/effort high`): a parse and error path none of the TUI references needs.

## Consequences

- A newly reserved word refuses new builds and installs of an affected Bundle; installed Bundles stay installed and launch on other Harnesses,
  and a pinned Run fails only at the affected Step. The Shipped-Bundle build script passes the merged rules.
- The visible-reason gap for failed Attempts and `blocked` Entry prompts is closed by ADR 0041's pre-Turn Failure evidence (2026-10-10, #531). Both clients show the reason, including prompt-render failures.
- The Claude Code Steer slice also has to match each `result` to its frames by `user_message_uuids`, treat a `local_command` result and a
  cancelled compaction (reported `success`, `compact_result: "failed"`) truthfully, tolerate repeated same-id `init` frames, and handle automatic
  compaction.
- `src/harness/AGENTS.md` lists the rule declaration as a declared exception, and `src/bundle/AGENTS.md` records the required rules parameter,
  when the implementing slices land.
