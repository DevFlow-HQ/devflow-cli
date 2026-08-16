import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTestFiles(path);
      }

      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );

  return nestedFiles.flat().sort();
}

const testFiles = await findTestFiles("tests");

if (testFiles.length === 0) {
  throw new Error("No recursively discovered test files were found.");
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles],
  { stdio: "inherit" },
);

await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`Test runner exited from signal ${signal}.`));
      return;
    }

    process.exitCode = code ?? 1;
    resolve();
  });
});
