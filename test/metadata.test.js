"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function metadataFor(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const match = source.match(/\/\* METADATA\s*([\s\S]*?)\*\//);
  assert.ok(match, `missing METADATA in ${relativePath}`);
  return JSON.parse(match[1]);
}

function exportedFunctionNames(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const match = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(match, `missing module.exports in ${relativePath}`);
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !NON_TOOL_EXPORTS.has(value))
    .sort();
}

// Exports that are host lifecycle hooks rather than user-callable tools. The
// host requires the hook function to be a member of the subpackage exports so
// it can be registered, but it must not be listed as a tool in METADATA.
const NON_TOOL_EXPORTS = new Set(["onToolLifecycle"]);

test("subpackage metadata matches manifest and exported tools", () => {
  assert.equal(manifest.version, "1.0.1");
  for (const subpackage of manifest.subpackages) {
    const metadata = metadataFor(subpackage.entry);
    assert.equal(metadata.name, subpackage.id);
    assert.deepEqual(metadata.display_name, subpackage.display_name);
    assert.deepEqual(metadata.description, subpackage.description, `${subpackage.id} manifest and METADATA descriptions must stay synchronized`);
    assert.equal(metadata.enabledByDefault, subpackage.enabled_by_default);
    assert.equal(metadata.category, "System");
    for (const language of ["zh", "en"]) {
      assert.ok(metadata.description[language].length >= 80, `${subpackage.id} ${language} description too short`);
      if (subpackage.id === "collaboration") {
        for (const phrase of ["request_id", "epoch"]) {
          assert.ok(subpackage.description[language].includes(phrase), `${subpackage.id} manifest ${language} missing ${phrase}`);
          assert.ok(metadata.description[language].includes(phrase), `${subpackage.id} metadata ${language} missing ${phrase}`);
        }
      }
    }
    const toolNames = metadata.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, exportedFunctionNames(subpackage.entry));
    for (const tool of metadata.tools) {
      assert.ok(tool.description.zh);
      assert.ok(tool.description.en);
      assert.ok(Array.isArray(tool.parameters));
      for (const parameter of tool.parameters) {
        assert.ok(parameter.name);
        assert.ok(parameter.description.zh);
        assert.ok(parameter.description.en);
        assert.ok(["string", "number", "boolean"].includes(parameter.type));
        assert.equal(typeof parameter.required, "boolean");
      }
    }
  }
});

test("AI-facing metadata documents global budgets and gateway precedence", () => {
  const collaboration = metadataFor("src/packages/collaboration.js");
  const spawn = collaboration.tools.find((tool) => tool.name === "spawn_agent");
  const followup = collaboration.tools.find((tool) => tool.name === "followup_task");
  for (const tool of [spawn, followup]) {
    const parameter = tool.parameters.find((item) => item.name === "max_tool_calls");
    assert.match(`${parameter.description.zh} ${parameter.description.en}`, /全局|global/i);
    assert.match(`${parameter.description.zh} ${parameter.description.en}`, /覆盖|overridden/i);
    assert.match(`${parameter.description.zh} ${parameter.description.en}`, /1.?64|1-64/);
    const context = tool.parameters.find((item) => item.name === "context");
    const contextText = `${context.description.zh} ${context.description.en}`;
    assert.match(contextText, /不可见|absent/i);
    assert.match(contextText, /固定隐藏|fixed-hidden/i);
    assert.match(contextText, /准确契约|accurate contract/i);
    assert.match(contextText, /权威源文件|authoritative source file/i);
    assert.match(contextText, /不得要求其凭记忆补全|do not require reconstruction from memory/i);
  }

  const probe = metadataFor("src/packages/tool_lifecycle_probe.js");
  assert.equal(probe.tools.length, 7);
  const gateway = probe.tools.find((tool) => tool.name === "gateway_register");
  const gatewayText = `${gateway.description.zh} ${gateway.description.en} ` +
    gateway.parameters.map((parameter) => `${parameter.description.zh} ${parameter.description.en}`).join(" ");
  assert.match(gatewayText, /优先|precedence/i);
  assert.match(gatewayText, /非法 JSON|Invalid JSON/i);
  assert.match(gatewayText, /关闭式|fails closed/i);
  assert.match(gatewayText, /无权|cannot call/i);
});

test("package metadata states critical runtime limits", () => {
  const collaboration = metadataFor("src/packages/collaboration.js");
  const collaborationManifest = manifest.subpackages.find((subpackage) => subpackage.id === "collaboration");
  const collaborationText = `${collaboration.description.zh} ${collaboration.description.en}`;
  const manifestText = `${collaborationManifest.description.zh} ${collaborationManifest.description.en}`;
  const spawn = collaboration.tools.find((tool) => tool.name === "spawn_agent");
  const spawnText = `${spawn.description.zh} ${spawn.description.en}`;
  const list = collaboration.tools.find((tool) => tool.name === "list_agents");
  const listText = `${list.description.zh} ${list.description.en}`;
  assert.match(collaborationText, /SQLite/);
  assert.match(collaborationText, /Event Store/);
  assert.match(collaborationText, /schema v3/i);
  assert.match(manifestText, /schema v3/i);
  assert.match(collaborationText, /幂等|idempotency/i);
  assert.match(collaborationText, /execution.?epoch|epoch/i);
  assert.match(collaborationText, /1.?16|one to sixteen|1 to 16/i);
  assert.match(collaborationText, /单根.*可配置|per.root.*configurable/i);
  assert.match(collaborationText, /1.?8|one to eight|1 to 8/i);
  assert.match(collaborationText, /0.?12|0-12/);
  assert.match(collaborationText, /默认 5|default 5/i);
  assert.match(collaborationText, /余额|balance/i);
  assert.match(collaborationText, /权限隔离|permission isolation/i);
  assert.match(spawnText, /queued.*不表示任务完成|queued.*not.*complete/i);
  assert.match(listText, /created_at.*agent_id|created_at.*agent_id/i);
  assert.match(`${collaboration.description.zh} ${collaboration.description.en}`, /内存回退|in-memory fallback/i);
  assert.equal(/repaired|finalization|收尾|safe summary|安全摘要/i.test(collaborationText), false);
  assert.equal(/repaired|finalization|收尾|safe summary|安全摘要/i.test(manifestText), false);
});