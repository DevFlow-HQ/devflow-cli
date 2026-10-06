import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { openCatalog } from "../../src/catalog/catalog.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function object(file: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      )
        return declaration.initializer;
    }
  }
  assert.fail(`Missing literal ${name} in ${file.fileName}`);
}
function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
    return name.expression.text;
  assert.fail(`Unsupported palette key ${name.getText()}`);
}
function fields(
  object: ts.ObjectLiteralExpression,
): Map<string, ts.Expression> {
  return new Map(
    object.properties.map((property) => {
      if (ts.isShorthandPropertyAssignment(property))
        return [property.name.text, property.name];
      assert.ok(ts.isPropertyAssignment(property));
      return [propertyName(property.name), property.initializer];
    }),
  );
}

test("m10-home-and-preferences: accepted identifiers match all 25 vendored palettes with dark and light roles", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-palette-contract-"));
  const app = createApplication({
    catalog,
    launchWorkspacePath: makeTempDir("secant-palette-ws-"),
  });
  t.after(async () => {
    await app.shutdown();
    catalog.close();
  });
  const view = app.projectionPort.openProjection({ family: "preferences" });
  view.close();
  const registry = source(resolve(root, "src/tui/vendor/theme.ts"));
  const imports = new Map<string, string>();
  for (const statement of registry.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports.set(
        statement.importClause.name.text,
        statement.moduleSpecifier.text,
      );
  }
  const palettes = fields(object(registry, "DEFAULT_THEMES"));
  assert.equal(palettes.size, 25);
  assert.deepEqual(
    [...view.snapshot.supportedThemes].sort(),
    [...palettes.keys()].sort(),
  );
  for (const [id, expression] of palettes) {
    assert.ok(ts.isIdentifier(expression));
    const path = imports.get(expression.text);
    assert.ok(path);
    const asset = source(
      resolve(dirname(registry.fileName), path.replace(/\.js$/, ".ts")),
    );
    const palette = fields(object(asset, "theme"));
    const rolesExpression = palette.get("theme");
    assert.ok(rolesExpression && ts.isObjectLiteralExpression(rolesExpression));
    const roles = fields(rolesExpression);
    // This is the asset-availability contract. Renderer resolution and actual
    // preview colors belong to the successor Themes ticket (#409).
    for (const role of roles.values()) {
      if (ts.isObjectLiteralExpression(role)) {
        const variant = fields(role);
        for (const mode of ["dark", "light"]) {
          const value = variant.get(mode);
          assert.ok(
            value && ts.isStringLiteral(value) && value.text.length > 0,
            `${id} missing ${mode}`,
          );
        }
      } else {
        assert.ok(ts.isStringLiteral(role) || ts.isNumericLiteral(role));
      }
    }
  }
});
