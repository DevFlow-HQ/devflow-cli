import {
  createApplication as createApplicationWithProcess,
  type ApplicationDependencies,
} from "../../src/application/application.js";
import type { ProcessAdapter } from "../../src/process/process.js";

function refuseProcess(): never {
  throw new Error(
    "test helper: constructed an Application without an injected `process`; " +
      "inject a fake Process (createFakeProcess from tests/process/fake-adapter.ts) — " +
      "the real Process is never reachable from the test runner",
  );
}

// A Process whose every method throws. The compatibility helper injects it when a
// suite omits `process`, so a test that reaches child-process behavior through the
// helper fails loudly here instead of silently reaching the real Process (M5 audit
// #199 A21). No default wires the real Process implementation into the test runner.
const missingProcess: ProcessAdapter = {
  resolveExecutable: refuseProcess,
  spawnCommand: refuseProcess,
  spawnCommandSync: refuseProcess,
  spawnOwnedProcess: refuseProcess,
};

type TestApplicationDependencies = Omit<ApplicationDependencies, "process"> & {
  readonly process?: ApplicationDependencies["process"];
};

/** Compatibility wiring for suites migrated by the following evidence slices. */
export function createApplication(deps: TestApplicationDependencies) {
  return createApplicationWithProcess({
    ...deps,
    process: deps.process ?? missingProcess,
  });
}
