"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function metadataToolNames(file) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const match = source.match(/\/\* METADATA\s*([\s\S]*?)\*\//);
  assert.ok(match, `missing source METADATA for ${file}`);
  return JSON.parse(match[1]).tools.map((tool) => tool.name);
}

// The probe state lives in main.js (main context). Per TOOLPKG_FORMAT_GUIDE
// §3.2.5, subpackage scripts run in a separate sandbox context with its own
// globalThis and module instances; cross-context state sharing requires
// ToolPkg.ipc. For unit testing we import main.js directly and exercise the
// exported probe functions, simulating the ToolPkg registration session.

// Stub the Java bridge that main.js requires at load time.
class PromptTurn {}
class SendMessageOptions {}
global.Java = {
  com: {
    ai: {
      assistance: {
        operit: {
          api: { chat: { EnhancedAIService: {} } },
          data: { model: { FunctionType: { CHAT: "CHAT", SUMMARY: "SUMMARY" } } },
          core: { config: { SystemPromptConfig: { SUBTASK_AGENT_PROMPT_TEMPLATE: "base" } } },
        },
      },
    },
  },
  kotlin: { Unit: { INSTANCE: {} } },
  type(name) {
    if (name.endsWith("PromptTurn")) return PromptTurn;
    if (name.endsWith("PromptTurnKind")) return { USER: "USER" };
    if (name.endsWith("SendMessageOptions")) return SendMessageOptions;
    throw new Error(`unexpected Java type: ${name}`);
  },
  getApplicationContext() {
    return {};
  },
};

let registeredHook = null;
const ipcHandlers = {};
global.ToolPkg = {
  registerToolLifecycleHook(definition) {
    registeredHook = definition;
  },
  registerPromptHistoryHook() {},
  registerToolPromptComposeHook() {},
  registerAppLifecycleHook() {},
  registerToolboxUiModule() {},
  ipc: {
    on(channel, handler) { ipcHandlers[channel] = handler; },
    call(channel, payload) {
      const h = ipcHandlers[channel];
      if (!h) throw new Error("channel not registered: " + channel);
      return h(payload);
    },
  },
};

const main = require("../dist/main.js");
const initialProbeStatus = main.probeGetStatus({});
assert.equal(initialProbeStatus.attribution_capability, "no_events_observed");
assert.equal(initialProbeStatus.attribution_available, false);
assert.equal(initialProbeStatus.identity_bearing_events, 0);
assert.equal(initialProbeStatus.identity_missing_events, 0);

function status() {
  return main.probeGetStatus({});
}
function getLog(params) {
  return main.probeGetLog(params || {});
}

test("probe status distinguishes active hook delivery from local registration", () => {
  const before = status();
  assert.equal(before.registered, false);
  assert.equal(before.registration_state, "not_registered");
  assert.equal(before.hook_active, false);
  main.onToolLifecycle({
    eventName: "tool_call_intercept",
    eventPayload: { toolName: "read_file" },
  });
  const after = status();
  assert.equal(after.registered, false);
  assert.equal(after.registration_state, "active_without_local_registration");
  assert.equal(after.hook_active, true);
  assert.equal(after.attribution_capability, "host_identity_fields_missing");
  assert.equal(after.attribution_available, false);
  assert.equal(after.identity_missing_events, 1);
});

test("registerToolPkg registers the lifecycle hook and sets registered=true", () => {
  registeredHook = null;
  main.registerToolPkg();
  assert.ok(registeredHook, "hook must be registered with the host");
  assert.equal(registeredHook.id, "collaboration_tool_lifecycle_probe");
  assert.equal(typeof registeredHook.function, "function");
  const s = status();
  assert.equal(s.registered, true);
  assert.equal(s.capability_hook_available, true);
});

test("onToolLifecycle always allows and never blocks", () => {
  const decision = main.onToolLifecycle({
    eventName: "onToolCallIntercept",
    eventPayload: { toolName: "delete_file", proxySenderName: "CollaborationAgent:a1" },
  });
  assert.deepEqual(decision, { decision: "allow" });
});

test("records and attributes a collaboration-agent intercept event", () => {
  main.probeClearLog({});
  main.onToolLifecycle({
    eventName: "onToolCallIntercept",
    eventPayload: {
      toolName: "edit_file",
      proxySenderName: "CollaborationAgent:agent_probe",
      chatId: "chat_probe",
      toolPkgId: "com.operit.collaboration_orchestrator",
    },
  });
  const s = status();
  assert.ok(s.total_events >= 1);
  assert.ok(s.intercept_events >= 1);
  assert.ok(s.agent_attributed_events >= 1);
  assert.equal(s.attribution_capability, "host_identity_fields_observed");
  assert.equal(s.attribution_available, true);
  assert.ok(s.identity_bearing_events >= 1);
  const log = getLog({ tool_name: "edit_file" });
  assert.ok(log.returned >= 1);
  const entry = log.entries.find((item) => item.attributed_agent_id === "agent_probe");
  assert.ok(entry, "event must attribute to the collaboration agent");
  assert.equal(entry.is_intercept_phase, true);
  assert.equal(entry.attribution_kind, "collaboration_agent");
});

test("distinguishes summary and unattributed senders", () => {
  main.probeClearLog({});
  main.onToolLifecycle({ eventPayload: { toolName: "read_file", proxySenderName: "CollaborationSummary:agent_s" } });
  main.onToolLifecycle({ eventPayload: { toolName: "read_file" } });
  const s = status();
  assert.ok(s.summary_attributed_events >= 1);
  assert.ok(s.unattributed_events >= 1);
});

test("attributes lifecycle events from collaboration chat IDs when sender identity is absent", () => {
  main.probeClearLog({});
  const before = status();
  main.onToolLifecycle({ eventPayload: { toolName: "read_file", chatId: "collaboration_agent:agent_chatid" } });
  main.onToolLifecycle({ eventPayload: { toolName: "read_file", chatId: "collaboration_summary:agent_summary:1:1" } });
  const s = status();
  assert.equal(s.agent_attributed_events, before.agent_attributed_events + 1);
  assert.equal(s.summary_attributed_events, before.summary_attributed_events + 1);
  const entries = getLog({ tool_name: "read_file" }).entries;
  assert.equal(entries[0].attributed_agent_id, "agent_chatid");
  assert.equal(entries[1].attributed_agent_id, "agent_summary");
});

test("runtime Agent tool callbacks provide stable attribution when host lifecycle identity is absent", () => {
  main.probeClearLog({});
  const before = status();
  main.probeRecordAgentToolInvocation({
    agent_id: "agent_runtime_attribution",
    execution_epoch: "agent_runtime_attribution:1:1",
    tool_name: "read_file",
  });
  const after = status();
  assert.equal(after.runtime_attributed_events, before.runtime_attributed_events + 1);
  assert.equal(after.agent_attributed_events, before.agent_attributed_events + 1);
  assert.equal(after.attribution_available, true);
  assert.equal(after.attribution_capability, "runtime_agent_callbacks_observed");
  const entry = getLog({ tool_name: "read_file" }).entries.at(-1);
  assert.equal(entry.attribution_source, "runtime_callback");
  assert.equal(entry.attributed_agent_id, "agent_runtime_attribution");
  assert.equal(entry.execution_epoch, "agent_runtime_attribution:1:1");
});

test("keeps lifecycle events unattributed when the host omits stable identity fields", () => {
  main.probeClearLog({});
  const before = status();
  main.onToolLifecycle({
    eventName: "tool_execution_started",
    functionName: "read_file",
    toolPkgId: "com.operit.collaboration_orchestrator",
    eventPayload: { toolName: "read_file" },
  });
  const after = status();
  assert.equal(after.agent_attributed_events, before.agent_attributed_events);
  assert.equal(after.summary_attributed_events, before.summary_attributed_events);
  assert.equal(after.unattributed_events, before.unattributed_events + 1);
  const entry = getLog({ tool_name: "read_file" }).entries.at(-1);
  assert.equal(entry.attribution_kind, "unattributed");
  assert.equal(entry.attributed_agent_id, "");
});

test("records stable invocation IDs without retaining lifecycle payload values", () => {
  main.probeClearLog({});
  const before = status();
  main.onToolLifecycle({
    eventName: "tool_execution_started",
    eventPayload: {
      toolName: "read_file",
      invocationId: "invocation_probe_1",
      content: "SECRET_INVOCATION_PAYLOAD",
    },
  });
  const after = status();
  assert.equal(after.identity_bearing_events, before.identity_bearing_events + 1);
  assert.equal(after.attribution_available, before.attribution_available);
  assert.equal(after.agent_attributed_events, before.agent_attributed_events);
  const entry = getLog({ tool_name: "read_file" }).entries.at(-1);
  assert.equal(entry.invocation_id, "invocation_probe_1");
  assert.equal(entry.identity_bearing, true);
  assert.equal(JSON.stringify(entry).includes("SECRET_INVOCATION_PAYLOAD"), false);
});

test("filters by sender and marks non-intercept events", () => {
  main.probeClearLog({});
  main.onToolLifecycle({ eventName: "onToolCallStart", eventPayload: { toolName: "read_file", proxySenderName: "CollaborationAgent:a2" } });
  const bySender = getLog({ proxy_sender_name: "CollaborationAgent:a2" });
  assert.equal(bySender.returned, 1);
  assert.equal(bySender.entries[0].is_intercept_phase, false);
  const other = getLog({ proxy_sender_name: "CollaborationAgent:none" });
  assert.equal(other.returned, 0);
});

test("intercept_only filter returns only pre-execution events", () => {
  main.probeClearLog({});
  main.onToolLifecycle({ eventName: "onToolCallStart", eventPayload: { toolName: "read_file" } });
  main.onToolLifecycle({ eventName: "onToolCallIntercept", eventPayload: { toolName: "edit_file" } });
  const intercepts = getLog({ intercept_only: true });
  assert.equal(intercepts.returned, 1);
  assert.equal(intercepts.entries[0].tool_name, "edit_file");
});

test("clear_log empties both buffers but preserves aggregate counts", () => {
  main.probeClearLog({});
  main.onToolLifecycle({ eventPayload: { toolName: "read_file" } });
  main.onToolPromptCompose({
    eventPayload: { chatId: "regular_clear_test", availableTools: ["read_file"] },
  });
  const before = status().total_events;
  const cleared = main.probeClearLog({});
  assert.ok(cleared.cleared >= 2);
  assert.ok(cleared.lifecycle_cleared >= 1);
  assert.ok(cleared.prompt_compose_cleared >= 1);
  assert.equal(getLog({}).returned, 0);
  assert.equal(main.probeGetPromptComposeLog({}).buffered_entries, 0);
  assert.equal(status().total_events, before, "cumulative counters must survive a buffer clear");
});

test("records payload key names without capturing file contents", () => {
  main.probeClearLog({});
  main.onToolLifecycle({
    secretTopLevel: "TOP_LEVEL_SECRET",
    eventPayload: { toolName: "read_file", proxySenderName: "CollaborationAgent:a3", content: "SECRET" },
  });
  const log = getLog({});
  const entry = log.entries[log.entries.length - 1];
  assert.ok(entry.payload_keys.includes("content"), "payload key names are recorded");
  assert.ok(entry.event_keys.includes("secretTopLevel"), "top-level key names are recorded");
  assert.equal(JSON.stringify(entry).includes("SECRET"), false, "raw payload and event values must never be stored");
});

test("never throws out of the host hook on malformed events", () => {
  assert.deepEqual(main.onToolLifecycle(undefined), { decision: "allow" });
  assert.deepEqual(main.onToolLifecycle(null), { decision: "allow" });
  assert.deepEqual(main.onToolLifecycle({}), { decision: "allow" });
});

test("subpackage forwards queries via ToolPkg.ipc to main context", async () => {
  // main.js already registered PROBE_* IPC handlers at load time via the
  // global.ToolPkg.ipc stub above. The subpackage tools call ToolPkg.ipc.call
  // which routes to those handlers in the same (test) context.
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const subStatus = await sub.probe_get_status({});
  const mainStatus = main.probeGetStatus({});
  assert.equal(typeof subStatus, "object");
  assert.equal(subStatus.registered, mainStatus.registered);
  assert.equal(subStatus.total_events, mainStatus.total_events);
});

test("probe query tools return structured IPC errors", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const originalCall = global.ToolPkg.ipc.call;
  global.ToolPkg.ipc.call = () => { throw new Error("IPC unavailable"); };
  try {
    for (const invoke of [
      () => sub.probe_get_status({}),
      () => sub.probe_get_log({}),
      () => sub.probe_clear_log({}),
      () => sub.probe_get_prompt_compose_log({}),
      () => sub.gateway_status({}),
    ]) {
      const result = await invoke();
      assert.equal(result.transport_success, true);
      assert.equal(result.operation_success, false);
      assert.equal(result.result.success, false);
      assert.equal(result.result.error.code, "operation_failed");
      assert.equal(result.result.error.message, "IPC unavailable");
    }
  } finally {
    global.ToolPkg.ipc.call = originalCall;
  }
});

test("file gateway registers and unregisters agent policies", () => {
  const agentId = "agent_test_gateway_001";
  main.registerFileGateway(agentId, { allowed_tools: ["read_file", "list_files"] });
  const status = main.fileGatewayStatus();
  assert.ok(status.registered_agents[agentId], "agent must be registered");
  assert.deepEqual(status.registered_agents[agentId].allowed_tools, ["list_files", "read_file"]);
  assert.equal(status.execution_guard, "caller_chat_id");
  assert.ok(status.fixed_hidden_tools.includes("tool_lifecycle_probe:gateway_status"));
  main.unregisterFileGateway(agentId);
  const after = main.fileGatewayStatus();
  assert.ok(!after.registered_agents[agentId], "agent must be unregistered");
});

test("onToolPromptCompose strips tools for gated agents via chatId prefix", () => {
  const agentId = "agent_test_gateway_002";
  main.registerFileGateway(agentId, { denied_tools_json: JSON.stringify(["write_file", "delete_file", "super_admin:shell"]) });
  const event = {
    eventPayload: {
      chatId: "collaboration_agent:" + agentId,
      proxySenderName: "",
      availableTools: ["read_file", "write_file", "delete_file", "list_files", "super_admin:shell"],
    },
  };
  const result = main.onToolPromptCompose(event);
  assert.ok(result, "must return a filtering result for gated agents");
  assert.ok(result.availableTools.includes("read_file"), "read_file must survive");
  assert.ok(result.availableTools.includes("list_files"), "list_files must survive");
  assert.ok(!result.availableTools.includes("write_file"), "write_file must be stripped");
  assert.ok(!result.availableTools.includes("delete_file"), "delete_file must be stripped");
  assert.ok(!result.availableTools.includes("super_admin:shell"), "shell must be stripped");
  // Verify diagnostic log recorded the gateway action
  const log = main.probeGetPromptComposeLog({});
  const last = log.entries[log.entries.length - 1];
  assert.equal(last.gateway_action, "filter_by_chatid");
  assert.equal(last.gateway_returned_tools, 2);
  main.unregisterFileGateway(agentId);
});

test("onToolPromptCompose hides plugin tools even without an agent policy", () => {
  const result = main.onToolPromptCompose({
    eventPayload: {
      chatId: "collaboration_agent:agent_without_policy",
      availableTools: [
        "read_file",
        "spawn_agent",
        "gateway_status",
        "collaboration:wait_agent",
        "tool_lifecycle_probe:probe_get_log",
      ],
    },
  });
  assert.deepEqual(result.availableTools, ["read_file"]);
});

test("onToolPromptCompose keeps all public plugin tools fixed-hidden from agents", () => {
  const collaborationTools = metadataToolNames("src/packages/collaboration.ts");
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
  const availableTools = ["read_file"];
  for (const name of collaborationTools) {
    availableTools.push(name, `collaboration:${name}`);
  }
  for (const name of probeTools) {
    availableTools.push(name, `tool_lifecycle_probe:${name}`);
  }
  const result = main.onToolPromptCompose({
    eventPayload: {
      chatId: "collaboration_agent:agent_full_fixed_hidden_set",
      availableTools,
    },
  });
  assert.deepEqual(result.availableTools, ["read_file"]);
});

test("onToolPromptCompose returns null for non-agent callers", () => {
  const event = {
    eventPayload: {
      chatId: "regular_chat",
      proxySenderName: "",
      availableTools: ["read_file", "write_file"],
    },
  };
  const result = main.onToolPromptCompose(event);
  assert.equal(result, null, "non-agent calls must not be filtered");
});

test("onToolPromptCompose strips all tools for summary and finalization chats", () => {
  const summaryEvent = {
    eventPayload: {
      chatId: "collaboration_summary:test",
      proxySenderName: "",
    },
  };
  const finalizationEvent = {
    eventPayload: {
      chatId: "collaboration_finalize:test",
      proxySenderName: "CollaborationAgent:test",
      availableTools: ["read_file", "edit_file"],
    },
  };
  assert.deepEqual(main.onToolPromptCompose(summaryEvent), { availableTools: [] });
  assert.deepEqual(main.onToolPromptCompose(finalizationEvent), { availableTools: [] });
});

test("onToolPromptCompose records prompt compose events for diagnostics", () => {
  const event = {
    eventPayload: {
      chatId: "collaboration_agent:agent_pc_test",
      proxySenderName: "",
      availableTools: ["read_file"],
    },
  };
  main.onToolPromptCompose(event);
  const log = main.probeGetPromptComposeLog({});
  assert.ok(log.entries.length > 0, "prompt compose log must have entries");
  const last = log.entries[log.entries.length - 1];
  assert.equal(last.chat_id, "collaboration_agent:agent_pc_test");
  assert.equal(last.has_available_tools, true);
  assert.deepEqual(last.available_tool_names, ["read_file"]);
});

test("dynamic package activation cannot execute fixed-hidden plugin tools from Agent contexts", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const blocked = await sub.gateway_status({
    __operit_package_chat_id: "collaboration_agent:dynamic_package_caller",
  });
  assert.equal(blocked.transport_success, true);
  assert.equal(blocked.operation_success, false);
  assert.match(blocked.result.error.message, /cannot be called from collaboration agent/);

  const blockedProbe = await sub.probe_get_status({
    __operit_package_chat_id: "collaboration_finalize:dynamic_package_caller",
  });
  assert.equal(blockedProbe.operation_success, false);
  assert.match(blockedProbe.result.error.message, /finalization contexts/);
});

test("gateway tools return structured errors without mutating policies", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const missingRegister = await sub.gateway_register({ agent_id: "", allowed_tools_json: '["read_file"]' });
  const missingUnregister = await sub.gateway_unregister({ agent_id: "" });
  const malformed = await sub.gateway_register({ agent_id: "agent_bad_json", allowed_tools_json: "not-json" });
  const wrongShape = await sub.gateway_register({ agent_id: "agent_bad_array", denied_tools_json: '{"tool":"delete_file"}' });
  for (const result of [missingRegister, missingUnregister, malformed, wrongShape]) {
    assert.equal(result.transport_success, true);
    assert.equal(result.operation_success, false);
    assert.equal(result.result.success, false);
    assert.equal(typeof result.result.error.code, "string");
    assert.equal(typeof result.result.error.message, "string");
  }
  assert.match(missingRegister.result.error.message, /agent_id is required/);
  assert.match(malformed.result.error.message, /valid JSON/);
  assert.match(wrongShape.result.error.message, /JSON string array/);
  assert.ok(!main.fileGatewayStatus().registered_agents.agent_bad_json);
  assert.ok(!main.fileGatewayStatus().registered_agents.agent_bad_array);
});

test("gateway hides plugin tools and enforces allowlist fail-closed", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const agentId = "agent_gateway_precedence";
  const registered = await sub.gateway_register({
    agent_id: agentId,
    allowed_tools_json: JSON.stringify(["read_file", "gateway_unregister"]),
    denied_tools_json: JSON.stringify(["read_file", "delete_file"]),
  });
  assert.equal(registered.success, true);
  const result = main.onToolPromptCompose({
    eventPayload: {
      chatId: "collaboration_agent:" + agentId,
      availableTools: ["read_file", "delete_file", "list_files", "gateway_unregister", "collaboration:spawn_agent", "tool_lifecycle_probe:gateway_status"],
    },
  });
  assert.deepEqual(result.availableTools, ["read_file"]);
  const failClosed = main.onToolPromptCompose({
    eventPayload: { chatId: "collaboration_agent:" + agentId },
  });
  assert.deepEqual(failClosed, { availableTools: [] });
  const log = main.probeGetPromptComposeLog({});
  assert.equal(log.entries.at(-1).gateway_action, "allowlist_unenforceable_by_chatid");
  await sub.gateway_unregister({ agent_id: agentId });
});

test("agent and summary contexts cannot mutate gateway policies", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const agentId = "agent_gateway_write_guard";
  const normal = await sub.gateway_register({ agent_id: agentId, denied_tools_json: JSON.stringify(["delete_file"]) });
  assert.equal(normal.success, true);
  const blockedRegister = await sub.gateway_register({
    agent_id: agentId,
    allowed_tools_json: JSON.stringify(["read_file"]),
    __operit_package_chat_id: "collaboration_agent:caller",
  });
  const blockedUnregister = await sub.gateway_unregister({
    agent_id: agentId,
    __operit_package_chat_id: "collaboration_summary:caller",
  });
  assert.match(blockedRegister.result.error.message, /cannot be called/);
  assert.match(blockedUnregister.result.error.message, /cannot be called/);
  assert.ok(main.fileGatewayStatus().registered_agents[agentId]);
  await sub.gateway_unregister({ agent_id: agentId });
});

test("subpackage forwards gateway queries via ToolPkg.ipc", async () => {
  const sub = require("../dist/packages/tool_lifecycle_probe.js");
  const agentId = "agent_test_gateway_ipc";
  await sub.gateway_register({ agent_id: agentId, allowed_tools_json: JSON.stringify(["read_file"]) });
  const status = await sub.gateway_status({});
  assert.equal(typeof status, "object");
  assert.ok(status.registered_agents[agentId], "agent must be registered via IPC");
  assert.deepEqual(status.registered_agents[agentId].allowed_tools, ["read_file"]);
  await sub.gateway_unregister({ agent_id: agentId });
  const after = await sub.gateway_status({});
  assert.ok(!after.registered_agents[agentId], "agent must be unregistered via IPC");
});