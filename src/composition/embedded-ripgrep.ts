import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ApplicationDependencies } from "../application/application.js";

// Compile supplies the admitted target's pins; dev reads the same manifest.
declare const __SECANT_RIPGREP__: {
  readonly version: string;
  readonly sha256: string;
  readonly assetName: string;
};
const manifestSchema = z.object({
  version: z.string(),
  targets: z.record(
    z.string(),
    z.object({ member: z.string(), memberSha256: z.string() }),
  ),
});

export function embeddedRipgrep(
  secantHome: string,
  assetRoot = join(import.meta.dirname, "../../vendor/ripgrep"),
): ApplicationDependencies["workspacePathHelper"] {
  try {
    if (typeof __SECANT_RIPGREP__ !== "undefined") {
      const pin = __SECANT_RIPGREP__;
      return {
        kind: "embedded",
        stateDirectory: join(secantHome, "helpers"),
        version: pin.version,
        sha256: pin.sha256,
        readBytes: () => readFile(join(import.meta.dirname, pin.assetName)),
      };
    }
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(assetRoot, "manifest.json"), "utf8")),
    );
    const target =
      process.platform === "win32" && process.arch === "x64"
        ? "x86_64-pc-windows-msvc"
        : process.platform === "darwin" && process.arch === "arm64"
          ? "aarch64-apple-darwin"
          : process.platform === "linux" && process.arch === "x64"
            ? "x86_64-unknown-linux-musl"
            : undefined;
    const pin = target === undefined ? undefined : manifest.targets[target];
    if (pin === undefined) return;
    return {
      kind: "embedded",
      stateDirectory: join(secantHome, "helpers"),
      version: manifest.version,
      sha256: pin.memberSha256,
      readBytes: () => readFile(join(assetRoot, pin.member)),
    };
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
}
