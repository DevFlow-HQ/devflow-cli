#!/usr/bin/env bun
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { release, tmpdir, version as osVersion } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  formatWindowsTerminalReport,
  windowsTerminalOutcome,
} from "./windows-terminal-report.js";
import { fail, sha256File } from "../release-helpers.js";

const HELP = `Windows Terminal human real-terminal check

Usage:
  bun run check:windows-terminal [path-to-secant-windows-x64.exe]

Run this from a Windows Terminal tab after \`bun run check\`. The script checks
the packed binary, guides both supported exit paths, Run Workbench terminal
behaviours and the observed-only legacy-conhost run, then prints the digest-bound
release evidence report. Use a Windows Terminal version with kitty keyboard
protocol support and an installed, authenticated Harness for the Workbench run.`;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly packageManager: string;
}

interface CheckContext {
  readonly binary: string;
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}

function validateManifest(value: unknown): PackageManifest {
  if (typeof value !== "object" || value === null) {
    fail("package.json must contain an object.");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.name !== "@secantdev/secant") {
    fail("package.json must name the @secantdev/secant package.");
  }
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    fail("package.json must contain a valid package version.");
  }
  if (
    typeof manifest.packageManager !== "string" ||
    !/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager)
  ) {
    fail("package.json must contain an exact Bun packageManager pin.");
  }
  return {
    name: manifest.name,
    version: manifest.version,
    packageManager: manifest.packageManager,
  };
}

function checkSpawn(result: SpawnSyncReturns<unknown>, action: string): void {
  if (result.error) fail(`Could not ${action}.`, result.error);
  if (result.signal)
    fail(`${action} was terminated by signal ${result.signal}.`);
}

async function askYesNo(
  prompt: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  for (;;) {
    const answer = (await prompt.question(`${question} [y/n] `))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Please answer y or n.");
  }
}

async function askTerminalVersion(
  prompt: ReturnType<typeof createInterface>,
): Promise<string> {
  for (;;) {
    const answer = (
      await prompt.question(
        "Windows Terminal version (the numeric value under Settings > About): ",
      )
    ).trim();
    if (/^\d+(?:\.\d+){1,3}$/.test(answer)) return answer;
    console.log("Enter the numeric version, for example 1.23.1234.0.");
  }
}

function approveWorkspace(context: CheckContext): void {
  const result = spawnSync(context.binary, ["workspace", "approve"], {
    cwd: context.workspace,
    env: context.env,
    encoding: "utf8",
  });
  checkSpawn(result, "start Secant to approve the temporary Workspace");
  if (result.status !== 0) {
    fail(
      `Could not approve the temporary Workspace (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function runExitPath(
  prompt: ReturnType<typeof createInterface>,
  context: CheckContext,
  key: "Quit command" | "Ctrl+C",
): Promise<boolean> {
  console.log(
    `\nSecant will start in this Windows Terminal tab. Wait for Home, ${
      key === "Quit command"
        ? 'press Ctrl+P, type "Quit", and press Enter'
        : "press Ctrl+C"
    }, and do not close the tab.`,
  );
  await prompt.question("Press Enter to launch Secant. ");
  const result = spawnSync(context.binary, [], {
    cwd: context.workspace,
    env: context.env,
    stdio: "inherit",
  });
  checkSpawn(result, `start Secant for the ${key} exit path`);
  const responsive = await askYesNo(
    prompt,
    "Did Secant exit and leave this tab responsive at a normal prompt?",
  );
  if (result.status !== 0) {
    console.log(
      `Secant exited with status ${String(result.status)}; this row fails.`,
    );
  }
  return result.status === 0 && responsive;
}

async function runWorkbenchPaths(
  prompt: ReturnType<typeof createInterface>,
  context: CheckContext,
) {
  console.log(`
Secant will start again for the Run Workbench terminal checks.
1. At Home, choose Start a Run, select Matt Front Spec and your authenticated
   Harness. Enter a disposable idea and launch. This uses the real Harness.
2. Continue the interactive conversation until its history exceeds the viewport.
   Ask for a numbered list of 100 short lines if more scrollable text is needed.
   Wait until the compose accepts input before proceeding.
3. Type an unsent draft. Press Alt+Up and Alt+Down. Check that history moves
   in both directions and that the draft stays intact and compose keeps focus.
4. Put the pointer over history. Scroll the mouse wheel up and down and check
   that history moves in both directions. Alt+End returns to the latest content.
5. In compose, type "terminal check first line", press Shift+Enter, then type
   "terminal check second line". Check that both lines remain in compose and
   no Turn was sent. This requires kitty keyboard protocol support; an untested
   action must be answered n, not recorded as a pass.
6. Open Ctrl+G details, choose Session transcript and press Enter, then press e to export via OSC 52.
   Paste into another application, such as Notepad, and compare the copied text
   with the transcript. A success notice alone does not prove clipboard copy.
7. Return to Secant, close the transcript and details with Escape, then use
   Ctrl+P, Quit, Enter. Confirm Halt and Quit if a live Run needs to be stopped.
   Return here to record each result. Answer n for any action not exercised.`);
  await prompt.question("Press Enter to launch the Workbench check. ");
  const result = spawnSync(context.binary, [], {
    cwd: context.workspace,
    env: context.env,
    stdio: "inherit",
  });
  checkSpawn(result, "start Secant for the Run Workbench terminal checks");
  const altArrowScrollPassed = await askYesNo(
    prompt,
    "Did Alt+Up and Alt+Down scroll history while preserving compose focus and the draft?",
  );
  const mouseWheelScrollPassed = await askYesNo(
    prompt,
    "Did the mouse wheel scroll history up and down?",
  );
  const shiftEnterNewlinePassed = await askYesNo(
    prompt,
    "Under the kitty keyboard protocol, did Shift+Enter insert a compose newline without sending a Turn?",
  );
  const clipboardCopyPassed = await askYesNo(
    prompt,
    "Did the OSC 52 transcript export paste matching text into another application?",
  );
  return {
    altArrowScrollPassed,
    mouseWheelScrollPassed,
    shiftEnterNewlinePassed,
    clipboardCopyPassed,
  };
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (process.platform !== "win32") fail("This check must run on Windows.");
  if (!process.env.WT_SESSION) {
    fail(
      "Run this check from a Windows Terminal tab (WT_SESSION is not set in this process).",
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("This check requires an interactive terminal.");
  }

  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const manifest = validateManifest(
    JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")),
  );
  const bunPin = manifest.packageManager.match(/^bun@(.+)$/)?.[1];
  if (!bunPin)
    fail("package.json does not contain an exact Bun packageManager pin.");
  if (Bun.version !== bunPin) {
    fail(
      `This check requires the repository Bun pin ${bunPin}; running ${Bun.version}.`,
    );
  }

  const binary = resolve(
    process.argv[2] ?? join(projectRoot, "dist", "secant-windows-x64.exe"),
  );
  if (!existsSync(binary)) {
    fail(
      `Compiled binary not found at ${binary}. Run \`bun run check\` first.`,
    );
  }
  const versionResult = spawnSync(binary, ["--version"], { encoding: "utf8" });
  checkSpawn(versionResult, "start the compiled binary for its version check");
  const binaryVersion = versionResult.stdout.trim();
  if (versionResult.status !== 0 || binaryVersion !== manifest.version) {
    fail(
      `The binary is not the current ${manifest.name}@${manifest.version} build (reported ${binaryVersion || "no version"}). Run \`bun run check\` again.`,
    );
  }

  const digest = await sha256File(binary);
  const checkRoot = mkdtempSync(join(tmpdir(), "secant-human-terminal-"));
  const home = join(checkRoot, "home");
  const workspace = join(checkRoot, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  const env = { ...process.env, SECANT_HOME: home };
  const context = { binary, workspace, env };
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    approveWorkspace(context);
    console.log(`Checking ${manifest.name}@${manifest.version}`);
    console.log(`SHA-256 ${digest}`);
    const terminalVersion = await askTerminalVersion(prompt);

    const quitBindingPassed = await runExitPath(
      prompt,
      context,
      "Quit command",
    );
    const ctrlCPassed = await runExitPath(prompt, context, "Ctrl+C");

    const workbench = await runWorkbenchPaths(prompt, context);
    const observations = { quitBindingPassed, ctrlCPassed, ...workbench };

    console.log(`
Observed-only legacy conhost row (this does not decide the outcome):
1. Press Win+R, enter: conhost.exe powershell.exe
2. In that legacy window, paste these three lines:
   $env:SECANT_HOME = ${quotePowerShell(home)}
   Set-Location -LiteralPath ${quotePowerShell(workspace)}
   & ${quotePowerShell(binary)}
3. Note whether the startup notice appeared and stayed on screen until you
   pressed a key, then press a key to continue.
4. Wait for Home, press Ctrl+P, type "Quit", and press Enter. Then test whether
   the same window still accepts input. Close it when finished.
5. Return to this Windows Terminal tab and answer the three questions.`);
    await prompt.question(
      "Press Enter after the conhost observation is complete. ",
    );
    const conhostNoticeAppeared = await askYesNo(
      prompt,
      "Did the legacy-conhost startup notice appear?",
    );
    const conhostNoticeReadable = await askYesNo(
      prompt,
      "Could you read the notice and press a key before the TUI took over?",
    );
    const conhostWindowSurvived = await askYesNo(
      prompt,
      "Did the conhost window survive and remain responsive after the Quit command?",
    );

    const report = formatWindowsTerminalReport({
      report: {
        checkName: "Windows Terminal human real-terminal check",
        operatingSystem: {
          name: "Windows",
          version: `${osVersion()} (${release()})`,
        },
        subject: {
          kind: "terminal",
          name: "Windows Terminal",
          version: terminalVersion,
        },
        bunVersion: bunPin,
        secantVersion: manifest.version,
        binarySha256: digest,
        outcome: windowsTerminalOutcome(observations),
        timestamp: new Date().toISOString(),
      },
      evidence: { kind: "fresh" },
      ...observations,
      conhostNoticeAppeared,
      conhostNoticeReadable,
      conhostWindowSurvived,
    });
    console.log("\nPaste the report below into the release checklist:\n");
    console.log(report);
  } finally {
    prompt.close();
    try {
      rmSync(checkRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `Warning: could not remove temporary check directory ${checkRoot}: ${String(error)}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
    if (error.cause !== undefined)
      console.error(`Caused by: ${String(error.cause)}`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
