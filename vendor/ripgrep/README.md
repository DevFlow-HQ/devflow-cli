# Pinned ripgrep release inputs

Secant embeds the official ripgrep 15.1.0 release executable for each target.
`manifest.json` records archive provenance, SHA-256 pins for archives and extracted
members, target-specific linked components, and hashes of complete licence texts.
`15.1.0/` holds unchanged extracted members. No helper archive or separate helper
executable is included in Secant's release archives or npm packages.

The upstream source is commit `af60c2de9d85e7f3d81c78601669468cf02dabab`.
`release.yml` and `Cargo.lock` are byte-faithful copies from that commit.
The upstream release enables `pcre2`, statically builds PCRE2, and uses the
`release-lto` profile. Each `*-tree.txt` records the normal dependency tree from:

```sh
cargo tree --locked --features pcre2 --target <upstream-triple> -e normal --prefix none
```

The tree paths use `ripgrep@<commit>` in place of the local checkout path.
The trees have 37 linked crates on macOS, 39 on Linux, and 40 on Windows,
including ripgrep itself. Build and dev dependencies are excluded.
Crate source archives were checked against their Cargo.lock checksums.
MIT is selected for dual-licensed crates, except ryu, which uses Apache-2.0.
`encoding_rs` also needs its WHATWG BSD text; Unicode data is covered separately.

PCRE2 10.45 and SLJIT 0.95 come from the checksum-verified pcre2-sys 0.2.10
source. Linux jemalloc comes from tikv-jemalloc-sys's pinned 5.3.0 source.
All three executable members name Rust compiler revision
`695857bc3f72ec4f59c79f323460fe488c38a53f`; its LLVM submodule is
`4f74b76fb69688474e073fb26b316d9ea571388f`. Rust, compiler-rt, and Linux libunwind
notices come from those sources. `rust-provenance/` records the exact standard-library
lock and dependency declarations, plus target and musl toolchain definitions.
The self-contained Rust target links musl 1.2.3. Its backtrace closure includes
addr2line, gimli, miniz_oxide, adler2, object, memchr, and rustc-demangle.
Rust std memchr 2.7.5 and cfg-if 1.0.1 are distinct from ripgrep Cargo versions.
Compiler-builtins requires both MIT and Apache-2.0 WITH LLVM-exception.
The Windows helper carries the Microsoft Visual C++
2015-2022 runtime terms, extracted from Microsoft's official licence document.
Every legal source URL is recorded beside its text digest in the manifest.
`legal-texts.json` preserves the complete source texts under their recorded names.

`build.ts` admits inputs before compiling and checks the complete pinned member
in the resulting executable. `inventory.ts` repeats the candidate check for every
target, verifies all component texts in their own notices sections, and records
`dist/legal-inventory.json`. The additional Unicode data, PCRE2, LLVM, and MSVC licence identities are scoped to
known ripgrep members; they do not admit unrelated npm runtime components.
The three-OS semantic scenario is `m10-audit-embedded-ripgrep-release`.
The existing compiled-binary smoke exercises the native host candidate.

To refresh these inputs, download the official target archives and source tag,
check the official archive digests, extract unchanged members, regenerate the
normal target trees, and collect the corresponding checksummed crate and native
legal sources. Update the manifest and complete component sections in
`THIRD-PARTY-NOTICES.md` together, then cross-build and run the legal gate.
A version or helper-program change requires the dependency decision in ADR 0030.
