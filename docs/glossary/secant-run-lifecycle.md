# Secant Run Lifecycle

This cluster defines the target Secant terms for a **Run** and everything that happens inside one. The package side lives in the
[Workflow Bundle](./workflow-bundle.md) cluster; this cluster owns execution.

## Terms

- **Bundle Snapshot** — the immutable **Bundle identity** and **Bundle digest** recorded by one **Run**. It pins exact content without duplicating
  the Installed Bundle's bytes; resume therefore requires that exact digest to remain installed or be reinstalled.
- **Step** — one authored node in a **Workflow Bundle**'s routing, identified by an author-chosen name unique within its Bundle and opaque to
  Secant.
- **Stage** — one top-level entry in a **Routing**: either a single **Step** or a whole **Repeat group** across all its **Iterations**. Stage and
  Step are two facts about a node, not synonyms: Step says what kind of work it is, Stage says where it sits in the Routing's order. A Step inside
  a Repeat group is a Step but not a Stage; the group is the Stage. **End Stage** and an **Agent-declared completion**'s stage done complete a
  human-controlled group's Stage.
- **Agent step** — a **Step kind** running one autonomous **Turn** in a named **Harness Session**. It completes without the human, though the human
  may **Steer** it while a Turn is live when the selected Harness supports Steer. After an **Interrupt** the human's message starts a follow-up Turn
  in the same Session and **Step Attempt**, and the Attempt takes its outcome from its last Turn.
- **Command step** — the deterministic non-agent **Step kind**. Its attempt succeeds if the command ran to an exit; the exit status becomes a
  **Verdict** and the captured output a `text` **Run Artifact**. The attempt fails only when the command could not execute.
- **Verdict** — a **Run Artifact** type holding `pass` or `fail`, produced from a deterministic **Step**'s exit status. The only thing a **Repeat
  group** may read, and never produced by an agent's judgement.
- **Iteration** — one logical occurrence of a **Repeat group**. A numbered scope, not an entity.
- **Repeat group** — a contiguous span of **Steps** in a **Routing**, repeated until a named **Verdict** reads `pass`. The condition is evaluated
  before every **Iteration** including the first, so a group whose verdict already passes runs zero times. A **human-controlled** group instead
  names no Verdict: each Iteration pauses at its one **Interactive agent step**, only a **Continue** opens the next, and only an **End Stage**
  exits it, each given by the human or, when that Step opts in, by the agent's **Agent-declared completion**.
- **End Step** — the control that ends an **Interactive agent step** outside a human-controlled **Repeat group** at a **Turn** boundary, given by
  the human or, when the Step opts in, by the agent's step done. Inside a human-controlled group **Continue** takes its place.
- **Continue** — the control that settles a human-controlled **Repeat group**'s current Iteration at a **Turn** boundary and opens the next in a
  fresh **Harness Session**, given by the human or, when the Step opts in, by the agent's step done. The human's Continue is that Iteration's review
  decision; the agent's counts toward the group's **Review checkpoint**. It never reads or changes a tracker.
- **End Stage** — the declaration, at a **Turn** boundary, that a human-controlled **Repeat group**'s **Stage** is complete: by the human after a
  confirmation, or by the agent's stage done without one. It settles the current Iteration, lets that Iteration's remaining Steps run, and exits
  the group, so a trailing group completes the **Run** `succeeded` as a **Human-declared completion** or an **Agent-declared completion**, which
  history and the Run summary show apart from each other and from an automatically verified one. Secant checks no tracker for it.
- **Human-declared completion** — a **Stage**, and for a trailing group the **Run**, completed by the human's confirmed **End Stage** rather than
  by a **Verdict**. It records the human's judgement, not a verification. _Avoid_: verified completion.
- **Agent-declared completion** — an agent's deliberate call to Secant, from an **Interactive agent step** its Bundle opts in, that its **Step**
  is done (step done) or that its human-controlled **Repeat group**'s **Stage** is done (stage done), carrying a required one-line reason. It asks
  for a control the human already has (**End Step**, **Continue**, or **End Stage**) and reaches the same settlement. Secant applies it only when
  the **Turn** it was made in ends cleanly and drops it if that Turn fails, is interrupted, or the Run is cancelled; the latest call in a Turn wins.
  Secant stores and shows the reason and never interprets it, and the human keeps every control. _Avoid_: completion marker, done phrase.
- **Agent call** — an agent's named call to Secant during a **Turn**, today step done or stage done, made through a Secant tool attached to its
  **Harness Session** and attributed to that Session's live Turn without the agent naming itself. Secant answers it at once, never the human,
  as accepted, held for review, or refused, and applies an accepted one as an **Agent-declared completion** when the Turn ends cleanly. It never
  blocks the **Run**. _Avoid_: Harness Request, tool approval, done marker.
- **Review checkpoint** — the **Human Gate** Secant raises when a **Repeat group** reaches its Bundle-authored review cadence without its
  **Verdict** passing. Every Verdict-driven Repeat group declares a positive-integer interval and plain-text message; Secant adds current runtime evidence and
  enforces an engine-owned safety ceiling. Continuing grants another interval and stopping ends the **Run** `failed`. The cadence is not a maximum
  and is not adjustable at launch. In a human-controlled group it is instead the pause Secant makes once the agent has ended the interval's worth
  of Iterations in a row: the agent's **Continue** is withheld and the Iteration waits for the human, whose own Continue resets the count. That
  interval is optional, defaults to 100, and has no ceiling; an agent's **End Stage** is never withheld. _Avoid_: Iteration checkpoint (the name
  used before the [Review checkpoint amendment](https://github.com/DevFlow-HQ/devflow-cli/issues/13#issuecomment-5528817597)).
- **Step Attempt** — one execution of one **Step**, identified by its Step, **Iteration**, and attempt number. Retries and **Iterations** are
  bounded separately.
- **Attempt outcome** — how a **Step Attempt** ended: `succeeded`, `failed`, `indeterminate`, or `cancelled`.
- **Indeterminate attempt** — a **Step Attempt** Secant started and never saw a result for. Distinct from a failure, because a step that died
  after acting on the world must not be blindly retried. It never auto-retries: it halts the **Run**, and the human's resume is the authorization
  to re-attempt.
- **Reconciliation probe** — an optional check a **Step kind** declares, run before re-attempting an **Indeterminate attempt**, answering what the
  interruption left open. It may be a **Command step** or an **Agent step**, and its **Verdict** is advisory: anything short of a clear answer
  keeps the Run `halted` and asks the human.
- **Launch input** — a value supplied when a **Run** is created, seeded into the Run's bindings like any other **Run Artifact**.
- **Run Artifact** — a named, typed value in the routing's dataflow, produced by a **Step Attempt** and consumable by later **Steps**. Logically
  versioned: the name binds to the latest good version and superseded versions stay reachable.
- **Candidate output** — a value, file, or file set a producer has written for a declared output but Secant has not yet validated and published.
  It is not a **Run Artifact** and cannot move a binding.
- **Output receipt** — the file an autonomous Agent **Step** writes at a per-Attempt path in the **Run working area** its prompt names, holding one declared `text`
  output as **Candidate output**. A completed Turn without a valid receipt fails the Step; a remote reference in it is the agent's observation,
  never proof the remote system accepted anything. _Avoid_: parsing assistant prose.
- **Artifact publication** — the all-or-nothing Run fact that one successful **Step Attempt** produced a validated set of immutable **Run
  Artifact** versions and moved their current bindings. _Avoid_: File copy, Agent publication.
- **Workspace materialization** — an optional usable copy of one canonical **Run Artifact** version at a declared Workspace-relative path. The
  producing Step's `home: workspace` declaration requests this copy; it never makes the Workspace path canonical, and consumers still name the
  artifact rather than its location. _Avoid_: Workspace-home Artifact, canonical Workspace copy.
- **Materialization conflict** — the condition in which a required **Workspace materialization** is missing or differs from its canonical Artifact
  version. Secant preserves both truths and halts rather than silently restoring or adopting either one.
- **Run Store** — the durable collection owned by exactly one **Run**, containing its structured truth, immutable Artifact history, publication
  staging, separately retained diagnostics, and its **Run working area**. Explicit Run deletion removes it as one lifecycle unit.
- **Run working area** — the one editable directory a **Run** owns for working files, such as Local planning spec and ticket files. It is isolated
  from the private database and Artifact repository, so a **Harness** may be granted it alone; it survives halt and resume and is deleted with the
  Run. Its files are the agent's and human's working state, never canonical Run truth or a **Run Artifact**. Prompts name it through the
  `{{run:working-area}}` slot. _Avoid_: Workspace, Run Store root.
- **Run owner** — the one Secant runtime process or task currently fenced and authorized to advance a **Run**, recorded as the owning process id
  plus a fencing epoch and held until the Run rests, through `running` and `blocked` alike. It is not the Harness process. _Avoid_: Workspace claim.
- **Workspace change** — any change inside the **Workspace** that is not a declared **Run Artifact**. Owned by the world and by Git, never by
  Secant's artifact graph.
- **Workspace prerequisite** — one of Secant's closed semantic predicates that an authored **Step** may add and **Preflight** evaluates. V1 has
  only `git-worktree-root`: Git must be runnable and the resolved Workspace must equal the root of a non-bare Git worktree. Linked and unborn
  worktrees qualify. It does not declare or discover tools that a script or **Harness** might invoke.
- **Harness Session** — a named conversation with the selected **Harness**, owned by exactly one **Run** and never shared across Runs. The routing
  names the session each agent **Step** runs in; Secant opens it on first use and reuses it after.
- **Turn** — one mechanical user-to-**Harness** exchange inside a **Harness Session**: submitted input, model and tool activity, streamed progress,
  and the Harness's authoritative turn boundary, the first one after which no **Steer** is still pending, so one Turn may span several native
  exchanges. It is neither a Session nor a judgement that the **Step** reached its goal. An **Agent step** has one autonomous Turn per attempt, plus
  any follow-up Turns the human starts after an **Interrupt**; an **Interactive agent step** may have many.
- **Session availability** — whether a **Harness Session** is `open` (a next Turn can be sent now), `detached` (not live, but holding a native
  recovery coordinate worth reattaching), or `unusable` (native evidence authoritatively says recovery cannot continue).
- **Model choice** — the **Run**'s one current model and effort level, each a real value the selected **Harness** names, never "Harness default". It
  is set at launch, preselected with the human's last Model choice for that Harness or else the defaults the Harness reports, saved with the Run, and
  changeable whenever the Run is open. Every **Turn** in every **Harness Session** of the Run requests the Model choice current when it starts. A
  Command-only Run carries none. _Avoid_: Selected model, model setting, Harness default.
- **Requested model** and **Requested effort** — what one **Turn** asked its **Harness** for, copied from the **Model choice** when the Turn starts.
  _Avoid_: Model override.
- **Effective model** and **Effective effort** — what one **Turn** was observed to run on, as the **Harness** reports it, or unknown when it reports
  nothing. They stay separate facts from the **Requested model** and **Requested effort** so a Harness substitution or fallback stays visible, and they
  never copy the request. _Avoid_: Served model.
- **Human Gate** — a Secant-owned pause carrying a Bundle-authored question in one of its shapes: approve/reject, whose rejection ends the
  **Run** `failed`, or free text. A free-text Gate may offer authored suggestions: quick-choice answers plus an Other free-text entry, and either way
  the answer is one durable text **Run Artifact**, so a Run can wait on one indefinitely.
- **Harness Request** — an ephemeral **Harness**-originated request raised during a **Turn**: either a tool approval with exact offered decisions
  or a structured clarification with an exact answer shape. A tool approval covers the Harness's own tools and the user's MCP servers' tools alike.
  It lives and dies with the Turn; an ordinary assistant question that ends a Turn is answered in the next Turn instead, and an **Agent call** is
  never one, because Secant, not the human, answers it.
- **Interactive agent step** — a **Step kind** whose **Harness Session** is handed to the human for turn-taking; unlike an **Agent step** it cannot
  complete without the human. Secant relays turns and authors nothing beyond the **Entry Turn**, and the step ends through a Secant-owned control
  given by the human or, when the Bundle opts the step in, by the agent's **Agent-declared completion** — never on an agent-emitted marker or a
  recognised phrase in a **Turn**. The legacy grill is this shape. A step may opt into an **Entry Turn**. Inside a **Repeat group** each
  iteration is its own **Step Attempt** with its own **Harness Session**; ending the step advances only that iteration.
- **Entry Turn** — an **Interactive agent step**'s optional first **Turn**: its Bundle-authored prompt, rendered with **Launch inputs** and bundled
  skill paths, sent once on entry so the human need not retype what the launch already carries. It is never re-sent: after an **Interrupt** or a halt the
  human continues the same **Harness Session**.
- **Steer** — a message the human sends while a **Turn** is live, delivered natively at the **Harness**'s next boundary and inside that Turn,
  which lasts until every Steer is delivered. Delivered means the Harness put it in front of the model, not that the model followed it. An
  **Interrupt** drops a Steer not yet delivered and returns its text to the human. _Avoid_: queued message.
- **Interrupt** — asking the **Harness** to stop the current live **Turn** and its foreground tool work. It ends only the Turn: the **Step Attempt**
  stays open and the **Run** waits `blocked` on the human, whose next message continues the same **Harness Session**. It does not close the
  Harness, halt the Run, or cancel it.
- **Cancel** — explicitly ending a **Run**. The only route to the terminal `cancelled` state.
- **Preflight** — the precondition check performed before a **Run** exists: the **Composition check**, presence of required **Launch inputs**, the
  union of authored **Workspace prerequisites**, intrinsic **Step kind** preconditions and Harness capability needs, and resolution of each selected
  **Command step** executable through `PATH`. A failed preflight creates no **Run**.
- **Composition check** — the static check that a **Routing** composes: every required **Run Artifact** is bound earlier with a matching type, each
  Bundle Asset, Prompt slot, and schema reference resolves correctly, each supported platform has a valid invocation, and every **Repeat group**'s
  **Verdict** is bound before entry. Runs at install and again at launch, since a **Run** pins a **Bundle Snapshot**.

## Run states

An Agent-bearing **Run** pins its semantic **Harness** selection with its **Workspace**, **Bundle Snapshot**, and **Launch inputs** at launch, plus an
**Model choice** beside that selection; a Command-only Run has no Harness selection and no model. The selected Harness is immutable recovery and
routing truth, while the Model choice may change between and during Turns; each Agent-step Attempt separately records the Harness executable, version,
and Adapter evidence, and each Turn its requested and effective model and effort.

| State       | Meaning                                                                       | Terminal |
| ----------- | ----------------------------------------------------------------------------- | -------- |
| `running`   | a **Step Attempt** is executing                                               | no       |
| `blocked`   | a **Human Gate**, **Harness Request**, or the human's next message is waiting | no       |
| `halted`    | stopped for a reason outside the workflow's logic                             | no       |
| `failed`    | the workflow concluded negatively                                             | no       |
| `succeeded` | the routing completed                                                         | yes      |
| `cancelled` | the user explicitly ended the Run                                             | yes      |

`blocked` is durable truth, not computed: since [#108](https://github.com/secantdev/secant/issues/108) the authored **Human Gate**'s `pending_gate`
row and the `blocked` state are written in one transaction, and execution also stores `blocked` before a checkpoint pause, so a killed Run reconciles
`blocked`. The interrupted condition of a Run marked live with no process running it is what is computed at open, not the state itself.

`running` and `blocked` are live states. `halted` and `failed` are resting, resumable states. `succeeded` and `cancelled` are terminal states.

## Rules

- Secant orchestrates around the **Harness**, never inside it. The Harness owns its own questions, tool approvals, and turn mechanics.
- Repetition and control read deterministic **Verdicts** about the world, never anything an agent says in a **Turn**. An **Agent-declared
  completion** is a deliberate call outside the Turn's content: it reaches only controls the human already has and never ends a Verdict-driven
  **Repeat group**.
- Secant owns the **Step kinds**; a **Workflow Bundle** owns content, parameters, and optional **Workspace prerequisites**. Behaviour that an
  ordinary Command can express does not earn another Step kind; other new behaviour waits for a new Secant-owned kind.
- Git has no Step kind and no public Secant Module. A Bundle obtains Git data or mutations through explicit **Command steps**, while a **Harness**
  may use Git under its own instructions and permissions. Secant neither injects Git observations nor gives Git-specific authorization,
  ground-truth tracking, or reconciliation; `git-worktree-root` is only a private Preflight probe.
- Declared **Run Artifacts** receive their type's native validation. A `file` launch input or produced artifact may additionally opt into bundled
  JSON Schema validation; other content is not interpreted. A repair is a retry in the same **Harness Session**, not a concept.
- A producer creates **Candidate output**; Secant alone performs **Artifact publication**. Every output of one **Step Attempt** publishes together
  or none does, and failed, cancelled, or **Indeterminate attempts** leave previous bindings current.
- Every published Artifact version has canonical Run-owned content. `home: workspace` requests a **Workspace materialization**, never an alternative
  source of truth. A changed or missing materialization is a **Materialization conflict**, not a new Artifact version.
- Run-owned canonical truth and Artifact versions remain until explicit Run deletion. Detailed diagnostics are separate and expire after 90 days by
  default; exactly reproducible caches may be collected earlier.
- Any number of **Runs** may be live in one **Workspace**; each live Run has exactly one **Run owner**, and a second instance is refused for that Run
  only. No Run holds a Workspace claim, so Secant never promises a Run's Workspace is unchanged between Steps or when it resumes.
- No **Step** is skippable. The **Routing** advances only by a Step completing, and no decision may jump over one. A **Repeat group** whose
  **Verdict** already passes runs zero **Iterations**, which is a loop that did not run rather than a Step that was skipped.
- **Bundle Assets** are not **Run Artifacts**: they have no producer, no per-attempt version, and no place in the bindings.
- Uninstalling an Installed Bundle preserves its Runs' Bundle Snapshots and history but not duplicate Bundle bytes. A resting Run resumes only when
  its exact Bundle digest is installed.

## Related decisions

- [Workflow Bundle](./workflow-bundle.md) owns the package, installation, trust, and removal contract that a Bundle Snapshot refers to.
- [Projection Views](./projection-views.md) owns the **Launch draft** that requests a model and the client Projection families and view freshness
  that read this Run.
- [ADR 0019](../adr/0019-failed-and-halted-runs-are-resumable-resting-states.md) owns Run resumability and the reset-on-resume rule.
- [ADR 0020](../adr/0020-deterministic-verdicts-and-human-checkpoints-terminate-repetition.md) owns how repetition terminates and why the legacy
  agent-emitted marker is retired.
- [ADR 0032](../adr/0032-let-opted-in-interactive-agent-steps-accept-agent-declared-completion.md) owns **Agent-declared completion**, its answer
  to ADR 0020's reasons, and the human-controlled group's **Review checkpoint**.
- [ADR 0033](../adr/0033-carry-agent-calls-to-secant-over-a-per-session-loopback-mcp-server.md) owns the **Agent call**'s channel, its
  attribution to a **Harness Session**'s live **Turn**, and its reply.
- [ADR 0035](../adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) owns what an **Interrupt** leaves behind,
  **Steer** delivery, and why a Turn lasts until every Steer is delivered.
- [ADR 0023](../adr/0023-own-durable-run-truth-in-isolated-run-stores.md) owns durable Run truth, Artifact publication, Workspace materialization,
  retention, and recovery storage.
- [ADR 0031](../adr/0031-own-runs-per-run-not-per-workspace.md) owns Run ownership: many live Runs per Workspace, one owner per Run, and what a
  dead or alive owner means at startup.
- [Define the minimum generic Workflow capabilities](https://github.com/DevFlow-HQ/devflow-cli/issues/13) records the step vocabulary and the rules
  by which a **Routing** composes.
- [Decide which Git operations Crucible performs for a Workflow and where they sit in the routing](https://github.com/DevFlow-HQ/devflow-cli/issues/14)
  records why Git uses Command and Harness behaviour rather than a dedicated Step kind or public Module, and introduces **Workspace prerequisite**.
- [Define Crucible's product domain and lifecycle](https://github.com/DevFlow-HQ/devflow-cli/issues/4) records the full model and its rationale.
- [Define durable Run truth, outputs, Artifacts, transcripts, and recovery](https://github.com/DevFlow-HQ/devflow-cli/issues/16) records the complete
  persistence and recovery contract.
