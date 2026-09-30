// The minimal CI workflow that passes every release-workflow guard, shared by the
// checker's synthetic tests and the structural step's pinned reports. Each negative
// case edits a fresh copy to break exactly one guard.

export type Jobs = Record<string, Record<string, unknown>>;

/** The jobs of a workflow built by `validWorkflow`, for editing in place. */
export const jobsToEdit = (workflow: Record<string, unknown>) =>
  workflow.jobs as Jobs;

/** The steps of one of those jobs, for editing in place. */
export const stepsToEdit = (job: Record<string, unknown>) =>
  job.steps as Record<string, unknown>[];

export function validWorkflow(): Record<string, unknown> {
  return {
    on: { push: null, pull_request: null, workflow_dispatch: null },
    jobs: {
      check: {
        "runs-on": "ubuntu-latest",
        steps: [{ run: "bun run check" }],
      },
      build: {
        "runs-on": "ubuntu-latest",
        steps: [
          { run: "bun run scripts/build.ts --all" },
          { run: "bun run scripts/assemble.ts" },
          { run: "bun run scripts/pack.ts" },
          { run: "bun run scripts/pack-launcher.ts" },
          { run: "bun run scripts/inventory.ts" },
          {
            name: "Dry-run",
            if: "github.event_name == 'workflow_dispatch'",
            env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" },
            run: "bun scripts/npm-dry-run.ts dist/packages",
          },
        ],
      },
      smoke: {
        needs: "build",
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/download-artifact@v4" },
          { run: "bun scripts/package-smoke.ts dist/secant-linux-x64" },
        ],
      },
      "release-approval": {
        needs: ["check", "build", "smoke"],
        if: "startsWith(github.ref, 'refs/tags/v')",
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/download-artifact@v4" },
          { run: "bun scripts/release-gate.ts dist/release" },
        ],
      },
      promote: {
        needs: "release-approval",
        if: "startsWith(github.ref, 'refs/tags/v')",
        "runs-on": "ubuntu-latest",
        environment: "release",
        permissions: { contents: "write" },
        steps: [
          { uses: "actions/checkout@v4" },
          {
            uses: "actions/download-artifact@v4",
            with: { name: "release-archives", path: "dist/release" },
          },
          {
            uses: "actions/download-artifact@v4",
            with: { name: "platform-packages", path: "dist/packages" },
          },
          {
            env: {
              NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}",
              GH_TOKEN: "${{ github.token }}",
            },
            run: "bun scripts/release-promote.ts dist/release dist/packages",
          },
        ],
      },
    },
  };
}
