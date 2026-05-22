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

After writing the artifact, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
