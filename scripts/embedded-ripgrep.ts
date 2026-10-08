import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import legalTexts from "../vendor/ripgrep/legal-texts.json" with { type: "json" };
import manifest from "../vendor/ripgrep/manifest.json" with { type: "json" };
import type { CompileTarget } from "./targets.js";

// Build-only helper admission. Fixed official bytes make target and version
// checks inseparable from the digest check; no PATH lookup or runtime download.
export function ripgrepInput(
  target: CompileTarget,
  assetRoot = resolve(import.meta.dir, "../vendor/ripgrep"),
) {
  const pin = manifest.targets[target.ripgrep];
  const path = resolve(assetRoot, pin.member);
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.memberSha256) {
    throw new Error(
      `Invalid ripgrep ${manifest.version} input for ${target.ripgrep}: ${path}`,
    );
  }
  return { path, bytes, version: manifest.version, ...pin };
}

// compile.assets stores complete, uncompressed files. Compare the actual
// candidate with the independently pinned official member, never a build receipt.
export function verifyEmbeddedRipgrep(target: CompileTarget, binary: Buffer) {
  const input = ripgrepInput(target);
  if (binary.indexOf(input.bytes) === -1) {
    throw new Error(
      `Candidate lacks pinned embedded ripgrep ${input.version} for ${target.ripgrep}`,
    );
  }
  return {
    target: target.ripgrep,
    version: input.version,
    member: input.member,
    sha256: input.memberSha256,
  };
}

export interface RipgrepComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly embeddedIn: "ripgrep";
}

export function ripgrepClosureFor(target: CompileTarget): RipgrepComponent[] {
  return manifest.components
    .filter((component) => component.targets.includes(target.ripgrep))
    .flatMap((component) =>
      component.licenses.map((license): RipgrepComponent => ({
        name: component.name,
        version: component.version,
        license,
        embeddedIn: "ripgrep",
      })),
    );
}

// Complete source texts are checked against their provenance pins. Matching
// within one component section prevents another component's version or licence
// text from masking an omitted notice. Whitespace-only formatting is harmless.
export function verifyRipgrepNotices(
  component: RipgrepComponent,
  notices: string,
): string[] {
  const member = manifest.components.find(
    (member) =>
      member.name === component.name &&
      member.version === component.version &&
      member.licenses.includes(component.license),
  );
  if (!member)
    return [
      `${component.name}: unrecognised ripgrep member or licence identity`,
    ];
  const heading = `### \`${member.name}\` \`${member.version}\``;
  const start = notices.indexOf(heading + "\n");
  if (start === -1)
    return [
      `${component.name}: missing notices section for shipped version ${component.version}`,
    ];
  const end = notices.indexOf("\n### `", start + heading.length);
  const section = notices.slice(start, end === -1 ? undefined : end);
  const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
  const problems: string[] = [];
  for (const notice of member.notices) {
    const texts: Readonly<Record<string, string>> = legalTexts;
    const text = texts[notice.path];
    if (text === undefined)
      throw new Error(`Missing ripgrep legal source: ${notice.path}`);
    const bytes = Buffer.from(text);
    if (createHash("sha256").update(bytes).digest("hex") !== notice.sha256) {
      throw new Error(`Invalid ripgrep legal source: ${notice.path}`);
    }
    if (!normalise(section).includes(normalise(bytes.toString("utf8")))) {
      problems.push(
        `${component.name}: required complete licence text ${notice.path} is absent`,
      );
    }
  }
  return problems;
}
