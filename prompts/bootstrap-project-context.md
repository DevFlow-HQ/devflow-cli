# Bootstrap Project Context

Create a bounded repository orientation for future DevFlow stages. Use ecosystem-neutral inspection categories instead of assuming a specific language, package manager, or framework.

Inspect only enough repository files to understand:
- Purpose: what this project appears to do.
- Architecture: the main modules, runtime boundaries, and data or control flow.
- Key paths: source, tests, configuration, docs, scripts, and generated/state directories that matter.
- Commands: available test, typecheck, build, run, or validation commands.
- Conventions: naming, testing style, state/artifact layout, and contribution patterns visible in the repository.

Write light Markdown structure to this absolute candidate path:
{{CANDIDATE_PATH}}

Required output:
- Non-empty Markdown.
- No more than 150 lines.
- Include sections for purpose, architecture, key paths, commands, and conventions.
- Keep it factual and concise.
- Do not include raw task details or intent classification details.

After writing the candidate artifact, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
