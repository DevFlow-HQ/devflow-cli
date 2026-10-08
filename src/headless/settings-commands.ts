import { headlessJson } from "./json.js";
import { randomUUID } from "node:crypto";
import { settledOperation } from "./operation-settlement.js";
import type { Command } from "commander";
import type {
  AppearancePreferences,
  ChangePreferencesInput,
  ProjectionPort,
  Problem,
} from "../application/projection-port.js";
import type { CommandExecutor, HeadlessIO, SettleAction } from "./headless.js";

function printPair(io: HeadlessIO, pair: AppearancePreferences): void {
  io.out(`Theme: ${pair.theme}\nAppearance: ${pair.appearance}\n`);
}
export function registerSettingsCommands(
  program: Command,
  deps: {
    readonly io: HeadlessIO;
    readonly execute: CommandExecutor;
    readonly settle: SettleAction;
    readonly fail: (io: HeadlessIO, json: boolean, problem: Problem) => number;
  },
) {
  const { io, execute, settle, fail } = deps;
  const settings = program
    .command("settings")
    .description("read and change saved appearance Preferences")
    .action(() => {
      settings.outputHelp();
    });
  settings
    .command("show")
    .description("show saved theme and appearance")
    .option("--json", "print the saved pair as JSON")
    .action((options: { json?: boolean }) =>
      settle(
        execute((clients) =>
          showPreferences(clients.projectionPort, io, options.json ?? false),
        ),
      ),
    );
  settings
    .command("set")
    .description("save supplied theme and appearance")
    .option("--theme <id>", "canonical theme identifier")
    .option("--appearance <appearance>", "dark or light")
    .option("--json", "print the Operation result as JSON")
    .action((options: ChangePreferencesInput & { json?: boolean }) =>
      settle(
        execute(async (clients) => {
          const admission = clients.projectionPort.submit({
            operation: "change-preferences",
            operationId: randomUUID(),
            input: {
              ...(options.theme === undefined ? {} : { theme: options.theme }),
              ...(options.appearance === undefined
                ? {}
                : { appearance: options.appearance }),
            },
          });
          const json = options.json ?? false;
          if (!admission.admitted) return fail(io, json, admission.problem);
          const receipt = await settledOperation(
            clients.projectionPort,
            admission.operationId,
            "Run `secant settings show` to read saved Preferences before retrying.",
          );
          if (json) io.out(`${headlessJson(receipt)}\n`);
          if (receipt.outcome.status === "not-applied")
            return json ? 1 : fail(io, false, receipt.outcome.problem);
          if (!json && receipt.preferencesChange !== undefined)
            printPair(io, receipt.preferencesChange);
          return 0;
        }),
      ),
    );
}
function showPreferences(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
): number {
  const view = port.openProjection({ family: "preferences" });
  try {
    const { preferences, notice } = view.snapshot;
    if (notice !== undefined)
      io.err(
        `Notice [${notice.code}]: ${notice.explanation}\nRemediation: ${notice.remediation}\n`,
      );
    if (json) io.out(`${headlessJson(preferences)}\n`);
    else printPair(io, preferences);
    return 0;
  } finally {
    view.close();
  }
}
