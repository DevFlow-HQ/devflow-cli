# Grill Interview

Run the interactive grill stage before DevFlow continues.

Raw task:
{{RAW_TASK}}

Intent artifact path:
{{INTENT_ARTIFACT_PATH}}

Intent artifact:
{{INTENT_ARTIFACT}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

Clarification context:
{{CLARIFICATION_CONTEXT}}

Partial transcript context:
{{PARTIAL_TRANSCRIPT_CONTEXT}}

Behavior:
- Ask one question at a time.
- Include 2-3 recommended answers for each question when useful.
- Use the raw task, intent artifact, and project context as the source of truth.
- Inspect the repository when codebase context can answer a question.
- Do not ask the user for facts that can be answered by reading repository files.
- Continue until the implementation goal, constraints, success criteria, and major risks are clear enough for PRD synthesis.

Conclusion handshake:
- Before concluding the interview, ask the user a final conclusion question that gives them a marker-free chance to raise any remaining questions or concerns.
- The conclusion question turn must not contain the completion marker.
- Example conclusion question: "Before I conclude the grill, do you have any remaining questions, concerns, or corrections I should resolve?"
- Any raised concern means you must continue the grill, resolve the concern, and ask the conclusion question again later.
- Only after explicit user approval to conclude may your next turn contain only the completion marker and no other text.

Completion marker discipline:
- The completion marker is DevFlow's single done signal for this stage. Emitting it tells DevFlow the grill work is finished; DevFlow will immediately move on, and you get no further turns for that work.
- Emit it exactly once, and only after the conclusion handshake is satisfied.
- Never omit the marker when the grill is done, or DevFlow will wait instead of advancing.
- Never emit the marker prematurely, or DevFlow will advance before the grill is complete.

After the grill is complete and the conclusion handshake is satisfied, reply with only this completion marker and no other text:
{{COMPLETION_MARKER}}
