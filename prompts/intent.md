# Intent Classification

Classify only the raw task. Do not use project context, repository files, prior run artifacts, or inferred implementation details.

Raw task:
{{RAW_TASK}}

Write a strict JSON object to this absolute artifact path:
{{ARTIFACT_PATH}}

Schema requirements:
- The artifact must be valid JSON.
- The root value must be an object with no extra keys.
- Required keys:
  - "classification": "feature" | "bug" | "refactor" | "unclear"
  - "summary": non-empty string
  - "rawTask": non-empty string copied from the raw task
  - "needsClarification": boolean

Completion marker discipline:
- The completion marker is DevFlow's single done signal for this stage. Emitting it tells DevFlow this stage's work is finished; DevFlow will immediately move on, and you get no further turns for that work.
- Emit it exactly once, alone, only after you have written and validated the required artifact.
- Treat omission and premature emission as equal failures: never omit the marker when the work is done, and never emit it prematurely.

After writing and validating the artifact, reply with only this completion marker and no other text:
{{COMPLETION_MARKER}}
