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
  assert.equal(manifest.version, "1.0.0");
  for (const subpackage of manifest.subpackages) {
    const metadata = metadataFor(subpackage.entry);
    assert.equal(metadata.name, subpackage.id);
    assert.deepEqual(metadata.display_name, subpackage.display_name);
    assert.equal(metadata.enabledByDefault, subpackage.enabled_by_default);
    assert.equal(metadata.category, "System");
    for (const language of ["zh", "en"]) {
      assert.ok(metadata.description[language].length >= 80, `${subpackage.id} ${language} description too short`);
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

test("package metadata states critical runtime limits", () => {
  const collaboration = metadataFor("src/packages/collaboration.js");
  const collaborationText = `${collaboration.description.zh} ${collaboration.description.en}`;
  assert.match(collaborationText, /SQLite/);
  assert.match(collaborationText, /Event Store/);
  assert.match(collaborationText, /schema v3/);
  assert.match(collaborationText, /幂等|idempotency/i);
  assert.match(collaborationText, /execution.?epoch|epoch/i);
  assert.match(collaborationText, /6.*3|three/i);
  assert.match(collaborationText, /父子|parent.child/i);
  assert.match(collaborationText, /中断|interruption/i);
  assert.match(collaborationText, /request_id/);
});