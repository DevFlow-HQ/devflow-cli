import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

export interface MacosKeychainCredentialExecResult {
  stdout: string;
}

export type MacosKeychainCredentialExec = (
  file: string,
  args: string[],
) => Promise<MacosKeychainCredentialExecResult>;

export interface ReadMacosKeychainCredentialOptions {
  service?: string;
  account?: string;
  exec?: MacosKeychainCredentialExec;
}

const DEFAULT_CLAUDE_CREDENTIAL_SERVICE = "Claude Code-credentials";
const execFileAsync = promisify(execFile);

export async function readMacosKeychainCredential({
  service = DEFAULT_CLAUDE_CREDENTIAL_SERVICE,
  account = userInfo().username,
  exec = realExec,
}: ReadMacosKeychainCredentialOptions = {}): Promise<string | null> {
  try {
    const { stdout } = await exec("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);

    return stdout;
  } catch (error) {
    if (isNonZeroExit(error)) {
      return null;
    }

    throw error;
  }
}

const realExec: MacosKeychainCredentialExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });

  return { stdout };
};

function isNonZeroExit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "number"
  );
}
