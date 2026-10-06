// Test-only construction of the native Harness Adapters. Each production `prepare`
// takes the Process Interface as an explicit option — composition supplies the
// invocation's instance to qualification and each Run's own to that Run (#333).
// Tests almost always want the real Process implementation, so this helper
// supplies it to every prepare by default while still letting a suite inject a
// scripted Process double (e.g. `processWithSpawn`), here or in the prepare's own
// options. Keeping the default here, rather than in the shipped Adapter, keeps the
// production interface honest: it never constructs a hidden dependency of its own.
// The default reports its children to the running runner program's breadcrumbs (a
// no-op outside one), so a Harness child shows in a runtime-conformance failure
// summary.

import {
  createClaudeCodeAdapter as createNativeClaudeCodeAdapter,
  createCodexAdapter as createNativeCodexAdapter,
  type HarnessAdapter,
  type PrepareOptions,
  type PrepareResult,
} from "../../src/harness/harness.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../src/process/process.js";
import { withRunnerObserver } from "../helpers/standalone.js";

/** Prepare options whose Process is optional: the test Adapter supplies one. */
export type TestPrepareOptions = Omit<PrepareOptions, "process"> & {
  readonly process?: ProcessAdapter;
};

/** A Harness Adapter whose prepares default their Process. It is still a
 *  `HarnessAdapter`, so composition and the shared suites accept it. */
export interface TestHarnessAdapter extends Pick<HarnessAdapter, "close"> {
  prepare(options: TestPrepareOptions): Promise<PrepareResult>;
}

/** The parameter the shared conformance suite is run against. */
export type TestHarnessAdapterFactory = () => TestHarnessAdapter;

type ClaudeCodeOverrides = Parameters<typeof createNativeClaudeCodeAdapter>[0];
type CodexOverrides = Parameters<typeof createNativeCodexAdapter>[0];

export function createClaudeCodeAdapter(
  overrides: ClaudeCodeOverrides = {},
  processAdapter?: ProcessAdapter,
): TestHarnessAdapter {
  return withProcess(createNativeClaudeCodeAdapter(overrides), processAdapter);
}

export function createCodexAdapter(
  overrides: CodexOverrides = {},
  processAdapter?: ProcessAdapter,
): TestHarnessAdapter {
  return withProcess(createNativeCodexAdapter(overrides), processAdapter);
}

function withProcess(
  adapter: HarnessAdapter,
  processAdapter: ProcessAdapter = createProcessAdapter(withRunnerObserver()),
): TestHarnessAdapter {
  return {
    close: (options) => adapter.close(options),
    prepare: (options) =>
      adapter.prepare({
        ...options,
        process: options.process ?? processAdapter,
      }),
  };
}
