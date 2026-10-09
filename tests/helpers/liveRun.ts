import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import type { TestContext } from "node:test";
import type { ProjectionPort } from "../../src/application/projection-port.js";
import {
  createTurnEventProducerForTest,
  type TurnEvent,
} from "../../src/harness/harness.js";
import { readTurnFact } from "../../src/run/store/store.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import type { RequestChannel } from "../../src/run/execution/execution.js";
import type { RunOwner } from "../../src/run/store/store.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";
import { createApplication } from "./application.js";
import { hostPlatform, writeCommandBundle } from "./commandBundle.js";
import { awaitSettled } from "./settleOperation.js";
import { makeTempDir } from "./tempDir.js";

/** The Implementation's private bound on one subscription's unread backlog
 *  (src/application/update-stream.ts, #306), mirrored once here so every observer
 *  suite asserts the same boundary; changing the bound must change these. */
export const UNREAD_UPDATE_BOUND = 1_000;
export const UNREAD_UNIT_BOUND = 8 * 1024 * 1024;

/** `count` scripted usage Turn events, `p0` onward. */
export function usageEvents(count: number): TurnEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "usage" as const,
    observation: { summary: `p${index}` },
  }));
}

export interface LiveRun {
  readonly port: ProjectionPort;
  readonly runId: string;
  readonly storeHome: string;
  readonly owner: RunOwner;
  readonly channel: RequestChannel;
  reopen(): ProjectionPort;
  /** Let the injected execution return `succeeded`, then await the launch outcome. */
  finish(): Promise<void>;
  /** End observation while releasing the injected drive so shutdown can drain. */
  shutdown(): Promise<void>;
}

/** Launch a Run whose injected execution holds its Turn open: the test drives every
 *  durable write, live overlay, and preview through the execution's own owner and
 *  request channel, so the update order and count are exact and no child spawns. */
export async function openLiveRun(
  t: TestContext,
  options: {
    onHistoryRead?: () => void;
    onCensusRead?: () => void;
    scheduleRunUpdate?: (callback: () => void, delayMs: number) => () => void;
    /** Populate canonical fixture facts before Application observes this owner. */
    seedRun?: (context: {
      readonly owner: RunOwner;
      readonly storeHome: string;
    }) => void;
    scheduleHistoryPreview?: (
      callback: () => void,
      delayMs: number,
    ) => () => void;
  } = {},
): Promise<LiveRun> {
  const catalog = openCatalog(makeTempDir("secant-lag-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-lag-ws-"));
  const storeHome = makeTempDir("secant-lag-store-");
  const rawGroup = openRunGroup(storeHome, workspace);
  let seeded = false;
  const runGroup = {
    ...rawGroup,
    listRuns() {
      options.onCensusRead?.();
      return rawGroup.listRuns();
    },
    countRuns() {
      options.onCensusRead?.();
      return rawGroup.countRuns();
    },
    acquireRun(...args: Parameters<typeof rawGroup.acquireRun>) {
      const owner = rawGroup.acquireRun(...args);
      if (owner === undefined) return undefined;
      if (!seeded) {
        options.seedRun?.({ owner, storeHome });
        seeded = true;
      }
      return {
        ...owner,
        get record() {
          return owner.record;
        },
        turns() {
          options.onHistoryRead?.();
          return owner.turns();
        },
        turnEvents() {
          options.onHistoryRead?.();
          return owner.turnEvents();
        },
        transcript() {
          options.onHistoryRead?.();
          return owner.transcript();
        },
        harnessSessions() {
          options.onHistoryRead?.();
          return owner.harnessSessions();
        },
      };
    },
  };
  t.after(() => runGroup.close());
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: (context: { owner: RunOwner; channel: RequestChannel }) => void;
  const running = new Promise<{ owner: RunOwner; channel: RequestChannel }>(
    (resolve) => {
      started = resolve;
    },
  );
  const app = createApplication({
    ...options,
    catalog,
    // Preflight resolves the Command Bundle's executable; nothing ever spawns.
    process: createFakeProcess({
      resolutionHandler: (name) => ({
        kind: "found",
        executable: name,
        prefixArgs: [],
      }),
    }),
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: async ({ owner, requestChannel }) => {
      owner.writeState("running");
      assert.ok(requestChannel);
      // Drive the production normalized-event retention policy, just as a Harness does.
      // Direct test Store writes bypass that policy unless this shared seam composes it.
      type ProducerState = {
        producer: ReturnType<typeof createTurnEventProducerForTest>;
        request?: Parameters<RunOwner["appendTurnEvent"]>[0];
        receipt?: ReturnType<RunOwner["appendTurnEvent"]>;
        session?: string;
      };
      const producers = new Map<string, ProducerState>();
      function producerFor(turnId: string) {
        const entry = producers.get(turnId);
        if (entry !== undefined) return entry;
        const state: ProducerState = {
          producer: createTurnEventProducerForTest(),
        };
        state.producer.subscribe((event) => {
          if (event.kind === "tool-preview" && state.session !== undefined)
            requestChannel!.observe({
              tool: { turnId, session: state.session, call: event.call },
            });
          else if (
            (event.kind === "tool-call" || event.kind === "tool-partial") &&
            state.request !== undefined
          )
            state.receipt = owner.appendTurnEvent({
              ...state.request,
              payload: JSON.stringify(event.call),
            });
        });
        producers.set(turnId, state);
        return state;
      }
      const normalizedOwner: RunOwner = {
        ...owner,
        get record() {
          return owner.record;
        },
        appendTurnEvent(request) {
          const fact = readTurnFact(request);
          if (
            (fact?.kind !== "tool-call" && fact?.kind !== "tool-partial") ||
            fact.data.tool !== "command"
          )
            return owner.appendTurnEvent(request);
          const entry = producerFor(request.turnId);
          entry.request = request;
          entry.receipt = undefined;
          if (
            fact.kind === "tool-partial" &&
            fact.data.output?.incomplete === true &&
            fact.data.outcome.kind === "running"
          )
            entry.producer.emit({
              kind: "tool-partial",
              call: {
                ...fact.data,
                outcome: { kind: "running" },
                output: { ...fact.data.output, incomplete: true },
              },
            });
          else entry.producer.emit({ kind: "tool-call", call: fact.data });
          entry.request = undefined;
          return entry.receipt ?? { ok: true };
        },
      };
      const normalizedChannel: RequestChannel = {
        ...requestChannel,
        observe(observation) {
          if (
            observation.tool === undefined ||
            observation.tool.call.tool !== "command"
          ) {
            requestChannel!.observe(observation);
            return;
          }
          const entry = producerFor(observation.tool.turnId);
          entry.session = observation.tool.session;
          entry.producer.emit({
            kind: "tool-preview",
            call: { ...observation.tool.call, outcome: { kind: "running" } },
          });
        },
      };
      started({ owner: normalizedOwner, channel: normalizedChannel });
      await released;
      owner.writeState("succeeded");
      return { outcome: "succeeded" };
    },
  });
  const bundle = writeCommandBundle({ id: "dev.secant.observer-lag" });
  assert.ok(app.bundleManagement.build(bundle.folder, { noInstall: false }).ok);
  const entry = catalog.listEntries().find((item) => item.id === bundle.id)!;
  catalog.approveWorkspace(workspace, new Date());
  const port = app.projectionPort;
  const launched = port.submit({
    operationId: "launch-lag",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launched.admitted, JSON.stringify(launched));
  const { owner, channel } = await running;
  return {
    port,
    runId: launched.runId!,
    storeHome,
    owner,
    channel,
    reopen: () =>
      createApplication({
        catalog,
        process: createFakeProcess({}),
        launchWorkspacePath: workspace,
        hostPlatform: hostPlatform(),
        runGroup,
      }).projectionPort,
    async shutdown() {
      const shuttingDown = app.shutdown();
      release();
      await shuttingDown;
    },
    async finish() {
      release();
      const outcome = await awaitSettled(port, "launch-lag");
      assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    },
  };
}
