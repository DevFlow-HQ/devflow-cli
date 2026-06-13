import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const tempDirectories = new Set<string>();

export function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

export async function cleanupTempDirsForTest(): Promise<void> {
  const directories = Array.from(tempDirectories).reverse();
  tempDirectories.clear();

  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}

after(async () => {
  await cleanupTempDirsForTest();
});
