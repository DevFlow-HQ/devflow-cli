import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeTempDir } from "../helpers/tempDir.js";
import { dirname, join } from "node:path";
import { TARGETS } from "../../scripts/targets.js";
import {
  ripgrepInput,
  verifyEmbeddedRipgrep,
} from "../../scripts/embedded-ripgrep.js";

test("m10-audit-embedded-ripgrep-release: each target admits only its pinned official member", () => {
  for (const target of Object.values(TARGETS)) {
    const input = ripgrepInput(target);
    const bytes = readFileSync(input.path);
    assert.equal(input.version, "15.1.0");
    assert.doesNotThrow(() =>
      verifyEmbeddedRipgrep(
        target,
        Buffer.concat([Buffer.from("candidate"), bytes]),
      ),
    );
    assert.throws(
      () => verifyEmbeddedRipgrep(target, Buffer.from("no helper")),
      /embedded ripgrep/,
    );
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] ^= 1;
    assert.throws(
      () => verifyEmbeddedRipgrep(target, corrupt),
      /embedded ripgrep/,
    );
    const other = Object.values(TARGETS).find((t) => t !== target);
    assert.ok(other);
    assert.throws(
      () =>
        verifyEmbeddedRipgrep(target, readFileSync(ripgrepInput(other).path)),
      /embedded ripgrep/,
    );
  }
});

test("m10-audit-embedded-ripgrep-release: scoped closure requires every complete component notice", async () => {
  const { ripgrepClosureFor } =
    await import("../../scripts/embedded-ripgrep.js");
  const { verifyClosureNotices } = await import("../../scripts/inventory.js");
  const notices = readFileSync(
    new URL("../../THIRD-PARTY-NOTICES.md", import.meta.url),
    "utf8",
  );
  const closure = ripgrepClosureFor(TARGETS["linux-x64"]);
  assert.deepEqual(verifyClosureNotices(closure, notices), []);
  const withoutPCRE = notices.replace(
    "### `ripgrep/PCRE2` `10.45`",
    "### omitted",
  );
  assert.ok(
    verifyClosureNotices(closure, withoutPCRE).some((p) => /PCRE2/.test(p)),
  );
  const withoutException = notices.replace(
    "The second condition in the BSD licence",
    "incomplete exception",
  );
  assert.ok(
    verifyClosureNotices(closure, withoutException).some((p) =>
      /PCRE2.*licence text/.test(p),
    ),
  );
  const stale = closure.map((c) =>
    c.name === "ripgrep/PCRE2" ? { ...c, version: "10.44" } : c,
  );
  assert.ok(
    verifyClosureNotices(stale, notices).some((p) =>
      /unrecognised ripgrep member/.test(p),
    ),
  );
  assert.ok(
    verifyClosureNotices(
      [
        {
          name: "unrelated",
          version: "1.0.0",
          license: "Unicode-DFS-2016",
          embeddedIn: "ripgrep",
        },
      ],
      notices,
    ).some((p) => /unrecognised ripgrep member/.test(p)),
  );
});

test("m10-audit-embedded-ripgrep-release: missing, wrong-target, wrong-version and corrupt inputs fail admission", () => {
  const target = TARGETS["linux-x64"];
  assert.equal(target.ripgrep, "x86_64-unknown-linux-musl");
  assert.equal(TARGETS["windows-x64"].ripgrep, "x86_64-pc-windows-msvc");
  assert.equal(TARGETS["darwin-arm64"].ripgrep, "aarch64-apple-darwin");
  const root = makeTempDir("secant-ripgrep-input-");
  try {
    assert.throws(() => ripgrepInput(target, root), /ENOENT/);
    const input = ripgrepInput(target);
    const path = join(root, input.member);
    mkdirSync(dirname(path), { recursive: true });
    for (const bytes of [
      ripgrepInput(TARGETS["windows-x64"]).bytes,
      Buffer.from("ripgrep 15.0.0"),
      Buffer.from("corrupt"),
    ]) {
      writeFileSync(path, bytes);
      assert.throws(
        () => ripgrepInput(target, root),
        /Invalid ripgrep 15.1.0 input/,
      );
    }
    writeFileSync(path, input.bytes);
    assert.equal(
      ripgrepInput(target, root).memberSha256,
      "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("m10-audit-embedded-ripgrep-release: complete legal closure is target-specific", async () => {
  const { ripgrepClosureFor } =
    await import("../../scripts/embedded-ripgrep.js");
  const { verifyClosureNotices } = await import("../../scripts/inventory.js");
  const notices = readFileSync(
    new URL("../../THIRD-PARTY-NOTICES.md", import.meta.url),
    "utf8",
  );
  for (const target of Object.values(TARGETS)) {
    const closure = ripgrepClosureFor(target);
    assert.equal(
      closure.some((c) => c.name === "ripgrep/MSVC-runtime"),
      target.os === "windows",
    );
    assert.equal(
      closure.some((c) => c.name === "ripgrep/jemalloc"),
      target.os === "linux",
    );
    assert.equal(
      closure.some((c) => c.name === "ripgrep/musl"),
      target.os === "linux",
    );
    assert.equal(
      closure.some((c) => c.name === "ripgrep/libunwind"),
      target.os === "linux",
    );
    assert.deepEqual(verifyClosureNotices(closure, notices), []);
    for (const component of closure) {
      const missing = notices.replace(
        `### \`${component.name}\` \`${component.version}\``,
        "### omitted",
      );
      assert.ok(
        verifyClosureNotices([component], missing).length > 0,
        component.name,
      );
    }
  }
});

test("m10-audit-embedded-ripgrep-release: Rust std redistributions retain their own versions and terms", async () => {
  const { ripgrepClosureFor } =
    await import("../../scripts/embedded-ripgrep.js");
  const closure = ripgrepClosureFor(TARGETS["linux-x64"]);
  for (const [name, version] of [
    ["addr2line", "0.25.0"],
    ["gimli", "0.32.0"],
    ["miniz_oxide", "0.8.9"],
    ["adler2", "2.0.1"],
    ["object", "0.37.3"],
    ["memchr", "2.7.5"],
    ["cfg-if", "1.0.1"],
    ["hashbrown", "0.15.5"],
    ["rustc-demangle", "0.1.26"],
  ]) {
    assert.ok(
      closure.some(
        (c) => c.name === `ripgrep/Rust-std/${name}` && c.version === version,
      ),
      name,
    );
  }
  assert.ok(
    closure.some(
      (c) =>
        c.name === "ripgrep/compiler_builtins" &&
        c.version === "0.1.160" &&
        c.license === "Apache-2.0 WITH LLVM-exception",
    ),
  );
  assert.ok(
    closure.some((c) => c.name === "ripgrep/musl" && c.version === "1.2.3"),
  );
  const windows = ripgrepClosureFor(TARGETS["windows-x64"]);
  assert.equal(
    windows.some((c) => c.name === "ripgrep/Rust-std/addr2line"),
    false,
  );
});
