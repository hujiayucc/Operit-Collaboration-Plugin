"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

const handlers = new Map();
const registeredHooks = {};
const registeredUiModules = [];

class PromptTurn {
  constructor(kind, content, toolName, metadata) {
    this.kind = kind;
    this.content = content;
    this.toolName = toolName;
    this.metadata = metadata;
  }
}

class SendMessageOptions {}

function createService(key) {
  return {
    key,
    cancelled: false,
    async callSuspend(method, ...args) {
      if (method === "getModelConfigForFunction") {
        return { contextLength: 8192, summaryTokenThreshold: 0.8 };
      }
      if (method !== "sendMessage") throw new Error(`unexpected method: ${method}`);
      const options = args[0];
      const isSummary = String(options.chatId || "").startsWith("collaboration_summary:");
      if (!isSummary) options.callbacks?.onToolInvocation("read_file");
      return {
        async callSuspend(streamMethod, collector) {
          assert.equal(streamMethod, "collect");
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (isSummary) {
            collector.emit(`summary:${key}`);
            return;
          }
          let response = "completed read-only task";
          const epochMatch = String(options.customSystemPromptTemplate || "").match(
            /COLLABORATION_CONTROL:\s*\{[^\r\n]*\"execution_epoch\":\"([^\"]+)\"/
          );
          if (epochMatch) {
            response += `\nCOLLABORATION_CONTROL: ${JSON.stringify({
              version: 1,
              execution_epoch: epochMatch[1],
              action: "finish",
              message_acks: [],
              error: "",
            })}`;
          }
          collector.emit(response);
        },
      };
    },
    cancelConversation() {
      this.cancelled = true;
    },
  };
}

global.Java = {
  com: {
    ai: {
      assistance: {
        operit: {
          api: { chat: { EnhancedAIService: { getChatInstance: () => createService("svc"), releaseChatInstance: () => {} } } },
          data: { model: { FunctionType: { CHAT: "CHAT", SUMMARY: "SUMMARY" } } },
          core: { config: { SystemPromptConfig: { SUBTASK_AGENT_PROMPT_TEMPLATE: "base" } } },
        },
      },
    },
  },
  kotlin: { Unit: { INSTANCE: {} } },
  type(name) {
    if (name.endsWith("PromptTurn")) return PromptTurn;
    if (name.endsWith("PromptTurnKind")) return { USER: "USER", ASSISTANT: "ASSISTANT" };
    if (name.endsWith("SendMessageOptions")) return SendMessageOptions;
    throw new Error(`unexpected Java type: ${name}`);
  },
  getApplicationContext() {
    return {};
  },
};

global.ToolPkg = {
  ipc: {
    on(channel, handler) { handlers.set(channel, handler); },
    call(channel, payload) {
      const h = handlers.get(channel);
      if (!h) throw new Error("channel not registered: " + channel);
      return h(payload);
    },
  },
  registerPromptHistoryHook(definition) {
    registeredHooks.promptHistory = definition.function;
  },
  registerToolPromptComposeHook(definition) {
    registeredHooks.toolPrompt = definition.function;
  },
  registerAppLifecycleHook() {},
  registerToolLifecycleHook(definition) {
    registeredHooks.toolLifecycle = definition.function;
  },
  registerToolboxUiModule(definition) {
    registeredUiModules.push(definition);
  },
};

const plugin = require("../dist/main.js");
// main registers collaboration (6 public + 7 UI-only), probe (4), and gateway (3) IPC handlers.
assert.equal(handlers.size, 20, "main must register collaboration, UI, settings, probe and gateway IPC handlers at module load");
assert.equal(typeof plugin.onPromptHistory, "function", "prompt history hook must be exported");
assert.equal(typeof plugin.onToolPromptCompose, "function", "tool prompt hook must be exported");
plugin.registerToolPkg();
assert.equal(registeredHooks.promptHistory, plugin.onPromptHistory);
assert.equal(registeredHooks.toolPrompt, plugin.onToolPromptCompose);
assert.equal(typeof handlers.get("collaboration.get_settings"), "function");
assert.equal(typeof handlers.get("collaboration.update_settings"), "function");
assert.equal(typeof handlers.get("collaboration.delete_agent"), "function");
assert.equal(typeof handlers.get("collaboration.clear_history"), "function");
assert.equal(registeredUiModules.length, 1);
assert.equal(registeredUiModules[0].id, "collaboration_dashboard_v102");
assert.equal(registeredUiModules[0].runtime, "compose_dsl");
assert.equal(typeof registeredUiModules[0].screen, "function");

test("compiled main passes the raw UI module require result to the resolver", () => {
  const source = fs.readFileSync(path.join(root, "dist/main.js"), "utf8");
  assert.match(
    source,
    /(?:const\s+|[;,]\s*)dashboardModule\s*=\s*require\("\.\/ui\/collaboration_dashboard\/index\.ui\.js"\)/,
  );
  assert.match(source, /resolveDashboardScreen\(dashboardModule\)/);
  assert.doesNotMatch(source, /resolveDashboardScreen\([^)]*\.default\)/);
});


test("registration-mode UI placeholders keep their serializable module path", () => {
  function placeholderScreen() {}
  placeholderScreen.__operit_toolpkg_module_path =
    "src/ui/collaboration_dashboard/index.ui.js";

  assert.equal(plugin.resolveDashboardScreen(placeholderScreen), placeholderScreen);
  assert.equal(
    plugin.resolveDashboardScreen(placeholderScreen).__operit_toolpkg_module_path,
    "src/ui/collaboration_dashboard/index.ui.js"
  );
});

test("normal CommonJS UI exports resolve through default", () => {
  function exportedScreen() {}
  assert.equal(
    plugin.resolveDashboardScreen({ default: exportedScreen, Screen: exportedScreen }),
    exportedScreen
  );
});

test("prompt history hook caches only user and assistant conversation turns", () => {
  const event = {
    eventPayload: {
      chatId: "parent_chat_context",
      rawInput: "current user request",
      chatHistory: [
        { kind: "SYSTEM", content: "private system" },
        { kind: "USER", content: "earlier request" },
        { kind: "TOOL_RESULT", content: "private tool output" },
        { kind: "ASSISTANT", content: "earlier answer" },
      ],
      availableTools: ["read_file"],
    },
  };
  assert.equal(plugin.onPromptHistory(event), null);
  assert.deepEqual(plugin.getConversationHistory("parent_chat_context"), [
    { kind: "USER", content: "earlier request" },
    { kind: "ASSISTANT", content: "earlier answer" },
    { kind: "USER", content: "current user request" },
  ]);
});

test("prompt history hook normalizes chat history before deduplicating the current input", () => {
  const event = {
    eventPayload: {
      chatId: "parent_chat_context_with_trailing_tool",
      rawInput: "current user request",
      chatHistory: [
        { kind: "USER", content: "current user request" },
        { kind: "TOOL_CALL", content: "private tool call" },
      ],
      preparedHistory: [],
      availableTools: ["read_file"],
    },
  };
  assert.equal(plugin.onPromptHistory(event), null);
  assert.deepEqual(plugin.getConversationHistory("parent_chat_context_with_trailing_tool"), [
    { kind: "USER", content: "current user request" },
  ]);
});

test("prompt history hook upgrades the same chat snapshot across before and after prepare stages", () => {
  const chatId = "parent_staged_context";
  assert.equal(plugin.onPromptHistory({
    eventPayload: {
      stage: "before_prepare_history",
      chatId,
      processedInput: "current staged request",
      chatHistory: [
        { kind: "USER", content: "earlier staged request" },
        { kind: "ASSISTANT", content: "earlier staged answer" },
      ],
      preparedHistory: [],
    },
  }), null);
  assert.deepEqual(plugin.getConversationHistory(chatId), [
    { kind: "USER", content: "earlier staged request" },
    { kind: "ASSISTANT", content: "earlier staged answer" },
    { kind: "USER", content: "current staged request" },
  ]);

  assert.equal(plugin.onPromptHistory({
    eventPayload: {
      stage: "after_prepare_history",
      chatId,
      processedInput: "current staged request",
      chatHistory: [
        { kind: "USER", content: "earlier staged request" },
        { kind: "ASSISTANT", content: "earlier staged answer" },
      ],
      preparedHistory: [
        { kind: "SYSTEM", content: "private staged system" },
        { kind: "USER", content: "earlier staged request" },
        { kind: "ASSISTANT", content: "earlier staged answer" },
        { kind: "USER", content: "current staged request" },
      ],
    },
  }), null);
  assert.deepEqual(plugin.getConversationHistory(chatId), [
    { kind: "USER", content: "earlier staged request" },
    { kind: "ASSISTANT", content: "earlier staged answer" },
    { kind: "USER", content: "current staged request" },
  ]);
});

test("prompt history hook uses prepared history when chat history is empty", () => {
  const event = {
    eventPayload: {
      chatId: "parent_prepared_context",
      rawInput: "current prepared request",
      chatHistory: [],
      preparedHistory: [
        { kind: "SYSTEM", content: "private system" },
        { kind: "USER", content: "prepared request" },
        { kind: "TOOL_CALL", content: "private tool call" },
        { kind: "ASSISTANT", content: "prepared answer" },
        { kind: "TOOL_RESULT", content: "private tool output" },
        { kind: "USER", content: "current prepared request" },
      ],
      availableTools: ["read_file"],
    },
  };
  assert.equal(plugin.onPromptHistory(event), null);
  assert.deepEqual(plugin.getConversationHistory("parent_prepared_context"), [
    { kind: "USER", content: "prepared request" },
    { kind: "ASSISTANT", content: "prepared answer" },
    { kind: "USER", content: "current prepared request" },
  ]);
});

test("prompt history hook prefers prepared history instead of duplicating both history sources", () => {
  const event = {
    eventPayload: {
      chatId: "parent_dual_context",
      processedInput: "latest request",
      chatHistory: [
        { kind: "USER", content: "raw request" },
        { kind: "ASSISTANT", content: "raw answer" },
      ],
      preparedHistory: [
        { kind: "USER", content: "prepared request" },
        { kind: "ASSISTANT", content: "prepared answer" },
      ],
      availableTools: ["read_file"],
    },
  };
  assert.equal(plugin.onPromptHistory(event), null);
  assert.deepEqual(plugin.getConversationHistory("parent_dual_context"), [
    { kind: "USER", content: "prepared request" },
    { kind: "ASSISTANT", content: "prepared answer" },
    { kind: "USER", content: "latest request" },
  ]);
});

test("spawn_agent and wait_agent complete a read-only task", async () => {
  const started = await handlers.get("collaboration.spawn_agent")({
    task: "Read a file",
    read_only: true,
    max_tool_calls: 3,
  });
  assert.equal(started.success, true);
  assert.ok(started.agent.id, "must return an agent id");

  const completed = await handlers.get("collaboration.wait_agent")({
    agent_ids: [started.agent.id],
    timeout_ms: 3000,
  });
  assert.equal(completed.success, true);
  assert.equal(completed.agents[0].status, "completed");
  assert.ok(completed.agents[0].execution.tool_count >= 1, "agent must have used at least one tool");
  const probeStatus = plugin.probeGetStatus({});
  assert.ok(probeStatus.runtime_attributed_events >= 1);
  assert.ok(probeStatus.agent_attributed_events >= 1);
  const invocation = plugin.probeGetLog({ tool_name: "read_file" }).entries.find(
    (entry) => entry.attributed_agent_id === started.agent.id && entry.attribution_source === "runtime_callback"
  );
  assert.ok(invocation, "manager tool callback must attribute the invocation to the active Agent");
  assert.equal(invocation.execution_epoch, completed.agents[0].execution.epoch);
});

test("interrupt_agent on a terminal agent returns already_terminal", async () => {
  const started = await handlers.get("collaboration.spawn_agent")({
    task: "Quick read",
    read_only: true,
    max_tool_calls: 2,
  });
  await handlers.get("collaboration.wait_agent")({
    agent_ids: [started.agent.id],
    timeout_ms: 3000,
  });
  const interrupted = await handlers.get("collaboration.interrupt_agent")({
    agent_id: started.agent.id,
  });
  assert.equal(interrupted.success, true);
  assert.equal(interrupted.interrupt, "already_terminal");
});