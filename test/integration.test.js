"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const handlers = new Map();
const registeredHooks = {};

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
  registerToolPromptComposeHook(definition) {
    registeredHooks.toolPrompt = definition.function;
  },
  registerAppLifecycleHook() {},
  registerToolLifecycleHook(definition) {
    registeredHooks.toolLifecycle = definition.function;
  },
};

const plugin = require("../src/main.js");
// main registers collaboration (6), probe (4), and gateway (3) IPC handlers.
assert.equal(handlers.size, 13, "main must register collaboration, probe and gateway IPC handlers at module load");
assert.equal(typeof plugin.onToolPromptCompose, "function", "registered hook must be exported");
plugin.registerToolPkg();
assert.equal(registeredHooks.toolPrompt, plugin.onToolPromptCompose);

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