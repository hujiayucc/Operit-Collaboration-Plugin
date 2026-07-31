"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const PROJECT_NAME = path.basename(ROOT);
const OUT = path.join(ROOT, `${PROJECT_NAME}-v${MANIFEST.version}.toolpkg`);
const TERSER_VERSION = "5.31.6";
const STATIC_RUNTIME_FILES = Object.freeze([
  "manifest.json",
  "types/runtime.d.ts",
]);
const RUNTIME_SOURCE_FILES = Object.freeze([
  "src/main.ts",
  "src/protocol.ts",
  "src/collaboration/engine.ts",
  "src/collaboration/helpers.ts",
  "src/collaboration/manager.ts",
  "src/collaboration/model.ts",
  "src/collaboration/store.ts",
  "src/packages/collaboration.ts",
  "src/packages/tool_lifecycle_probe.ts",
  "src/ui/collaboration_dashboard/api.ts",
  "src/ui/collaboration_dashboard/components.ts",
  "src/ui/collaboration_dashboard/i18n.ts",
  "src/ui/collaboration_dashboard/index.ui.ts",
  "src/ui/collaboration_dashboard/model.ts",
  "src/ui/collaboration_dashboard/request-id.ts",
  "src/ui/collaboration_dashboard/validation.ts",
]);
const RUNTIME_FILES = Object.freeze([
  ...STATIC_RUNTIME_FILES,
  ...RUNTIME_SOURCE_FILES.map((file) => file.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")),
]);
const TERSER_ARGS = Object.freeze([
  "--yes",
  `terser@${TERSER_VERSION}`,
  "--compress",
  "passes=2,unsafe=false,toplevel=false",
  "--no-rename",
  "--keep-fnames",
  "--keep-classnames",
  "--format",
  "comments=false,beautify=false",
  "--ecma",
  "2020",
]);

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file));
}

function snapshotSources() {
  const entries = {};
  for (const file of RUNTIME_SOURCE_FILES) {
    entries[file] = sha256(read(file));
  }
  return entries;
}

function assertSourceUnchanged(before) {
  assert.deepEqual(snapshotSources(), before, "runtime source changed during package build");
}

function compileTypeScript() {
  execFileSync("npm", ["run", "compile"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function compiledRuntimePath(file) {
  return file;
}

function copyRuntimeFiles(stageRoot) {
  for (const file of RUNTIME_FILES) {
    const source = path.join(ROOT, compiledRuntimePath(file));
    const destination = path.join(stageRoot, file);
    if (!fs.existsSync(source)) throw new Error(`runtime file missing: ${file}`);
    mkdirp(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
}

function minifyManifest(stageRoot) {
  const target = path.join(stageRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  const output = JSON.stringify(manifest);
  if (!output || /[\r\n]/.test(output)) {
    throw new Error("minified manifest.json must be exactly one non-empty line");
  }
  fs.writeFileSync(target, output);
}

function metadataPrefix(source, file) {
  const match = source.match(/\/\* METADATA\s*([\s\S]*?)\*\//);
  if (!match) return "";
  let metadata;
  try {
    metadata = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`invalid METADATA JSON in ${file}: ${error.message}`);
  }
  return `/* METADATA ${JSON.stringify(metadata)} */`;
}

function singleLineJavaScript(stageRoot) {
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    const target = path.join(stageRoot, file);
    const prefix = metadataPrefix(fs.readFileSync(target, "utf8"), file);
    const singleLine = execFileSync("npx", [...TERSER_ARGS, "--", target], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const output = `${prefix}${singleLine}`;
    if (!output || /[\r\n]/.test(output)) {
      throw new Error(`JavaScript must be exactly one non-empty line: ${file}`);
    }
    fs.writeFileSync(target, output);
  }
}

function checkJavaScript(stageRoot) {
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", path.join(stageRoot, file)], { stdio: "pipe" });
  }
}

function testSingleLineStage(stageRoot, verifyRoot) {
  copyRuntimeFiles(verifyRoot);
  for (const file of ["README.md", "README.zh-CN.md", "tsconfig.json"]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(verifyRoot, file));
  }
  fs.cpSync(path.join(ROOT, "scripts"), path.join(verifyRoot, "scripts"), { recursive: true });
  fs.cpSync(path.join(ROOT, "test"), path.join(verifyRoot, "test"), { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(verifyRoot, "src"), { recursive: true });
  for (const sourceFile of RUNTIME_SOURCE_FILES) {
    const source = path.join(ROOT, sourceFile);
    const destination = path.join(verifyRoot, sourceFile);
    mkdirp(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    const stagedFile = path.join(stageRoot, file);
    const compiledFile = path.join(verifyRoot, compiledRuntimePath(file));
    mkdirp(path.dirname(compiledFile));
    fs.copyFileSync(stagedFile, compiledFile);
    fs.copyFileSync(stagedFile, path.join(verifyRoot, file));
  }
  const tests = fs.readdirSync(path.join(verifyRoot, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("test", name));
  const nodePath = [path.join(ROOT, "node_modules"), process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  try {
    execFileSync(process.execPath, ["--test", ...tests], {
      cwd: verifyRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: nodePath },
      stdio: "pipe",
    });
  } catch (error) {
    const stdout = String(error && error.stdout || "").trim();
    const stderr = String(error && error.stderr || "").trim();
    throw new Error(`single-line stage regression failed${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`);
  }
}

function verifyStage(stageRoot) {
  const staged = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(stageRoot, absolute).split(path.sep).join("/");
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else staged.push(relative);
    }
  }
  walk(stageRoot);
  assert.deepEqual(staged, [...RUNTIME_FILES].sort(), "staged package file list drifted");
  const manifestText = fs.readFileSync(path.join(stageRoot, "manifest.json"), "utf8");
  const stagedManifest = JSON.parse(manifestText);
  assert.equal(manifestText, JSON.stringify(stagedManifest), "staged manifest.json must be minified to one line");
  assert.equal(stagedManifest.version, MANIFEST.version);
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date("2024-01-01T00:00:00Z")) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosDate, dosTime };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createZip(stageRoot, destination) {
  const files = [...RUNTIME_FILES].sort();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const data = fs.readFileSync(path.join(stageRoot, file));
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), name, compressed,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  fs.writeFileSync(destination, Buffer.concat([...localParts, central, end]));
}

async function main() {
  const replace = process.argv.includes("--replace");
  if (fs.existsSync(OUT) && !replace) {
    const archive = fs.readFileSync(OUT);
    console.log(JSON.stringify({
      output: OUT,
      skipped: true,
      reason: "output already exists; use --replace to rebuild it",
      size: archive.length,
      sha256: sha256(archive),
    }, null, 2));
    return;
  }
  const sourceSnapshot = snapshotSources();
  compileTypeScript();
  assertSourceUnchanged(sourceSnapshot);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-collab-toolpkg-stage-"));
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-collab-toolpkg-verify-"));
  const tempArchive = `${OUT}.tmp`;
  try {
    copyRuntimeFiles(stageRoot);
    minifyManifest(stageRoot);
    singleLineJavaScript(stageRoot);
    checkJavaScript(stageRoot);
    verifyStage(stageRoot);
    testSingleLineStage(stageRoot, verifyRoot);
    assertSourceUnchanged(sourceSnapshot);
    rmrf(tempArchive);
    createZip(stageRoot, tempArchive);
    if (fs.existsSync(OUT)) fs.rmSync(OUT);
    fs.renameSync(tempArchive, OUT);
    assertSourceUnchanged(sourceSnapshot);
    const archive = fs.readFileSync(OUT);
    console.log(JSON.stringify({
      output: OUT,
      size: archive.length,
      sha256: sha256(archive),
      entries: RUNTIME_FILES.length,
      single_line_js: RUNTIME_FILES.filter((file) => file.endsWith(".js")).length,
      javascript_transform: "compress-without-mangling",
      terser: TERSER_VERSION,
    }, null, 2));
  } finally {
    rmrf(tempArchive);
    rmrf(stageRoot);
    rmrf(verifyRoot);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  MANIFEST,
  OUT,
  PROJECT_NAME,
  ROOT,
  RUNTIME_FILES,
  RUNTIME_SOURCE_FILES,
  compiledRuntimePath,
  metadataPrefix,
  minifyManifest,
  singleLineJavaScript,
  snapshotSources,
  verifyStage,
};