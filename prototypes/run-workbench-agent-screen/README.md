# PROTOTYPE — Run Workbench as an agent screen (#247)

Throwaway. Nothing in `src/` imports it; it reads only the vendored theme module. It lives on
`prototype/issue-247-run-workbench-agent-screen` and never merges.

**Question.** What should the Run Workbench look like as a mirror of the agent, the way OpenCode's session screen is, rather
than a literal event timeline? The evidence that settles it is you choosing one of the variants below, or combining parts of them, in a real terminal.

## Run

    bun run prototype:workbench                  # optional: -- --variant=B --scene=steer

| Key           | Does                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| alt+1 / 2 / 3 | Variant: A OpenCode mirror, B Transcript + sidebar, C Step-sectioned                                                        |
| alt+n / alt+p | Next / previous scene (10): working, question, request, gate, checkpoint, steer, steer-late, interrupt, step-done, finished |
| alt+t         | Cycle vendored themes                                                                                                       |
| alt+r         | Reasoning-summary rows on/off (the ADR 0022 question)                                                                       |
| alt+x         | Jump to scene 1 and replay its live Turn                                                                                    |
| ctrl+o        | Expand/collapse truncated output, thoughts, the Entry prompt, and C's folded Steps                                          |
| esc esc       | Interrupt (jumps to the interrupt scene)                                                                                    |
| enter         | Send; mid-Turn it is a Steer that waits, then reads as delivered                                                            |
| PgUp / PgDn   | Scroll the transcript                                                                                                       |
| ctrl+c        | Quit                                                                                                                        |

`bun test prototypes/run-workbench-agent-screen/smoke.test.tsx` renders every variant × scene headlessly (`SHOW=1` prints the frames).
