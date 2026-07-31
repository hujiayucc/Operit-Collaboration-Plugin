"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "src");

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files.sort();
}

function propertyName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

const configFile = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
if (!configFile) throw new Error("tsconfig.json not found");
const config = ts.readConfigFile(configFile, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const checker = program.getTypeChecker();

function isForbiddenGlobal(node, name, sourceFile) {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  const symbol = checker.getSymbolAtLocation(node);
  return !symbol?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile);
}

function globalExportTarget(node, sourceFile) {
  if (!ts.isBinaryExpression(node)) return null;
  if (![
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(node.operatorToken.kind)) return null;
  const left = node.left;
  if (ts.isPropertyAccessExpression(left)) {
    if (isForbiddenGlobal(left.expression, "exports", sourceFile)) return `exports.${left.name.text}`;
    if (left.name.text === "exports" && isForbiddenGlobal(left.expression, "module", sourceFile)) return "module.exports";
  }
  if (ts.isElementAccessExpression(left) && isForbiddenGlobal(left.expression, "exports", sourceFile)) {
    const name = left.argumentExpression && propertyName(left.argumentExpression);
    if (name !== null) return `exports[${JSON.stringify(name)}]`;
  }
  return null;
}

function findViolations(sourceFile) {
  const file = sourceFile.fileName;
  const violations = sourceFile.referencedFiles.map((reference) => ({
    kind: "path reference",
    position: reference.pos,
    detail: reference.fileName,
  }));

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && isForbiddenGlobal(node.expression, "require", sourceFile)
    ) {
      violations.push({ kind: "require()", position: node.getStart(sourceFile), detail: node.getText(sourceFile) });
    }
    const target = globalExportTarget(node, sourceFile);
    if (target) violations.push({ kind: target, position: node.getStart(sourceFile), detail: node.getText(sourceFile) });
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return violations.map((violation) => {
    const location = sourceFile.getLineAndCharacterOfPosition(violation.position);
    return {
      file: path.relative(ROOT, file).split(path.sep).join("/"),
      line: location.line + 1,
      column: location.character + 1,
      kind: violation.kind,
      detail: violation.detail,
    };
  });
}

const files = listTypeScriptFiles(SOURCE_ROOT);
const sourceFiles = files.map((file) => program.getSourceFile(file));
if (sourceFiles.some((file) => !file)) throw new Error("TypeScript program did not load every src/**/*.ts file");
const violations = sourceFiles.flatMap(findViolations);
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.kind}: ${violation.detail}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Migration source check passed: ${files.length} TypeScript files use import/export without path references or CommonJS globals.`);
}