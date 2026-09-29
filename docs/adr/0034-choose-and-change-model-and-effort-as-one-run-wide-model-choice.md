# Choose and Change Model and Effort as One Run-Wide Model Choice

A **Run** carries one **Model choice**: a model and an effort level, each always a real value the selected **Harness** names, never "Harness
default". It is set at launch, saved with the Run, and changeable whenever the Run is open, from the Run Workbench or headless. Every **Turn** in every
**Harness Session** of the Run requests the Model choice current when that Turn starts, and records it beside what the Harness reports actually served.
The need came from the pre-public-release reports ([#235](https://github.com/secantdev/secant/issues/235)): a user could not change the model within a
Session, Claude Code offered only free-text model entry, and no Harness offered an effort control. This supersedes the Run lifecycle glossary's
Run-level, immutable **Requested model** and its `Harness default`; [Spec: M4](https://github.com/secantdev/secant/issues/137)'s posture of omitting
model and reasoning effort for Codex and its no-picker line; [Spec: M5](https://github.com/secantdev/secant/issues/180)'s "resume-time model change and
per-Turn selection are not built"; and [#186](https://github.com/secantdev/secant/issues/186)'s free-text-only Claude Code entry. It amends
[ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)'s model amendment with a third declaration kind. Unchanged: a Workflow Bundle never selects or
constrains a model, requested and effective values stay distinct facts, and an effective value is observed, never copied from the request.

**Launch.** The model and effort menus are preselected with the human's last Model choice for that Harness, which every change updates, at launch or
mid-Run, and which Secant keeps in its saved preferences. With no last choice, they show the defaults the Harness itself reports before launch: Codex's
`config/read` for the **Workspace**, falling back to the `model/list` default model at its `defaultReasoningEffort`; Claude Code's `get_settings`
`applied` values, from a short-lived process that makes no model call. A Claude Code that does not answer starts from Opus (latest) at `medium`. Codex
offers the `model/list` ids and, for each model, only the effort levels it lists; a model change that leaves the current effort unsupported switches the
effort to that model's default, visibly. Claude Code offers its documented aliases, the model families labelled "(latest)", plus Default, Opus Plan,
the 1M variants, and Other… for any exact name, and the five `--help` effort levels. When `CLAUDE_CODE_EFFORT_LEVEL` is set, the effort control shows
the level as set by that variable and is disabled; Secant never strips the variable from the child.

**Changing and applying it.** A change updates the Run's Model choice at once and durably, and it reaches every Session: the one in use, any other open
Session on its next Turn, and every Session opened later, such as each Iteration of a Repeat group. Codex carries model and effort on every
`turn/start`, its stable per-Turn fields, which also covers a fresh thread and a `thread/resume` that would drop an earlier override; a change
therefore applies from the next Turn, and the screen says so. Claude Code receives the typed `set_model` and `apply_flag_settings` control requests as
soon as the choice changes, which may land inside the running Turn or at the next one; the screen shows the change applied only when it is observed,
the model from the model named on the Harness's replies and the effort from `get_settings`. A typed refusal, such as an unknown or organisation-blocked
model, keeps the previous choice and says why. Preparation probes `get_settings`; a Claude Code that does not answer falls back to relaunching the
Session with `--resume`, `--model`, and `--effort` at the next Turn, which overrides the transcript's model. Reopen and resume reuse the saved Model
choice, and both Harnesses receive it explicitly.

**Recording.** Each Turn records its **Requested model** and **Requested effort**, copied from the Model choice when it starts, and its **Effective
model** and **Effective effort** as the Harness reports them. For Claude Code these come from the replies' model and `get_settings`, which reports no
effort for a model without one. For Codex they come from `thread/read` after the Turn starts, with a `model/rerouted` event replacing the model; this
also ends today's reading of the model from `thread/start`, before the Turn's override applies. A value stays unknown only when the Harness reports
nothing. Interactive agent steps gain these records too. `run show --json` adds the Model choice and the per-Turn facts additively; headless gains
`run launch --effort` and a command that changes a live Run's Model choice under the same rules.

**Harness Interface.** The model declaration gains `suggested` beside `list` and `free-text`: named picks that are neither exhaustive nor validated by
Secant. The profile declares effort levels per model, and a new evidence-bearing capability says whether a Model choice change reaches a live Turn or
applies from the next one. The prepared Harness reports the Harness's own defaults through the bounded qualify path `launch-preparation` already uses.
Each Turn request carries the Model choice as opaque strings, which the Adapter applies however its Harness does before sending content; a change
during a live Turn is one handle control answered with a `ControlReceipt`. The effective effort joins the effective model as an observation event.
Above the Interface, the Run Store holds the Model choice and the per-Turn facts, and the Application owns the change and the last-choice preference;
the Adapter learns no Run, Step, or Bundle word.

**Why the typed Claude Code route.** The typed control requests are the Claude Agent SDK's own wire, documented as SDK methods but not for a client that
drives the CLI directly. Recorded on Claude Code 2.1.283, they answer without the SDK's `initialize`, even before the first Turn, return typed success
and typed errors, and are the only read-back of the effort Claude Code will send; T3 Code relies on the same wire across a wide range of Claude Code
versions. The documented alternative, `/model` and `/effort` sent as prompt text, reports success for an unknown model and never reports effort, the
kind of untruthful signal ADR 0022 excludes, and in the same recording it waited for the Turn to end. Qualification bounds the dependency: a version
that stops answering degrades to the documented relaunch, never to best-effort parsing. Adopting the Agent SDK itself stays rejected for the reasons in
[Establish Claude Code's viable structured transports](https://github.com/secantdev/secant/issues/3).

Rejected: a change scoped to one Session, which would silently return each fresh Session to the launch choice; offering "Harness default" as a value,
since a sticky Codex override and Claude Code's reset to the model's own default would make the label untrue after any change; a Claude Code model
catalogue Secant maintains, which goes stale with every model release; holding a Claude Code change until the Turn ends, when the Harness can take it
now; Codex's experimental `thread/settings/update` and `turn/settings/update`, which change nothing a user can see; and stripping
`CLAUDE_CODE_EFFORT_LEVEL`, which would override a setting the user chose. How Start a Run and the Run Workbench present the menus and the pending and
applied states is left to the Run Workbench prototype. The decision was made on
[Decide how model and effort are chosen and changed within a Harness Session](https://github.com/secantdev/secant/issues/245).
