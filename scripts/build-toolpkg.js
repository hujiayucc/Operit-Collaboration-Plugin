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
const RUNTIME_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "manifest.json",
  "tsconfig.json",
  "types/runtime.d.ts",
  "src/main.js",
  "src/protocol.js",
  "src/collaboration/engine.js",
  "src/collaboration/helpers.js",
  "src/collaboration/manager.js",
  "src/collaboration/model.js",
  "src/collaboration/store.js",
  "src/packages/collaboration.js",
  "src/packages/tool_lifecycle_probe.js",
  "src/ui/collaboration_dashboard/api.js",
  "src/ui/collaboration_dashboard/components.js",
  "src/ui/collaboration_dashboard/i18n.js",
  "src/ui/collaboration_dashboard/index.ui.js",
  "src/ui/collaboration_dashboard/model.js",
  "src/ui/collaboration_dashboard/request-id.js",
  "src/ui/collaboration_dashboard/validation.js",
]);
const TERSER_ARGS = Object.freeze([
  "--yes",
  `terser@${TERSER_VERSION}`,
  "--compress",
  "passes=1,unsafe=false",
  "--keep-fnames",
  "--keep-classnames",
  "--format",
  "comments=false",
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
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    entries[file] = sha256(read(file));
  }
  return entries;
}

function assertSourceUnchanged(before) {
  assert.deepEqual(snapshotSources(), before, "source JS changed during package build");
}

function copyRuntimeFiles(stageRoot) {
  for (const file of RUNTIME_FILES) {
    const source = path.join(ROOT, file);
    const destination = path.join(stageRoot, file);
    if (!fs.existsSync(source)) throw new Error(`runtime file missing: ${file}`);
    mkdirp(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
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

function minifyJavaScript(stageRoot) {
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    const target = path.join(stageRoot, file);
    const prefix = metadataPrefix(fs.readFileSync(target, "utf8"), file);
    const minified = execFileSync("npx", [...TERSER_ARGS, "--", target], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const output = `${prefix}${minified}`;
    if (!output || /[\r\n]/.test(output)) {
      throw new Error(`minified JavaScript must be exactly one non-empty line: ${file}`);
    }
    fs.writeFileSync(target, output);
  }
}

function checkJavaScript(stageRoot) {
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", path.join(stageRoot, file)], { stdio: "pipe" });
  }
}

function testMinifiedStage(stageRoot, verifyRoot) {
  copyRuntimeFiles(verifyRoot);
  fs.cpSync(path.join(ROOT, "scripts"), path.join(verifyRoot, "scripts"), { recursive: true });
  fs.cpSync(path.join(ROOT, "test"), path.join(verifyRoot, "test"), { recursive: true });
  for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
    fs.copyFileSync(path.join(stageRoot, file), path.join(verifyRoot, file));
  }
  const tests = fs.readdirSync(path.join(verifyRoot, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("test", name));
  try {
    execFileSync(process.execPath, ["--test", ...tests], {
      cwd: verifyRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const stdout = String(error && error.stdout || "").trim();
    const stderr = String(error && error.stderr || "").trim();
    throw new Error(`minified stage regression failed${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`);
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(stageRoot, "manifest.json"), "utf8")).version, MANIFEST.version);
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
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-collab-toolpkg-stage-"));
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-collab-toolpkg-verify-"));
  const tempArchive = `${OUT}.tmp`;
  try {
    copyRuntimeFiles(stageRoot);
    minifyJavaScript(stageRoot);
    checkJavaScript(stageRoot);
    verifyStage(stageRoot);
    testMinifiedStage(stageRoot, verifyRoot);
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
      minified_js: RUNTIME_FILES.filter((file) => file.endsWith(".js")).length,
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

module.exports = { MANIFEST, OUT, PROJECT_NAME, ROOT, RUNTIME_FILES, metadataPrefix, snapshotSources, verifyStage };