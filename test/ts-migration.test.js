"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const CHECK_SCRIPT = path.join(ROOT, "scripts", "check-ts-migration.js");

function diagnosticsFor(source) {
  const fileName = path.join(ROOT, "src", "fixture.ts");
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = sourceFile.referencedFiles.map((reference) => `path reference:${reference.fileName}`);

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      diagnostics.push("require()");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (
        ts.isPropertyAccessExpression(left)
        && ts.isIdentifier(left.expression)
        && left.expression.text === "module"
        && left.name.text === "exports"
      ) diagnostics.push("module.exports");
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "exports") {
        diagnostics.push("exports.*");
      }
      if (ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "exports") {
        diagnostics.push("exports[]");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return diagnostics;
}

test("migration checker rejects path references and CommonJS source globals", () => {
  const diagnostics = diagnosticsFor([
    '/// <reference path="../types/runtime.d.ts" />',
    'const value = require("./value.js");',
    "module.exports = value;",
    "exports.named = value;",
    'exports["other"] = value;',
  ].join("\n"));
  assert.deepEqual(diagnostics, [
    "path reference:../types/runtime.d.ts",
    "require()",
    "module.exports",
    "exports.*",
    "exports[]",
  ]);
});

test("migration checker is wired to TypeScript AST and the project source root", () => {
  const source = require("node:fs").readFileSync(CHECK_SCRIPT, "utf8");
  assert.match(source, /require\("typescript"\)/);
  assert.match(source, /path\.join\(ROOT, "src"\)/);
  assert.match(source, /sourceFile\.referencedFiles/);
  assert.match(source, /ts\.isCallExpression/);
  assert.match(source, /"module\.exports"/);
});