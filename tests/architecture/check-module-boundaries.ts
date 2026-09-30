import { isBuiltin } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { externalViolation, isClient, ownerOf } from "./module-policy.js";
import type { Finding } from "./rule-catalogue.js";

// Test folders that do not mirror a source domain (S1): the architecture checks,
// shared helpers, shared fixtures, the human release checks, release-script tests,
// and the real-terminal suite. Every other `tests/<prefix>/` folder mirrors
// `src/<prefix>/`.
const NON_MIRRORING_TEST_FOLDERS = new Set([
  "architecture",
  "helpers",
  "fixtures",
  "release",
  "release-checks",
  "terminal",
]);

/** Mechanise the prose rule "tests mirror their source domain" (S1): a test under
 *  `tests/<prefix>/` that imports any owned Module must import at least one whose
 *  root starts with `src/<prefix>/`. A test importing no target source at all (a
 *  pure-helper suite such as `tests/harness/redact.test.ts`, which imports only its
 *  sibling test helper) is skipped; the non-mirroring folders above are skipped wholesale.
 *  This catches a suite filed by ticket rather than by the Interface it crosses. */
export function checkTestDomainMirror(root: string): Finding[] {
  const issues: Finding[] = [];
  const testsRoot = join(root, "tests");
  if (!existsSync(testsRoot)) return issues;
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const files: string[] = [];
  const discover = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) discover(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(path);
    }
  };
  discover(testsRoot);

  for (const file of files.sort()) {
    const relPath = pathOf(file);
    const segments = relPath.split("/");
    // tests/<prefix>/…; a file directly under tests/ has no domain to mirror.
    if (segments.length < 3) continue;
    const prefix = segments[1]!;
    if (NON_MIRRORING_TEST_FOLDERS.has(prefix)) continue;

    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const importedModules: string[] = [];
    const record = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const target = pathOf(resolve(dirname(file), specifier));
      const owner = ownerOf(target);
      if (owner) importedModules.push(owner.root);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        record(node.moduleSpecifier.text);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        record(node.argument.literal.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        record(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // Zero-import skip: a suite that touches no owned Module is not mirroring
    // anything and is left alone (the declared exception for such tests).
    if (importedModules.length === 0) continue;
    if (
      !importedModules.some((moduleRoot) =>
        moduleRoot.startsWith(`src/${prefix}/`),
      )
    ) {
      issues.push({
        rule: "topology/test-mirror",
        file: relPath,
        line: 1,
        column: 1,
        data: { prefix, roots: [...new Set(importedModules)] },
      });
    }
  }
  return issues;
}

/** Uses the project's resolver and real source graph; does not load or execute any production Module. */
export function checkModuleBoundaries(root: string): Finding[] {
  root = realpathSync(root);
  const issues: Finding[] = [];
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const files: string[] = [];
  function discover(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          rule: "topology/source-symlink",
          file: pathOf(path),
          line: 1,
          column: 1,
          data: {},
        });
      } else if (entry.isDirectory()) discover(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(path);
    }
  }
  discover(join(root, "src"));
  if (existsSync(join(root, "tests"))) discover(join(root, "tests"));
  for (const file of files.sort()) {
    const path = pathOf(file);
    const isTest = path.startsWith("tests/");
    const owner = ownerOf(path);
    if (!owner && !isTest) {
      issues.push({
        rule: "topology/unowned-source",
        file: path,
        line: 1,
        column: 1,
        data: {},
      });
      continue;
    }
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (
      position: number,
      finding: DistributiveOmit<Finding, "file" | "line" | "column">,
    ) => {
      const { line, character } =
        source.getLineAndCharacterOfPosition(position);
      issues.push({
        ...finding,
        file: path,
        line: line + 1,
        column: character + 1,
      } as Finding);
    };
    const at = (node: ts.Node) => node.getStart(source);
    const clientContract =
      path === "src/application/projection-port.ts" ||
      path === "src/application/bundle-management.ts" ||
      path.startsWith("src/application/contracts/");

    function checkImport(node: ts.Node, specifier: string, reexport = false) {
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      const staticAsset =
        resolved === undefined && specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : undefined;
      const resolvedPath =
        resolved?.resolvedFileName ??
        (staticAsset !== undefined && existsSync(staticAsset)
          ? staticAsset
          : undefined);
      const target = resolvedPath && pathOf(realpathSync(resolvedPath));
      if (
        target &&
        !target.startsWith("../") &&
        !target.startsWith("node_modules/") &&
        !target.includes("/node_modules/")
      ) {
        const other = ownerOf(target);
        if (owner && !other) {
          report(at(node), { rule: "module/unowned-import", data: { target } });
          return;
        }
        if (
          clientContract &&
          !(
            target === "src/application/projection-port.ts" ||
            target === "src/application/bundle-management.ts" ||
            target.startsWith("src/application/contracts/")
          )
        ) {
          report(at(node), {
            rule: "module/client-contract-implementation",
            data: { target },
          });
          return;
        }
        if (!other || owner?.name === other.name) return;
        const isPublic =
          target === other.root + other.entry ||
          ("contracts" in other &&
            other.contracts.some((entry) => target === other.root + entry));
        if (!isPublic)
          report(at(node), {
            rule: "module/private-import",
            data: { importer: owner?.name, module: other.name, target },
          });
        // A test has no owner and unowned source returned above, so `owner` means `!isTest`.
        if (other.name === "composition" && owner && owner.name !== "cli") {
          report(at(node), {
            rule: "module/composition-invocation",
            data: { importer: owner.name },
          });
        }
        if (
          owner &&
          !(owner.imports as readonly string[]).includes(other.name)
        ) {
          report(at(node), {
            rule: "module/import-direction",
            data: { importer: owner.name, module: other.name },
          });
        }
        if (owner && reexport)
          report(at(node), {
            rule: "module/foreign-reexport",
            data: { importer: owner.name, module: other.name, target },
          });
        if (
          owner &&
          isClient(owner.name) &&
          target === "src/application/application.ts"
        ) {
          report(at(node), {
            rule: "module/client-construction",
            data: { importer: owner.name },
          });
        }
        return;
      }
      if (!owner) return;
      if (clientContract)
        report(at(node), {
          rule: "module/client-contract-external",
          data: { specifier },
        });
      const forbidden =
        externalViolation(owner.name, specifier) ||
        (resolved?.packageId &&
          externalViolation(owner.name, resolved.packageId.name));
      if (forbidden) {
        const importer = owner.name;
        report(
          at(node),
          forbidden.kind === "excluded"
            ? { rule: "module/excluded-dependency", data: { specifier } }
            : forbidden.kind === "fenced"
              ? {
                  rule: "module/dependency-owner",
                  data: { importer, specifier, owners: forbidden.owners },
                }
              : forbidden.kind === "sqlite-driver"
                ? {
                    rule: "module/sqlite-driver",
                    data: { importer, specifier, owners: forbidden.owners },
                  }
                : { rule: "module/custom-loader", data: { specifier } },
        );
      }
      if (owner.name === "workflow" && isBuiltin(specifier))
        report(at(node), {
          rule: "module/workflow-builtin",
          data: { specifier },
        });
      // A `bun:` builtin does not resolve to an installed dependency; the
      // allowlist (check-vendor-provenance) governs whether it is permitted at
      // all, but ownership rules above (e.g. SQLite) still apply here.
      if (
        !isBuiltin(specifier) &&
        !specifier.startsWith("bun:") &&
        (!resolved || !resolved.isExternalLibraryImport)
      ) {
        report(at(node), {
          rule: "module/unresolved-import",
          data: { specifier },
        });
      }
    }

    const directive = [
      ...source.referencedFiles,
      ...source.typeReferenceDirectives,
    ].sort((left, right) => left.pos - right.pos)[0];
    if (owner && directive) {
      report(source.text.lastIndexOf("///", directive.pos), {
        rule: "module/triple-slash-reference",
        data: {},
      });
    }
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        checkImport(
          node,
          node.moduleSpecifier.text,
          ts.isExportDeclaration(node),
        );
        if (owner && ts.isExportDeclaration(node) && !node.exportClause)
          report(at(node), {
            rule: "module/wildcard-export",
            data: { specifier: node.moduleSpecifier.text },
          });
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        checkImport(node, node.argument.literal.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const reference = node.moduleReference.expression;
        if (owner)
          report(at(node), {
            rule: "module/require-assignment",
            data: {
              specifier: ts.isStringLiteralLike(reference)
                ? reference.text
                : reference.getText(source),
            },
          });
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument))
            checkImport(node, argument.text);
          else if (owner)
            report(at(node), { rule: "module/computed-import", data: {} });
        } else if (
          owner &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === "require" ||
            node.expression.text === "eval")
        ) {
          report(at(node), {
            rule: "module/require-or-eval",
            data: { callee: node.expression.text },
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return issues;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
