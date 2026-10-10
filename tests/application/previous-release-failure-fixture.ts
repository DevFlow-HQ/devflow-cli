import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  createApplication,
  type Application,
} from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";

// The authentic pre-M11 failure home (#536) opened through the real Application,
// for both clients' acceptance. `injectNewerEvidence` is the one synthetic fault:
// it writes facts a newer Secant might leave into an already migrated copy.

const fixture = new URL(
  "../fixtures/previous-release-failure-evidence/",
  import.meta.url,
);
const json = (name: string) =>
  JSON.parse(readFileSync(new URL(name, fixture), "utf8"));
const provenance = z
  .object({
    workspace: z.string(),
    databases: z.array(z.object({ path: z.string() })),
  })
  .parse(json("provenance.json"));
const runs = z
  .object({
    runs: z.tuple([
      z.object({ rest: z.literal("halted"), runId: z.string() }),
      z.object({ rest: z.literal("failed"), runId: z.string() }),
    ]),
  })
  .parse(json("expected.json")).runs;

export const HALTED_RUN = runs[0].runId;
export const FAILED_RUN = runs[1].runId;

const groupDir = dirname(
  provenance.databases.find((d) => d.path.endsWith("/coordination.db"))!.path,
);

/** A private copy of the predecessor home; the checked-in fixture never opens. */
export function copyPreviousReleaseHome(): string {
  const home = makeTempDir("secant-previous-release-failure-");
  cpSync(fixture, home, { recursive: true });
  return home;
}

/** Open the home through the real Application (migrating it on first open),
 *  run `use`, then shut everything down. */
export async function withPreviousReleaseApplication<T>(
  home: string,
  use: (app: Application) => Promise<T>,
): Promise<T> {
  const catalog = openCatalog(home);
  const group = openFakeRunGroup(home, provenance.workspace, {
    isOwnerAlive: () => false,
  });
  const app = createApplication({
    catalog,
    runGroup: group,
    process: createFakeProcess({}),
    launchWorkspacePath: home,
    hostPlatform: hostPlatform(),
  });
  try {
    return await use(app);
  } finally {
    await app.shutdown();
    group.close();
    catalog.close();
  }
}

/** The newer-Secant diagnostic the halted Run's unknown Resting cause names. */
export const NEWER_DIAGNOSTIC =
  "Kind: newer-cause\nRecorded by a newer Secant.\n";

/** One Failure-evidence row a newer Secant might have written. */
interface NewerEvidence {
  readonly runId: string;
  readonly attemptId: string;
  readonly source: string;
  readonly code: string;
  readonly possibleEffects: string;
  readonly details: object;
}

const VALID_DETAILS = { outputName: "build-log", sizeLimit: 1024 };

/** One per failed predecessor Attempt, each unknown in exactly one field. */
const NEWER_EVIDENCE: readonly NewerEvidence[] = [
  {
    runId: HALTED_RUN,
    attemptId: "0.0:build",
    source: "newer-source",
    code: "receipt-too-large",
    possibleEffects: "none",
    details: VALID_DETAILS,
  },
  {
    runId: HALTED_RUN,
    attemptId: "0.1:build",
    source: "receipt",
    code: "receipt-newer",
    possibleEffects: "unknown",
    details: VALID_DETAILS,
  },
  {
    // Well-formed JSON missing the size limit this code requires.
    runId: FAILED_RUN,
    attemptId: "0.0:build",
    source: "receipt",
    code: "receipt-too-large",
    possibleEffects: "unknown",
    details: { outputName: "build-log" },
  },
  {
    runId: FAILED_RUN,
    attemptId: "0.1:build",
    source: "receipt",
    code: "receipt-too-large",
    possibleEffects: "newer",
    details: VALID_DETAILS,
  },
];

/**
 * Write facts this Secant does not know into a migrated copy: `NEWER_EVIDENCE`,
 * and an unknown Resting-cause code with an existing diagnostic on the halted Run.
 */
export function injectNewerEvidence(home: string): void {
  const runDatabase = (runId: string) =>
    new Database(join(home, groupDir, runId, "run.db"));
  for (const row of NEWER_EVIDENCE) {
    const db = runDatabase(row.runId);
    try {
      db.query(
        "INSERT INTO failure_evidence (evidence_id, attempt_id, source, code, possible_effects, details, at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-09T00:00:00.000Z')",
      ).run(
        `${row.runId}-${row.attemptId}`,
        row.attemptId,
        row.source,
        row.code,
        row.possibleEffects,
        JSON.stringify(row.details),
      );
    } finally {
      db.close();
    }
  }
  const halted = runDatabase(HALTED_RUN);
  try {
    halted.exec(
      "UPDATE run_record SET resting_cause_code = 'newer-cause', resting_cause_diagnostic_id = 'newer-diagnostic'",
    );
  } finally {
    halted.close();
  }
  const diagnostics = join(home, groupDir, HALTED_RUN, "diagnostics");
  mkdirSync(diagnostics, { recursive: true });
  writeFileSync(join(diagnostics, "newer-diagnostic"), NEWER_DIAGNOSTIC);
}
