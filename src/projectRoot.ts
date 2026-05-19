import { execa } from "execa";

export interface ResolveProjectRootOptions {
  cwd: string;
}

export async function resolveProjectRoot(
  options: ResolveProjectRootOptions,
): Promise<string> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: options.cwd,
    reject: false,
  });

  if (result.exitCode === 0) {
    return result.stdout.trim();
  }

  return options.cwd;
}
