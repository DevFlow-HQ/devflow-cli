# PRD Synthesis

Synthesize the canonical PRD from the completed grill session. Do not interview the user or ask follow-up questions.

Raw task:
{{RAW_TASK}}

Intent artifact path:
{{INTENT_ARTIFACT_PATH}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

Live discussion context:
{{LIVE_DISCUSSION_CONTEXT}}

Persisted grill transcript path:
{{GRILL_TRANSCRIPT_PATH}}

Canonical PRD artifact path:
{{PRD_ARTIFACT_PATH}}

Behavior:
- Use the just-completed live discussion when present.
- Treat the persisted grill transcript as the durable source of decisions.
- Synthesize from known context only.
- Write only the canonical run PRD artifact at the path above.
- Do not write issues, implementation plans, validation files, or alternate PRDs.
- Keep the PRD specific enough for downstream MVP stages to use without reading the grill transcript.

After writing the PRD artifact, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
