"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyErrorCode, toolFailure } = require("../dist/protocol.js");

const calls = [];
global.ToolPkg = {
  ipc: {
    async call(channel, payload, options) {
      calls.push({ channel, payload, options });
      return { ok: true, channel, payload };
    },
  },
};

const collaboration = require("../dist/packages/collaboration.js");

test("classifies structured operation errors for black-box callers", () => {
  assert.equal(classifyErrorCode("request_id conflict: duplicate"), "request_id_conflict");
  assert.equal(classifyErrorCode("write path conflict with active agent"), "path_conflict");
  assert.equal(classifyErrorCode("agent_ids must be a non-empty array"), "agent_ids_invalid");
  assert.equal(classifyErrorCode("target path is outside workspace: /tmp/output"), "path_outside_workspace");
  assert.equal(classifyErrorCode("workspace_env must be android or linux"), "workspace_env_invalid");
  assert.equal(classifyErrorCode("timeout_ms must be 0 (unlimited) or an integer between 30000 and 3600000"), "timeout_invalid");
  assert.equal(classifyErrorCode("max_model_retries must be an integer between 0 and 12"), "max_model_retries_invalid");
  assert.equal(classifyErrorCode("agent agent_1 is completed; use followup_task to start a new run"), "agent_state_invalid");
  assert.equal(classifyErrorCode("task is required"), "parameter_required");
  const failure = toolFailure(new Error("limit must be an integer between 1 and 100"), "list_agents");
  assert.equal(failure.transport_success, true);
  assert.equal(failure.operation_success, false);
  assert.equal(failure.result.error.code, "limit_invalid");
  assert.equal(failure.result.error.details.operation, "list_agents");
});

test("spawn_agent returns a structured object and forwards the parent chat id", async () => {
  const result = await collaboration.spawn_agent({
    task: "implement feature",
    request_id: "spawn-request-1",
    target_paths_json: '["/repo/src"]',
    workspace_path: "/repo",
    include_conversation_context: true,
    __operit_package_chat_id: "chat_1",
  });
  assert.equal(typeof result, "object");
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).channel, "collaboration.spawn_agent");
  assert.deepEqual(calls.at(-1).payload.target_paths, ["/repo/src"]);
  assert.equal(calls.at(-1).payload.request_id, "spawn-request-1");
  assert.equal(calls.at(-1).payload.parent_chat_id, "chat_1");
  assert.equal(calls.at(-1).payload.include_conversation_context, true);
  assert.equal(calls.at(-1).options, undefined);
});

test("all collaboration package calls forward the injected caller chat id", async () => {
  const caller = "collaboration_agent:dynamic_package_caller";
  await collaboration.list_agents({ __operit_package_chat_id: caller });
  await collaboration.send_message({ agent_id: "agent_1", message: "message", __operit_package_chat_id: caller });
  await collaboration.wait_agent({ agent_ids_json: '["agent_1"]', __operit_package_chat_id: caller });
  await collaboration.interrupt_agent({ agent_id: "agent_1", __operit_package_chat_id: caller });
  for (const call of calls.slice(-4)) assert.equal(call.payload.caller_chat_id, caller);
});

test("wait_agent preserves structured operation errors without making an IPC call", async () => {
  const before = calls.length;
  const result = await collaboration.wait_agent({ agent_ids_json: "not-json" });
  assert.equal(typeof result, "object");
  assert.equal(result.transport_success, true);
  assert.equal(result.operation_success, false);
  assert.equal(result.result.success, false);
  assert.equal(result.result.error.code, "invalid_json");
  assert.match(result.result.error.message, /valid JSON/);
  assert.equal(result.result.error.details.operation, "wait_agent");
  assert.equal(calls.length, before);
});

test("unwraps structured IPC operation failures for direct package consumers", async () => {
  const original = global.ToolPkg.ipc.call;
  try {
    global.ToolPkg.ipc.call = async () => ({
      transport_success: true,
      operation_success: false,
      result: { success: false, error: { code: "limit_invalid", message: "bad limit", details: {} } },
    });
    const result = await collaboration.list_agents({ limit: 101 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, "limit_invalid");
  } finally {
    global.ToolPkg.ipc.call = original;
  }
});

test("followup_task leaves omitted target paths undefined for inheritance", async () => {
  await collaboration.followup_task({
    agent_id: "agent_1",
    task: "continue",
    include_conversation_context: true,
    __operit_package_chat_id: "chat_followup",
  });
  const payload = calls.at(-1).payload;
  assert.equal(calls.at(-1).channel, "collaboration.followup_task");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "target_paths"), false);
  assert.equal(payload.parent_chat_id, "chat_followup");
  assert.equal(payload.include_conversation_context, true);
});

test("forwards pagination and request ids for all write tools", async () => {
  await collaboration.list_agents({ limit: 25, cursor: "123:agent_1" });
  assert.equal(calls.at(-1).payload.limit, 25);
  assert.equal(calls.at(-1).payload.cursor, "123:agent_1");

  await collaboration.send_message({
    agent_id: "agent_1",
    message: "once",
    request_id: "send-1",
  });
  assert.equal(calls.at(-1).payload.request_id, "send-1");

  await collaboration.followup_task({
    agent_id: "agent_1",
    task: "continue once",
    request_id: "followup-1",
  });
  assert.equal(calls.at(-1).payload.request_id, "followup-1");

  await collaboration.interrupt_agent({ agent_id: "agent_1", request_id: "interrupt-1" });
  assert.equal(calls.at(-1).payload.request_id, "interrupt-1");
});

test("forwards Dashboard control tools through the public collaboration package", async () => {
  calls.length = 0;
  await collaboration.inspect_agent({ agent_id: "agent_1" });
  await collaboration.list_tree({ agent_id: "agent_1" });
  await collaboration.watch_tree_events({ root_run_id: "run_root_1", after_revision: 4, limit: 25 });
  await collaboration.get_settings({});
  await collaboration.update_settings({
    max_concurrent_agents: 4,
    max_active_runs_per_root: 2,
    max_tool_calls: 12,
    max_model_retries: 3,
    conversation_context_mode: "on",
  });
  await collaboration.delete_agent({ agent_id: "agent_1" });
  await collaboration.clear_history({});

  assert.deepEqual(calls.map((call) => call.channel), [
    "collaboration.inspect_agent",
    "collaboration.list_tree",
    "collaboration.watch_tree_events",
    "collaboration.get_settings",
    "collaboration.update_settings",
    "collaboration.delete_agent",
    "collaboration.clear_history",
  ]);
  assert.deepEqual(calls[2].payload, { root_run_id: "run_root_1", after_revision: 4, limit: 25, caller_chat_id: "" });
  assert.deepEqual(calls[4].payload, {
    max_concurrent_agents: 4,
    max_active_runs_per_root: 2,
    max_tool_calls: 12,
    max_model_retries: 3,
    conversation_context_mode: "on",
    caller_chat_id: "",
  });
  for (const call of calls) assert.equal(call.options, undefined);
});