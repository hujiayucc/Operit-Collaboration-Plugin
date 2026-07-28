"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "src/ui/collaboration_dashboard/index.ui.js"), "utf8");
const { TEXT: referenceText } = require("../src/ui/collaboration_dashboard/i18n.js");
const { __test } = require("../src/ui/collaboration_dashboard/index.ui.js");

test("reference dashboard copy tracks active fixed-copy keys", () => {
  for (const language of ["zh", "en"]) {
    assert.deepEqual(Object.keys(referenceText[language]).sort(), Object.keys(__test.TEXT[language]).sort());
    assert.deepEqual(Object.keys(referenceText[language].errors).sort(), Object.keys(__test.TEXT[language].errors).sort());
    assert.deepEqual(Object.keys(referenceText[language].eventTypes).sort(), Object.keys(__test.TEXT[language].eventTypes).sort());
    assert.deepEqual(Object.keys(referenceText[language].eventFields).sort(), Object.keys(__test.TEXT[language].eventFields).sort());
    assert.deepEqual(Object.keys(referenceText[language].controlSourceOptions).sort(),
      Object.keys(__test.TEXT[language].controlSourceOptions).sort());
  }
});

test("active inline copy retains the host-required standalone structure", () => {
  assert.doesNotMatch(indexSource, /\brequire\s*\(/);
  assert.deepEqual(Object.keys(__test.TEXT.zh.controlSourceOptions).sort(),
    ["action_gate_repair", "agent_response", "continuation_repair", "none", "summary_repair"]);
});

test("dashboard error formatter localizes fallback codes and retains diagnostics", () => {
  const malformed = new Error("");
  malformed.code = "ipc_invalid_response";
  malformed.details = { channel: "collaboration.list_agents" };
  assert.equal(__test.formatErrorText(malformed, __test.TEXT.zh),
    "IPC 响应格式无效: {\"channel\":\"collaboration.list_agents\"}");

  const denied = new Error("denied by policy");
  denied.code = "operation_failed";
  denied.details = { policy: "strict" };
  assert.equal(__test.formatErrorText(denied, __test.TEXT.en),
    "Operation failed: denied by policy: {\"policy\":\"strict\"}");
});