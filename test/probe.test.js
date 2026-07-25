"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

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
  registerToolPromptComposeHook() {},
  registerAppLifecycleHook() {},
  ipc: {
    on(channel, handler) { ipcHandlers[channel] = handler; },
    call(channel, payload) {
      const h = ipcHandlers[channel];
      if (!h) throw new Error("channel not registered: " + channel);
      return h(payload);
    },
  },
};

const main = require("../src/main.js");

function status() {
  return JSON.parse(main.probeGetStatus({}));
}
function getLog(params) {
  return JSON.parse(main.probeGetLog(params || {}));
}

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

test("clear_log empties the buffer but preserves aggregate counts", () => {
  main.probeClearLog({});
  main.onToolLifecycle({ eventPayload: { toolName: "read_file" } });
  const before = status().total_events;
  const cleared = JSON.parse(main.probeClearLog({}));
  assert.ok(cleared.cleared >= 1);
  assert.equal(getLog({}).returned, 0);
  assert.equal(status().total_events, before, "cumulative counters must survive a buffer clear");
});

test("records payload key names without capturing file contents", () => {
  main.probeClearLog({});
  main.onToolLifecycle({
    eventPayload: { toolName: "read_file", proxySenderName: "CollaborationAgent:a3", content: "SECRET" },
  });
  const log = getLog({});
  const entry = log.entries[log.entries.length - 1];
  assert.ok(entry.payload_keys.includes("content"), "payload key names are recorded");
  assert.equal(JSON.stringify(entry).includes("SECRET"), false, "raw payload values must never be stored");
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
  const sub = require("../src/packages/tool_lifecycle_probe.js");
  const subStatus = JSON.parse(await sub.probe_get_status({}));
  const mainStatus = JSON.parse(main.probeGetStatus({}));
  assert.equal(subStatus.registered, mainStatus.registered);
  assert.equal(subStatus.total_events, mainStatus.total_events);
});

test("file gateway registers and unregisters agent policies", () => {
  const agentId = "agent_test_gateway_001";
  main.registerFileGateway(agentId, { allowed_tools: ["read_file", "list_files"] });
  const status = JSON.parse(main.fileGatewayStatus());
  assert.ok(status.registered_agents[agentId], "agent must be registered");
  assert.deepEqual(status.registered_agents[agentId].allowed_tools, ["list_files", "read_file"]);
  main.unregisterFileGateway(agentId);
  const after = JSON.parse(main.fileGatewayStatus());
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
  const log = JSON.parse(main.probeGetPromptComposeLog({}));
  const last = log.entries[log.entries.length - 1];
  assert.equal(last.gateway_action, "filter_by_chatid");
  assert.equal(last.gateway_returned_tools, 2);
  main.unregisterFileGateway(agentId);
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

test("onToolPromptCompose strips all tools for summary chats", () => {
  const event = {
    eventPayload: {
      chatId: "collaboration_summary:test",
      proxySenderName: "",
    },
  };
  const result = main.onToolPromptCompose(event);
  assert.deepEqual(result, { availableTools: [] });
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
  const log = JSON.parse(main.probeGetPromptComposeLog({}));
  assert.ok(log.entries.length > 0, "prompt compose log must have entries");
  const last = log.entries[log.entries.length - 1];
  assert.equal(last.chat_id, "collaboration_agent:agent_pc_test");
  assert.equal(last.has_available_tools, true);
  assert.deepEqual(last.available_tool_names, ["read_file"]);
});

test("subpackage forwards gateway queries via ToolPkg.ipc", async () => {
  const sub = require("../src/packages/tool_lifecycle_probe.js");
  const agentId = "agent_test_gateway_ipc";
  await sub.gateway_register({ agent_id: agentId, allowed_tools_json: JSON.stringify(["read_file"]) });
  const status = JSON.parse(await sub.gateway_status({}));
  assert.ok(status.registered_agents[agentId], "agent must be registered via IPC");
  assert.deepEqual(status.registered_agents[agentId].allowed_tools, ["read_file"]);
  await sub.gateway_unregister({ agent_id: agentId });
  const after = JSON.parse(await sub.gateway_status({}));
  assert.ok(!after.registered_agents[agentId], "agent must be unregistered via IPC");
});