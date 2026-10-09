# Codex Adapter internals

Read before changing the private Codex Adapter.
[Harness adapters](./harness-adapters.md) owns shared entry guidance and phase mapping.

## Codex qualification and Turns

- `codex.ts` owns orchestration, cache, and profile; `codex/qualification.ts` owns bounded pre-thread validation and diagnostics; `codex/runtime-protocol.ts`
  owns retained JSONL state and normalization; `codex/required-schema.ts` owns generated-schema compatibility. Native protocol types stay private.
- Every `prepare` observes `codex --version`; cached schema evidence is keyed by discovery source, path, SHA-256 identity, version, platform, and revision.
  The host platform driving discovery/profile is immutable; only the cache-key test seam varies platform evidence. A hit skips schema generation only
  and retains the disabled display-fact set; every Prepared Harness receives that generation's set.
- `required-schema.ts` applies the [shared classification rule](./harness-adapters.md#required-and-optional-native-facts) with named required and
  optional lists, collecting every failure. Missing optional definitions degrade only their display. Completed Thought summaries and summary previews
  qualify independently; provider/model evidence still comes only from `qualifiesThoughtSummary`. The private set gates runtime parsing, not Steer
  item identity. Steer-only item kinds require only `id` and `type`, never unused payloads. Malformed enabled accounting leaves prior observations intact.
  Profiles expose only readable limits. `thread/started`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated` and
  `item/mcpToolCall/progress` are unconsumed and have no qualification role; the change that first reads one classifies it.
- Live qualification sends one `initialize` then `initialized`, runs bounded `account/read` and `model/list`, and transfers its child and connection.
  `model/list` entries keep each model's `supportedReasoningEfforts` and `defaultReasoningEffort` as reported (a model with no efforts gets no
  default), and its `isDefault` model is the defaults fallback. One page is read (`cursor: null`); `nextCursor` is not followed.
- `readDefaults` sends `config/read` for the Workspace on the transferred connection, bounded by `controlTimeoutMs`, only when called (the qualify
  path), so Run prepares and their strict recordings never carry it. It is not in `required-schema.ts`: a failed, timed-out, or malformed read falls
  back with its reason instead of failing qualification, and a configured model outside `model/list` or an unoffered effort falls back or takes the
  model's default effort. A fallback reason is read by a person, so it names no RPC and carries no native message. It reports no phase.
- A fresh Session gets `thread.id` before admission; a detached Session requires its exact `thread/resume` id. Any bad acknowledgement makes it
  `unusable`; no fallback. A caller's resume matching the thread still live on this connection skips `thread/resume` and sends the next `turn/start`.
- The Prepared Harness owns one replaceable app-server generation. An Adapter-ended generation detaches every Session before EOF;
  the next Turn rediscovers and checks the qualified path, SHA-256 digest and version, then repeats full live qualification through its prepare's Process.
  Replacement failures (`recovery-identity` or `recovery-app-server`, no possible effects) leave Sessions detached for retry; a refused resume fences only
  that Session. An incompletely reaped generation is retained for cleanup and refuses replacement until it is reaped, preventing duplicate app-servers.
  Sessions resend their thread config on resume. Turns bind after replacement; retired generations cannot dispatch into newer Turns.
- A native command `declined` terminal settles its exact call independently of approvals (#501), releasing pending output state. Refusal reason,
  output, exit and command duration stay absent; Turn outcome remains its own native fact.
- Running file-change items expose structured target paths only (#502). Supplied patches and qualified change kinds remain completion facts.
- Fresh/resumed Turns keep admission-before-content and terminal authority; finals replace previews. Command/summary assembly follows linked provenance (#415, #417).
- Effective values (#345): `turn/start` carries the Model choice; first acceptance sends one bounded `thread/read` (a refusal re-sent at the next item)
  as the observation, and a matching `model/rerouted` replaces the model. A failed or late read leaves values unknown, never holding the Turn.
- Codex client RPC and reverse-request ids have separate private maps. Approvals expose exact actions. A native resolution or terminal confirms an answer
  whose send has started, emitting `request-answered` before settlement; earlier resolution or terminal expires it. Close and local failures expire
  unconfirmed answers, including in-flight writes. A write failure after native confirmation cannot retract the answer.
- Native Steer and Interrupt await bounded RPC acknowledgement for exact active ids. Only matching interrupted completion proves interruption. Windows launch
  evidence bounds terminal confirmation, closes the producer and reaps the generation before settlement. Every Session detaches and recovers on one replacement.
  EOF cannot erase confirmation. Missing confirmation reaps then settles `lost`; an RPC refusal leaves the Turn live. POSIX keeps its server.
- A Steer's `userMessage` (`clientId`) puts it in history, which delivers it (ADR 0035) at the next model output (agent, reasoning, plan, or tool
  item, delta, approval; never hook prompt or compaction) or any other end. In history with none by a `completed`/`failed` terminal, it is a
  leftover (#357): absent an Interrupt or close it is re-sent once, empty input then text on RPC refusal, on a new native turn id whose target slot
  waiting controls follow, settling `re-delivered`. Refused twice, the terminal stands; an unanswered re-send start loses the Turn.
- `CodexTurn` keeps approval correlation and native control together because both share terminal-ordering state. A third Harness needing the same shapes
  triggers their split; before then, splitting only relocates coupling.
- Codex close rejects new work, expires requests, attempts bounded native interruption, closes stdin, and reaps the tree; cleanup cannot rewrite Turn truth.
- Timeout split: `handshakeTimeoutMs` bounds prepare and replacement qualification (spawn → `initialize`/`account`/`model`); `controlTimeoutMs`
  (defaults to it) bounds post-qualification live exchanges (session start/resume, Turn start/interrupt/steer acks). A stall-then-timeout test squeezes
  `controlTimeoutMs`, never `handshakeTimeoutMs` — throttling the spawn+handshake there flakes `prepare` on a loaded Windows runner (the #148 CI flake).
- Opted-in Codex Sessions attach `secant` through start and every exact resume, reusing their token and fixed tools across replacement (#370).
  `approvalsReviewer: "user"` keeps requests human-routed; MCP tool elicitations expose Allow/Deny. Other elicitations and user input are declined.
  Declined elicitation evidence crosses the Harness Interface as data; Application owns its words. Native MCP metadata only cross-checks attribution.
- Codex inherits user environment/home; unauthenticated becomes the fixed separate-login remediation, and no account or credential crosses the Seam.
- The per-thread `sandbox_workspace_write.writable_roots` override (#214) **replaces** any user-configured extra `writable_roots` for that thread rather than
  merging them (a `ponytail:` in `codex.ts`; merge via `config/read` if a user relies on both). `sandboxAdmitsDirectory` compares roots through
  `realpathSync.native`, since Codex may report a resolved path, and refuses only a `workspaceWrite` sandbox that omits the root; every other posture stays the user's.
