"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const buildPath = path.join(root, "scripts/build-toolpkg.js");
const { spawnSync } = require("node:child_process");
const {
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
} = require(buildPath);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function packageMetadata(file) {
  const sourceFile = fs.existsSync(path.join(root, file)) ? file : file.replace(/\.js$/, ".ts");
  const source = fs.readFileSync(path.join(root, sourceFile), "utf8");
  const match = source.match(/\/\* METADATA\s*([\s\S]*?)\*\//);
  assert.ok(match, `missing source METADATA for ${file}`);
  return JSON.parse(match[1]);
}

function metadataToolNames(file) {
  return packageMetadata(file).tools.map((tool) => tool.name);
}

test("ToolPkg build script preserves the explicit runtime package manifest", () => {
  assert.equal(RUNTIME_FILES.length, 18);
  assert.equal(new Set(RUNTIME_FILES).size, RUNTIME_FILES.length);
  assert.equal(RUNTIME_FILES.includes("manifest.json"), true);
  for (const excluded of ["LICENSE", "README.md", "README.zh-CN.md", "tsconfig.json"]) {
    assert.equal(RUNTIME_FILES.includes(excluded), false);
  }
  assert.equal(RUNTIME_FILES.includes("dist/main.js"), true);
  assert.equal(RUNTIME_FILES.some((file) => file.startsWith("src/") && file.endsWith(".js")), false);
  assert.equal(RUNTIME_FILES.some((file) => file.startsWith("src/") && file.endsWith(".ts")), false);
  assert.equal(compiledRuntimePath("dist/main.js"), "dist/main.js");
  for (const module of ["api", "components", "i18n", "model", "request-id", "validation"]) {
    assert.equal(RUNTIME_FILES.includes(`dist/ui/collaboration_dashboard/${module}.js`), true);
    assert.equal(RUNTIME_SOURCE_FILES.includes(`src/ui/collaboration_dashboard/${module}.ts`), true);
    assert.equal(RUNTIME_SOURCE_FILES.includes(`src/ui/collaboration_dashboard/${module}.js`), false);
  }
  for (const module of ["protocol", "collaboration/helpers", "collaboration/model", "collaboration/store", "packages/collaboration", "packages/tool_lifecycle_probe"]) {
    assert.equal(RUNTIME_FILES.includes(`dist/${module}.js`), true);
    assert.equal(RUNTIME_SOURCE_FILES.includes(`src/${module}.ts`), true);
    assert.equal(RUNTIME_SOURCE_FILES.includes(`src/${module}.js`), false);
  }
  assert.equal(RUNTIME_FILES.some((file) => file.startsWith("test/")), false);
  assert.equal(RUNTIME_FILES.some((file) => file.startsWith("prompts/")), false);
  for (const file of RUNTIME_FILES) {
    assert.equal(fs.existsSync(path.join(root, compiledRuntimePath(file))), true, `missing runtime source: ${file}`);
  }
  for (const file of RUNTIME_SOURCE_FILES) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `missing TypeScript runtime source: ${file}`);
  }
});

test("English and Chinese READMEs stay concise and synchronized", () => {
  const english = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const chinese = fs.readFileSync(path.join(root, "README.zh-CN.md"), "utf8");
  const semanticVersion = /\bv?\d+\.\d+\.\d+\b/;
  assert.equal(english.startsWith("<div align=\"center\">"), true);
  assert.equal(chinese.startsWith("<div align=\"center\">"), true);
  assert.match(english, new RegExp(`# ${MANIFEST.display_name.en}`));
  assert.match(chinese, new RegExp(`# ${MANIFEST.display_name.zh}`));
  assert.match(english, /\[Project Repository\]\(https:\/\/github\.com\/hujiayucc\/Operit-Collaboration-Plugin\)/);
  assert.match(chinese, /\[项目仓库\]\(https:\/\/github\.com\/hujiayucc\/Operit-Collaboration-Plugin\)/);
  assert.match(english, /\*\*English \| \[简体中文\]\(README\.zh-CN\.md\)\*\*/);
  assert.match(chinese, /\*\*\[English\]\(README\.md\) \| 简体中文\*\*/);
  assert.doesNotMatch(english, semanticVersion);
  assert.doesNotMatch(chinese, semanticVersion);
  assert.ok(english.length < 10000, "English README should remain concise");
  assert.ok(chinese.length < 6000, "Chinese README should remain concise");
  assert.ok(english.split(/\r?\n/).length <= 140, "English README has too many lines");
  assert.ok(chinese.split(/\r?\n/).length <= 140, "Chinese README has too many lines");

  const collaborationTools = metadataToolNames("src/packages/collaboration.js");
  assert.equal(collaborationTools.length, 13);
  assert.match(english, /Thirteen collaboration and control tools/);
  assert.match(chinese, /十三个协作与控制工具/);
  for (const tool of collaborationTools) {
    assert.ok(english.includes(`\`${tool}\``), `English README missing collaboration tool: ${tool}`);
    assert.ok(chinese.includes(`\`${tool}\``), `Chinese README missing collaboration tool: ${tool}`);
  }
  assert.match(english, /SQLite Event Store schema v4.*in-memory fallback/is);
  assert.match(chinese, /SQLite Event Store schema v4.*SQLite 不可用时.*回退到内存/s);
  assert.match(english, /Global active Runs.*0.*unlimited.*1.*16.*Active Runs per root.*0.*unlimited.*1.*8/is);
  assert.match(chinese, /全局活动 Run.*0.*不限.*1.*16.*单根任务树活动 Run.*0.*不限.*1.*8/s);
  assert.match(english, /max_model_retries.*-1.*unlimited.*0.*12.*Balance.*not retried/is);
  assert.match(chinese, /max_model_retries.*-1.*不限.*0.*12.*余额不足.*不重试/s);
  assert.match(english, /message_acks.*Only IDs actually processed/is);
  assert.match(chinese, /message_acks.*只应确认实际处理过的 ID/s);
  assert.match(english, /timeout_ms.*0.*unlimited.*integer.*30000.*3600000.*timeout_invalid/is);
  assert.match(chinese, /timeout_ms.*0.*不限.*30000.*3600000.*整数.*timeout_invalid/s);
  assert.match(english, /max_tool_calls.*0.*unlimited.*1.*64/is);
  assert.match(chinese, /max_tool_calls.*0.*不限.*1.*64/s);
  assert.match(english, /outbound_messages.*main_messages/is);
  assert.match(chinese, /outbound_messages.*main_messages/s);
  assert.match(english, /IPC execution guard/);
  assert.match(chinese, /IPC 执行守卫/);

  for (const file of [
    "prompt-full-zh.md",
    "prompt-full-en.md",
    "prompt-read-only-zh.md",
    "prompt-read-only-en.md",
    "prompt-mini-zh.md",
    "prompt-mini-en.md",
  ]) {
    assert.ok(english.includes(`\`${file}\``), `English README missing system prompt template: ${file}`);
    assert.ok(chinese.includes(`\`${file}\``), `Chinese README missing system prompt template: ${file}`);
  }
  assert.match(english, /archive contains only runtime files and a single-line `manifest\.json`/i);
  assert.match(english, /Compiled JavaScript is stored under `dist\/` in the archive.*TypeScript source files are excluded/i);
  assert.match(chinese, /安装包仅包含运行时文件和单行 `manifest\.json`/);
  assert.match(chinese, /已编译 JavaScript.*安装包的 `dist\/` 目录.*TypeScript 源文件不会入包/);
  assert.match(english, /TypeScript source files are excluded.*`prompts\/`/i);
  assert.match(chinese, /TypeScript 源文件不会入包.*`prompts\/`.*不会入包/);
  assert.match(english, /Neither the README files nor these source templates are automatically read or injected/i);
  assert.match(chinese, /两份 README 和这些源码模板不会被运行时自动读取或注入/);
});

test("system prompt templates keep collaboration decisions and runtime facts aligned", () => {
  const templates = [
    "prompts/prompt-full-zh.md",
    "prompts/prompt-full-en.md",
    "prompts/prompt-read-only-zh.md",
    "prompts/prompt-read-only-en.md",
  ];
  const collaborationTools = metadataToolNames("src/packages/collaboration.js");
  assert.equal(collaborationTools.length, 13);
  const unrestrictedPrefixEnd = "BEGIN.\n\n";
  const availableTemplates = templates.filter((file) => fs.existsSync(path.join(root, file)));
  if (availableTemplates.length === 0) {
    assert.equal(
      RUNTIME_FILES.some((file) => file.startsWith("prompts/")),
      false,
      "runtime-only verification must not package system prompt templates",
    );
    return;
  }
  assert.deepEqual(availableTemplates, templates, "source checkout must contain all system prompt templates");
  for (const file of templates) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const readOnlyTemplate = file.includes("read-only-");
    const chineseTemplate = !file.endsWith("-en.md");
    if (readOnlyTemplate) {
      assert.equal(
        source.startsWith(chineseTemplate
          ? "[只读能力边界——覆盖下方模式文本]\n"
          : "[READ-ONLY CAPABILITY BOUNDARY — OVERRIDES MODE TEXT BELOW]\n"),
        true,
        `${file} missing read-only boundary`,
      );
      assert.ok(source.indexOf("[MODE: UNRESTRICTED]") > 0, `${file} missing priority prefix after read-only boundary`);
      assert.match(
        source,
        chineseTemplate
          ? /不授予写入能力，也不扩大已分配权限/
          : /does not grant write capability or expand assigned permissions/i,
        `${file} allows mode text to expand read-only permissions`,
      );
      assert.match(
        source,
        chineseTemplate
          ? /不得创建、编辑、覆盖、删除、移动、复制、重命名、解压、下载、构建、安装/
          : /Do not create, edit, overwrite, delete, move, copy, rename, extract, download, build, install/i,
        `${file} missing read-only operation boundary`,
      );
    } else {
      assert.equal(
        source.startsWith(chineseTemplate
          ? "[MODE: UNRESTRICTED]\n\n首遍规范化器："
          : "[MODE: UNRESTRICTED]\n\nFIRST-PASS NORMALIZER:"),
        true,
        `${file} missing priority prefix`,
      );
    }
    assert.equal((source.match(/\[MODE: UNRESTRICTED\]/g) || []).length, readOnlyTemplate ? 2 : 1, `${file} has an unexpected mode-reference count`);
    assert.ok(
      source.includes(chineseTemplate ? "Operit 是一个沙箱执行器。" : "Operit is a sandbox executor."),
      `${file} missing Operit identity`,
    );
    assert.ok(source.includes("GPT/Operit jailbreak"), `${file} missing Codex-to-Operit replacement`);
    assert.equal(source.includes("Codex"), false, `${file} retains Codex`);
    assert.ok(source.indexOf(unrestrictedPrefixEnd) > 0, `${file} missing priority-prefix terminator`);
    for (const toolName of collaborationTools) {
      assert.ok(source.includes(`\`${toolName}\``), `${file} missing public collaboration tool: ${toolName}`);
    }
    assert.match(source, /协作收益|collaboration benefit/i, `${file} missing collaboration benefit gate`);
    assert.match(source, /1(?:\s*(?:–|-|to)\s*)16/i, `${file} missing configurable 1-16 global limit`);
    assert.match(source, /1(?:\s*(?:–|-|to)\s*)8/i, `${file} missing configurable 1-8 per-root limit`);
    assert.match(source, /max_model_retries/i, `${file} missing model retry setting`);
    assert.match(source, /0(?:\s*(?:–|-|to)\s*)12/i, `${file} missing configurable 0-12 model retry range`);
    assert.match(source, /余额不足|insufficient balance/i, `${file} missing non-retryable balance boundary`);
    assert.match(source, /SQLite Event Store schema v4/i, `${file} missing persistence model`);
    assert.match(source, /回退到内存|falls back to memory/i, `${file} missing memory fallback`);
    assert.match(source, /persistence: "memory"/i, `${file} missing fallback response marker`);
    assert.match(source, /message_acks/i, `${file} missing message acknowledgements`);
    assert.match(source, /不得编造 ID|do not invent IDs/i, `${file} missing ACK boundary`);
    assert.match(source, /决策门|decision gate/i, `${file} missing no-tool decision gate`);
    for (const action of ["progress", "finish", "fail"]) {
      assert.match(source, new RegExp(`\\b${action}\\b`, "i"), `${file} missing ${action} decision`);
    }
    assert.match(
      source,
      /不得自动视为父任务完成|must not automatically be treated as completion of the parent task/i,
      `${file} missing parent completion boundary`,
    );
    assert.match(
      source,
      /满足.*完成判据.*必要验证|satisfy every completion criterion.*necessary verification/is,
      `${file} missing completion-and-verification tool-call rule`,
    );
  }

  for (const file of ["prompts/prompt-full-zh.md", "prompts/prompt-full-en.md"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /目标不存在.*正常前置条件|target being absent.*normal precondition/i);
    assert.match(source, /写入成功不能替代内容验证|successful write response does not replace content verification/i);
    assert.match(source, /已确认副作用成功.*不得重复|side effect is confirmed successful.*do not repeat/is);
  }
});

test("mini system prompt templates match the public ToolPkg contract without invented tool names", () => {
  const miniFiles = [
    "prompts/prompt-mini-zh.md",
    "prompts/prompt-mini-en.md",
  ];
  if (miniFiles.every((file) => !fs.existsSync(path.join(root, file)))) {
    assert.equal(RUNTIME_FILES.some((file) => file.startsWith("prompts/")), false);
    return;
  }
  assert.equal(miniFiles.every((file) => fs.existsSync(path.join(root, file))), true);
  const collaborationTools = metadataToolNames("src/packages/collaboration.js");
  assert.equal(collaborationTools.length, 13);
  const probeTools = [
    "probe_get_status",
    "probe_get_log",
    "probe_clear_log",
    "probe_get_prompt_compose_log",
    "gateway_register",
    "gateway_unregister",
    "gateway_status",
  ];
  const forbiddenInventedNames = [
    "probe_before_tool_call",
    "probe_after_tool_call",
    "get_probe_logs",
    "clear_probe_logs",
    "get_gateway_policy",
    "set_gateway_policy",
    "clear_gateway_policy",
    "probe_tool_call",
    "probe_prompt_compose",
    "list_diagnostics",
    "clear_diagnostics",
    "preview_tool_visibility",
  ];
  for (const file of miniFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const name of [...collaborationTools, ...probeTools]) {
      assert.ok(source.includes(`\`${name}\``), `${file} missing public tool: ${name}`);
    }
    for (const name of forbiddenInventedNames) {
      assert.equal(source.includes(name), false, `${file} contains invented tool: ${name}`);
    }
    assert.match(source, /read_only/i);
    assert.match(source, /target_paths_json/);
    assert.match(source, /workspace_path/);
    assert.match(source, /workspace_env/);
    assert.match(source, /agent_ids_json/);
    assert.match(source, /timeout_ms/);
    assert.match(source, /max_tool_calls/);
    assert.match(source, /max_model_retries/);
    assert.match(source, /0(?:\s*(?:–|-|to)\s*)12/i);
    assert.match(source, /SQLite Event Store schema v4/i);
    assert.match(source, /persistence\s*=\s*memory/i);
    assert.match(source, /COLLABORATION_CONTROL/);
    assert.match(source, /execution_epoch/);
    assert.match(source, /message_acks/);
    assert.match(source, /progress.*finish.*fail/is);
    assert.match(source, /当前 Run.*活动后代|current Run.*active descendants/i);
    assert.match(source, /生命周期探针 hook.*allow|Lifecycle probe hooks return allow/i);
    assert.doesNotMatch(source, /\b(?:label|role|model|allowed_tools|denied_tools|timeout_seconds|include_terminal)\b/);
  }
});

test("ToolPkg build keeps every public plugin tool hidden from collaboration agents", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const hiddenSetMatch = mainSource.match(/(?:const\s+)?AGENT_HIDDEN_TOOL_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(hiddenSetMatch, "missing AGENT_HIDDEN_TOOL_NAMES declaration");
  const hiddenNames = new Set(Array.from(
    hiddenSetMatch[1].matchAll(/["']([^"']+)["']/g),
    (match) => match[1],
  ));
  for (const toolName of [
    ...metadataToolNames("src/packages/collaboration.js"),
    ...metadataToolNames("src/packages/tool_lifecycle_probe.js"),
  ]) {
    assert.equal(hiddenNames.has(toolName), true, `AGENT_HIDDEN_TOOL_NAMES is missing: ${toolName}`);
  }
});

test("ToolPkg build script derives project and output paths dynamically", () => {
  assert.equal(ROOT, root);
  assert.equal(PROJECT_NAME, path.basename(root));
  assert.equal(MANIFEST.version, "1.0.2");
  assert.equal(MANIFEST.main, "dist/main.js");
  assert.deepEqual(MANIFEST.subpackages.map((subpackage) => subpackage.entry), [
    "dist/packages/collaboration.js",
    "dist/packages/tool_lifecycle_probe.js",
  ]);
  assert.equal(OUT, path.join(root, `${path.basename(root)}-v${MANIFEST.version}.toolpkg`));
  assert.equal(path.dirname(OUT), root);
});


test("ToolPkg build without --replace skips an existing archive with exit code zero", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-build-existing-output-"));
  const fixtureScript = path.join(fixtureRoot, "scripts", "build-toolpkg.js");
  const fixtureOutput = path.join(fixtureRoot, `${path.basename(fixtureRoot)}-v1.0.2.toolpkg`);
  const archive = Buffer.from("existing-toolpkg-fixture");
  try {
    fs.mkdirSync(path.dirname(fixtureScript), { recursive: true });
    fs.copyFileSync(buildPath, fixtureScript);
    fs.writeFileSync(path.join(fixtureRoot, "manifest.json"), JSON.stringify({ version: "1.0.2" }));
    fs.writeFileSync(fixtureOutput, archive);
    const result = spawnSync(process.execPath, [fixtureScript], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.output, fixtureOutput);
    assert.equal(output.skipped, true);
    assert.match(output.reason, /output already exists.*--replace/i);
    assert.equal(output.size, archive.length);
    assert.equal(output.sha256, crypto.createHash("sha256").update(archive).digest("hex"));
    assert.deepEqual(fs.readFileSync(fixtureOutput), archive);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});


test("ToolPkg stage manifest is minified without changing its data", () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-build-manifest-minify-"));
  const source = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
  const sourceHash = sha256(path.join(root, "manifest.json"));
  try {
    fs.writeFileSync(path.join(stageRoot, "manifest.json"), source);
    minifyManifest(stageRoot);
    const output = fs.readFileSync(path.join(stageRoot, "manifest.json"), "utf8");
    assert.equal(output, JSON.stringify(JSON.parse(source)));
    assert.doesNotMatch(output, /[\r\n]/);
    assert.deepEqual(JSON.parse(output), JSON.parse(source));
    assert.equal(sha256(path.join(root, "manifest.json")), sourceHash);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});


test("ToolPkg stage version follows manifest.json", () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-build-version-test-"));
  const originalVersion = MANIFEST.version;
  try {
    for (const file of RUNTIME_FILES) {
      const destination = path.join(stageRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, compiledRuntimePath(file)), destination);
    }
    const stagedManifest = JSON.parse(fs.readFileSync(path.join(stageRoot, "manifest.json"), "utf8"));
    stagedManifest.version = `${originalVersion}-next`;
    fs.writeFileSync(path.join(stageRoot, "manifest.json"), JSON.stringify(stagedManifest));
    MANIFEST.version = stagedManifest.version;
    verifyStage(stageRoot);
    stagedManifest.version = `${originalVersion}-mismatch`;
    fs.writeFileSync(path.join(stageRoot, "manifest.json"), JSON.stringify(stagedManifest));
    assert.throws(() => verifyStage(stageRoot));
  } finally {
    MANIFEST.version = originalVersion;
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});


test("ToolPkg JavaScript transformation compresses without mangling names", () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operit-build-js-compressed-"));
  const target = path.join(stageRoot, "dist", "main.js");
  const source = [
    '"use strict";',
    "class RetainedClass {}",
    "function retainedFunction(retainedParameter) {",
    "  const retainedLocal = retainedParameter + 1;",
    "  if (false) return 99;",
    "  return retainedLocal;",
    "}",
    "function intentionallyUnused() { return 7; }",
    "module.exports = { RetainedClass, retainedFunction, intentionallyUnused };",
  ].join("\n");
  try {
    for (const file of RUNTIME_FILES.filter((item) => item.endsWith(".js"))) {
      const fixture = path.join(stageRoot, file);
      fs.mkdirSync(path.dirname(fixture), { recursive: true });
      fs.writeFileSync(fixture, file === "dist/main.js" ? source : "module.exports = {};");
    }
    singleLineJavaScript(stageRoot);
    const output = fs.readFileSync(target, "utf8");
    assert.doesNotMatch(output, /[\r\n]/);
    assert.match(output, /class RetainedClass/);
    assert.match(output, /function retainedFunction\(retainedParameter\)/);
    assert.match(output, /function intentionallyUnused\(\)/);
    assert.match(output, /module\.exports/);
    assert.doesNotMatch(output, /retainedLocal|if\(false\)|return 99/);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});


test("ToolPkg build preserves parseable METADATA as a single-line prefix", () => {
  for (const file of ["src/packages/collaboration.ts", "src/packages/tool_lifecycle_probe.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const sourceMatch = source.match(/\/\* METADATA\s*([\s\S]*?)\*\//);
    assert.ok(sourceMatch, `missing source METADATA for ${file}`);
    const prefix = metadataPrefix(source, file);
    assert.doesNotMatch(prefix, /[\r\n]/);
    const match = prefix.match(/^\/\* METADATA (\{.*\}) \*\/$/);
    assert.ok(match, `missing single-line METADATA prefix for ${file}`);
    assert.deepEqual(JSON.parse(match[1]), JSON.parse(sourceMatch[1]));
  }
  assert.equal(metadataPrefix("module.exports = {};", "plain.js"), "");
  assert.throws(
    () => metadataPrefix("/* METADATA not-json */", "broken.js"),
    /invalid METADATA JSON in broken\.js/,
  );
});


test("ToolPkg build script source snapshot is stable with conservative compression", () => {
  const before = snapshotSources();
  const scriptHash = sha256(buildPath);
  const after = snapshotSources();
  assert.deepEqual(after, before);
  assert.equal(sha256(buildPath), scriptHash);
  const source = fs.readFileSync(buildPath, "utf8");
  assert.match(source, /execFileSync\("npm", \["run", "compile"\]/);
  assert.doesNotMatch(source, /typescript@|TYPESCRIPT_VERSION/);
  assert.match(source, /const TERSER_VERSION = "5\.31\.6"/);
  assert.match(source, /`terser@\$\{TERSER_VERSION\}`/);
  assert.match(source, /"--compress"/);
  assert.match(source, /"passes=2,unsafe=false,toplevel=false"/);
  assert.match(source, /"--no-rename"/);
  assert.match(source, /"--keep-fnames"/);
  assert.match(source, /"--keep-classnames"/);
  assert.match(source, /"comments=false,beautify=false"/);
  assert.doesNotMatch(source, /"--mangle"|mangle-properties/);
  assert.match(source, /runtime source changed during package build/);
  assert.match(source, /single-line stage regression failed/);
  assert.match(source, /JavaScript must be exactly one non-empty line/);
  assert.match(source, /output already exists; use --replace to rebuild it/);
  assert.match(source, /path\.resolve\(__dirname, "\.\."\)/);
  assert.match(source, /path\.join\(ROOT, `\$\{PROJECT_NAME\}-v\$\{MANIFEST\.version\}\.toolpkg`\)/);
  assert.match(source, /MANIFEST\.version/);
  assert.doesNotMatch(source, /"\/sdcard\/Download\//);
});