# PROTOTYPE — Start a Run Model choice

Throwaway experiment for [Prototype how Start a Run presents the Model choice](https://github.com/secantdev/secant/issues/311).
Based on `prototype/issue-247-run-workbench-agent-screen`; its Workbench experiment is preserved unchanged.
Nothing in production imports this directory. No model calls, Run creation, preferences writes, or other persistence.

## Question and acceptance

Can the human identify and confirm the initial model and effort, change both, explain an effort lock or an unavailable setting, and complete each
case with the keyboard on narrow and wide terminals? The human's live reaction to these runnable variants accepts or rejects them. Rendering and key
smoke checks establish only that the experiment runs. No layout is selected yet.

## Run

```sh
bun run prototype:model-choice
# Optional initial variant and case:
bun run prototype:model-choice --variant=B --scene=locked
```

- **Alt+1:** A — both lists visible together; stack below 100 columns. Arrow keys update the focused field immediately. Tab moves between Harness,
  Model, enabled Effort and Continue; Enter advances focus or opens review.
- **Alt+2:** B — a compact form with separate pickers. Tab moves fields; Enter opens a picker. Model search takes text, arrows browse, Enter commits,
  and Esc cancels without changing the choice. Closing restores the originating field's focus.
- **Alt+3:** C — choose a model, then effort, then review. Arrows browse and Enter commits. The unavailable-effort page explains the reason and Enter
  acknowledges it. Esc returns to model selection. Tab moves to/from Harness.
- **Alt+N / Alt+P:** next/previous fixture; **Alt+R:** reset the fixture and replay loading.
- **PgUp / PgDn:** scroll long content; **Ctrl+C:** dismiss a picker/editor, otherwise quit.
- **Harness field:** Left/Right (A/B), or Enter (all), changes Harness and reloads its fixture last choice.
- **Review:** Tab selects Model/Effort for editing or Start Run for simulated confirmation. Esc returns. Start waits for simulated launch checks.

The comparison bar and fixed Current choice footer are experiment scaffolding. Variant switches preserve the choice so the human can compare the
same pair across presentations; scenario switches reset it. Suggested Claude Code labels also show their exact alias on review. Other… opens a native
text input; Enter accepts a nonempty exact name and Esc cancels. Locked/unavailable effort is skipped by form focus, with the reason still visible.

## Try these cases

1. **codex-last:** identify the preselected `gpt-6-astra` / `xhigh`. Change model to `gpt-6-sol`; check that effort becomes `medium` and the explanation
   is visible before continuing. Choose `high`, then verify it on review. Change it from review and confirm the revised pair.
2. **codex-default:** identify `gpt-6-sol` / `medium` from settings. Available efforts are scoped to that model.
3. **claude-last:** identify Sonnet (latest) / high; change to Opus (latest), then choose Other… and type an exact model name, including normal cursor
   movement and a cancellation attempt.
4. **claude-default:** identify Opus (latest) / medium from reported settings. Compare the family aliases, Default, Opus Plan, and 1M variants.
5. **locked:** explain why high effort cannot change; changing the model retains the environment-set effort. The review repeats the reason.
6. **no-effort:** explain why effort is unavailable for the fixture's exact custom model; review must not invent an effort value. Changing to Opus
   makes the effort control available again.
7. **fallback:** settings could not be read; the fallback pair is concrete Opus (latest) / medium, with its origin explained.

Try at 60 × 24 and 140 × 44, then resize mid-selection. Models and settings are frozen illustrative data from the ticket's contract and research;
this is not a current model catalogue. The custom no-effort name is deliberately fictional. The experiment skips Bundle/input selection to focus on
the remaining model/effort decision; review carries fixed inputs for context.

## Authority and disposition

ADR 0034 and the launch glossary constrain semantics. OpenCode's `dialog-model.tsx`, `dialog-variant.tsx`, `dialog-select.tsx`, and dialog focus
ownership inform presentation; no reference implementation was copied. The experiment imports only Secant's existing vendored theme.

**Pending:** chosen layout, wording, focus/keys, and cleanup or adoption disposition require human feedback. Preserve the full experiment on its
throwaway branch with a commit-pinned pointer in the decision ticket. Production adoption belongs to the subsequent Amendment/spec/tickets loop;
this branch must not merge into main.
