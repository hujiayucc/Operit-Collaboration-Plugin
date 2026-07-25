"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const handlers = new Map();
const services = new Map();
const sentOptions = [];
const registeredHooks = {};
let nonSummaryCall = 0;
let nextRawResponse = "";
const queuedRawResponses = [];
let nextSummaryResponse = "";
let nextSummaryError = "";
let acknowledgeMessages = true;
let activeSummaries = 0;
let maxActiveSummaries = 0;
let holdNonSummary = false;
const heldNonSummary = [];
const nonSummaryStarts = [];

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
      sentOptions.push(options);
      const summary = String(options.chatId || "").startsWith("collaboration_summary:");
      if (!summary) {
        nonSummaryCall += 1;
        nonSummaryStarts.push(String(options.message || ""));
        options.callbacks?.onToolInvocation("read_file");
      } else {
        activeSummaries += 1;
        maxActiveSummaries = Math.max(maxActiveSummaries, activeSummaries);
      }
      const callNumber = nonSummaryCall;
      return {
        async callSuspend(streamMethod, collector) {
          assert.equal(streamMethod, "collect");
          if (!summary && holdNonSummary) {
            await new Promise((resolve) => heldNonSummary.push(resolve));
          }
          await new Promise((resolve) => setTimeout(resolve, summary ? 10 : 25));
          if (summary) {
            activeSummaries -= 1;
            if (nextSummaryError) {
              const message = nextSummaryError;
              nextSummaryError = "";
              throw new Error(message);
            }
            if (nextSummaryResponse) {
              collector.emit(nextSummaryResponse);
              nextSummaryResponse = "";
            } else collector.emit(`summary:${key}`);
          } else if (queuedRawResponses.length > 0) {
            const responseFactory = queuedRawResponses.shift();
            collector.emit(typeof responseFactory === "function" ? responseFactory(options, key) : responseFactory);
          } else if (nextRawResponse) {
            collector.emit(nextRawResponse);
            nextRawResponse = "";
          } else {
            let response = `completed run response ${callNumber}`;
            const epochMatch = String(options.customSystemPromptTemplate || "").match(
              /COLLABORATION_CONTROL:\s*\{[^\r\n]*\"execution_epoch\":\"([^\"]+)\"/
            );
            const ackMatch = String(options.message || "").match(
              /message_acks array:\s*(\[[^\r\n]*\])/
            );
            const messageAcks = acknowledgeMessages && ackMatch ? JSON.parse(ackMatch[1]) : [];
            if (epochMatch) {
              response += `\nCOLLABORATION_CONTROL: ${JSON.stringify({
                version: 1,
                execution_epoch: epochMatch[1],
                action: "finish",
                message_acks: messageAcks,
                error: "",
              })}`;
            }
            collector.emit(response);
          }
        },
      };
    },
  };
}

const EnhancedAIService = {
  getChatInstance(_context, key) {
    if (!services.has(key)) services.set(key, createService(key));
    return services.get(key);
  },
  releaseChatInstance(key) {
    const service = services.get(key);
    if (service) service.cancelled = true;
  },
};

global.Java = {
  com: {
    ai: {
      assistance: {
        operit: {
          api: { chat: { EnhancedAIService } },
          data: { model: { FunctionType: { CHAT: "CHAT" } } },
          core: { config: { SystemPromptConfig: { SUBTASK_AGENT_PROMPT_TEMPLATE: "BASE" } } },
        },
      },
    },
  },
  kotlin: { Unit: { INSTANCE: undefined } },
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

global.ToolPkg = {
  ipc: {
    on(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
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
plugin.registerToolPkg();

async function call(channel, payload) {
  const handler = handlers.get(channel);
  assert.ok(handler, `missing IPC handler: ${channel}`);
  return handler(payload);
}

async function waitTerminal(agentId) {
  return call("collaboration.wait_agent", { agent_ids: [agentId], timeout_ms: 1000 });
}

function controlFromOptions(options, action, overrides = {}) {
  const epochMatch = String(options.customSystemPromptTemplate || "").match(
    /COLLABORATION_CONTROL:\s*\{[^\r\n]*\"execution_epoch\":\"([^\"]+)\"/
  );
  assert.ok(epochMatch, "execution epoch must be present in the control prompt");
  return `COLLABORATION_CONTROL: ${JSON.stringify({
    version: 1,
    execution_epoch: epochMatch[1],
    action,
    message_acks: [],
    error: "",
    ...overrides,
  })}`;
}

test("registers six collaboration IPC handlers and disables tools for summaries", () => {
  const channels = [
    "collaboration.spawn_agent",
    "collaboration.list_agents",
    "collaboration.send_message",
    "collaboration.followup_task",
    "collaboration.wait_agent",
    "collaboration.interrupt_agent",
  ];
  channels.forEach((channel) => assert.equal(typeof handlers.get(channel), "function"));
  assert.deepEqual(
    Array.from(handlers.keys()).filter((channel) => channel.startsWith("collaboration.")).sort(),
    channels.slice().sort()
  );
  assert.deepEqual(
    registeredHooks.toolPrompt({ eventPayload: { chatId: "collaboration_summary:agent:1" } }),
    { availableTools: [] }
  );
});

test("agent system prompt forbids controlling the Operit host lifecycle", async () => {
  const started = await call("collaboration.spawn_agent", { task: "host lifecycle guard", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  const options = sentOptions.find((entry) => String(entry.message).includes("host lifecycle guard"));
  assert.ok(options, "agent model invocation must be recorded");
  const prompt = String(options.customSystemPromptTemplate || "");
  assert.match(prompt, /Never stop, restart, force-stop, kill, clear data for, or otherwise control the Operit host/i);
  assert.match(prompt, /explicit user action outside this ToolPkg session/i);
});

test("spawns a stable logical agent and completes a follow-up run", async () => {
  const started = await call("collaboration.spawn_agent", {
    task: "inspect the project",
    target_paths: ["/repo/src"],
    workspace_path: "/repo",
  });
  assert.equal(started.success, true);
  assert.equal(started.persistence, "memory");
  assert.equal(started.persistence_model, "event_store");
  assert.equal(started.persistence_schema, 3);
  assert.ok(started.persistence_revision >= 1);
  assert.match(started.persistence_error, /SQLite unavailable/);
  assert.equal(started.path_isolation, "declarative");
  const agentId = started.agent.id;
  const first = await waitTerminal(agentId);
  assert.equal(first.agents[0].status, "completed");
  assert.equal(first.agents[0].run_seq, 1);

  const followed = await call("collaboration.followup_task", {
    agent_id: agentId,
    task: "verify the prior result",
  });
  assert.equal(followed.agent.id, agentId);
  assert.equal(followed.agent.run_seq, 2);
  assert.equal(followed.agent.workspace_path, "/repo");
  const second = await waitTerminal(agentId);
  assert.equal(second.agents[0].status, "completed");
  assert.equal(second.agents[0].run_seq, 2);
  const followupOptions = sentOptions.find((options) => String(options.message).includes("run 2:"));
  assert.ok(followupOptions.message.includes("Previous runs of this logical agent"));
});

test("deduplicates retried spawn requests by request_id", async () => {
  holdNonSummary = true;
  const payload = {
    task: "idempotent spawn",
    context: "same parameters",
    name: "idempotent-agent",
    request_id: "request-0.4.3-1",
    read_only: true,
  };
  const first = await call("collaboration.spawn_agent", payload);
  const second = await call("collaboration.spawn_agent", payload);
  assert.equal(second.delivery, "deduplicated");
  assert.equal(second.deduplicated, true);
  assert.equal(second.agent.id, first.agent.id);
  const listed = await call("collaboration.list_agents", {
    agent_ids: [first.agent.id],
    include_results: false,
  });
  assert.equal(listed.agents.length, 1);
  await assert.rejects(
    () => handlers.get("collaboration.spawn_agent")({
      ...payload,
      task: "different parameters",
    }),
    /request_id conflict/
  );
  holdNonSummary = false;
  while (heldNonSummary.length > 0) heldNonSummary.shift()();
  await waitTerminal(first.agent.id);
});

test("paginates list_agents without gaps and bypasses pagination for explicit ids", async () => {
  holdNonSummary = true;
  const created = [];
  try {
    for (let index = 0; index < 7; index += 1) {
      created.push(await call("collaboration.spawn_agent", {
        task: `pagination agent ${index}`,
        read_only: true,
      }));
    }
    const allIds = [];
    let cursor = "";
    let total = 0;
    do {
      const page = await call("collaboration.list_agents", { limit: 5, cursor });
      total = page.total;
      assert.ok(page.agents.length <= 5);
      allIds.push(...page.agents.map((agent) => agent.id));
      cursor = page.next_cursor || "";
      if (!page.has_more) break;
      assert.ok(cursor);
    } while (true);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.equal(allIds.length, total);

    const selectedIds = created.map((entry) => entry.agent.id);
    const selected = await call("collaboration.list_agents", {
      agent_ids: selectedIds,
      limit: 1,
    });
    assert.equal(selected.has_more, false);
    assert.equal(selected.total, selectedIds.length);
    assert.equal(selected.agents.length, selectedIds.length);
    await assert.rejects(
      () => handlers.get("collaboration.list_agents")({ limit: 2, cursor: "invalid" }),
      /cursor is invalid/
    );
  } finally {
    holdNonSummary = false;
    while (heldNonSummary.length > 0) heldNonSummary.shift()();
    await call("collaboration.wait_agent", {
      agent_ids: created.map((entry) => entry.agent.id),
      timeout_ms: 1000,
    });
  }
});

test("deduplicates send, follow-up, and interrupt write requests", async () => {
  holdNonSummary = true;
  const started = await call("collaboration.spawn_agent", {
    task: "all write idempotency",
    read_only: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const messagePayload = {
    agent_id: started.agent.id,
    message: "deliver exactly once",
    request_id: "send-idempotency-1",
  };
  const firstMessage = await call("collaboration.send_message", messagePayload);
  const retriedMessage = await call("collaboration.send_message", messagePayload);
  assert.equal(retriedMessage.deduplicated, true);
  assert.equal(retriedMessage.message_id, firstMessage.message_id);
  const listedAfterRetry = await call("collaboration.list_agents", {
    agent_ids: [started.agent.id],
  });
  assert.equal(listedAfterRetry.agents[0].pending_messages, 1);
  await assert.rejects(
    () => handlers.get("collaboration.send_message")({ ...messagePayload, message: "different" }),
    /request_id conflict/
  );

  const interruptPayload = {
    agent_id: started.agent.id,
    request_id: "interrupt-idempotency-1",
  };
  const firstInterrupt = await call("collaboration.interrupt_agent", interruptPayload);
  const retriedInterrupt = await call("collaboration.interrupt_agent", interruptPayload);
  assert.equal(retriedInterrupt.deduplicated, true);
  assert.equal(retriedInterrupt.interrupt, firstInterrupt.interrupt);
  assert.equal(retriedInterrupt.agent.execution.epoch, firstInterrupt.agent.execution.epoch);

  holdNonSummary = false;
  while (heldNonSummary.length > 0) heldNonSummary.shift()();
  await waitTerminal(started.agent.id);
  const followupPayload = {
    agent_id: started.agent.id,
    task: "create exactly one follow-up",
    request_id: "followup-idempotency-1",
    read_only: true,
  };
  const firstFollowup = await call("collaboration.followup_task", followupPayload);
  const retriedFollowup = await call("collaboration.followup_task", followupPayload);
  assert.equal(retriedFollowup.deduplicated, true);
  assert.equal(retriedFollowup.agent.execution.execution_id, firstFollowup.agent.execution.execution_id);
  const afterFollowupRetry = await call("collaboration.list_agents", {
    agent_ids: [started.agent.id],
  });
  assert.equal(afterFollowupRetry.agents[0].run_seq, 2);
  await assert.rejects(
    () => handlers.get("collaboration.followup_task")({ ...followupPayload, task: "different" }),
    /request_id conflict/
  );
  await waitTerminal(started.agent.id);
});

test("summarizes a prompt-echo result instead of exposing internal instructions", async () => {
  nextRawResponse = [
    "COLLABORATION_AGENT_CONSTRAINTS:",
    "- Execute the delegated task.",
    "思考过程指南：",
    "- 在提供最终答案之前，你必须使用",
  ].join("\n");
  const started = await call("collaboration.spawn_agent", { task: "echo regression", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  assert.ok(result.agents[0].result.startsWith("summary:collaboration_summary_service:"));
  assert.equal(result.agents[0].result.includes("COLLABORATION_AGENT_CONSTRAINTS"), false);
});

test("suppresses output when both execution and summary reproduce internal instructions", async () => {
  nextRawResponse = "COLLABORATION_AGENT_CONSTRAINTS:\n思考过程指南：";
  nextSummaryResponse = "COLLABORATION_AGENT_CONSTRAINTS:\n在提供最终答案之前，你必须使用";
  const started = await call("collaboration.spawn_agent", { task: "double echo regression", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.result_suppressed, true);
  assert.match(result.agents[0].execution.summary_error, /prompt echo/);
  assert.match(result.agents[0].result, /suppressed/);
  assert.equal(result.agents[0].result.includes("COLLABORATION_AGENT_CONSTRAINTS"), false);
  assert.equal(result.agents[0].result.includes("思考过程指南"), false);
});

test("retries an unacknowledged parent message once and reports a warning", async () => {
  acknowledgeMessages = false;
  const started = await call("collaboration.spawn_agent", { task: "unacknowledged message", read_only: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call("collaboration.send_message", { agent_id: started.agent.id, message: "must be acknowledged" });
  const result = await waitTerminal(started.agent.id);
  acknowledgeMessages = true;
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.checkpoint_turns, 3);
  assert.equal(result.agents[0].delivered_messages, 1);
  assert.equal(result.agents[0].acknowledged_messages, 0);
  assert.equal(result.agents[0].unacknowledged_messages, 1);
  assert.match(result.agents[0].execution.message_delivery_warning, /presented twice/);
});

test("uses a safe deterministic fallback when collaboration summary fails", async () => {
  nextRawResponse = "<tool_ab name=\"read_file\"></tool_ab>";
  nextSummaryError = "summary provider unavailable";
  const started = await call("collaboration.spawn_agent", { task: "summary failure fallback", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.summary_status, "failed");
  assert.equal(result.agents[0].execution.summary_fallback_used, true);
  assert.match(result.agents[0].execution.summary_error, /provider unavailable/);
  assert.match(result.agents[0].result, /host call completed/i);
  assert.equal(result.agents[0].result.includes("COLLABORATION_AGENT_CONSTRAINTS"), false);
});

test("limits collaboration summary concurrency to two", async () => {
  maxActiveSummaries = 0;
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    nextRawResponse = "COLLABORATION_AGENT_CONSTRAINTS:\n思考过程指南：";
    const started = await call("collaboration.spawn_agent", { task: `summary concurrency ${index}`, read_only: true });
    ids.push(started.agent.id);
  }
  const result = await call("collaboration.wait_agent", { agent_ids: ids, timeout_ms: 1000 });
  assert.equal(result.agents.every((agent) => agent.status === "completed"), true);
  assert.ok(maxActiveSummaries <= 2, `summary concurrency was ${maxActiveSummaries}`);
});
test("schedules queued high priority work before low priority work", async () => {
  holdNonSummary = true;
  const startIndex = nonSummaryStarts.length;
  const blockers = [];
  for (let index = 0; index < 6; index += 1) {
    const started = await call("collaboration.spawn_agent", {
      task: `priority blocker ${index}`,
      read_only: true,
      priority: "normal",
    });
    blockers.push(started.agent.id);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const low = await call("collaboration.spawn_agent", { task: "priority low target", read_only: true, priority: "low" });
  const high = await call("collaboration.spawn_agent", { task: "priority high target", read_only: true, priority: "high" });
  assert.equal(low.agent.status, "queued");
  assert.equal(high.agent.status, "queued");
  const releaseFirst = heldNonSummary.shift();
  assert.equal(typeof releaseFirst, "function");
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const starts = nonSummaryStarts.slice(startIndex);
  const highIndex = starts.findIndex((message) => message.includes("priority high target"));
  const lowIndex = starts.findIndex((message) => message.includes("priority low target"));
  assert.ok(highIndex >= 0, "high priority agent should have started");
  assert.equal(lowIndex, -1, "low priority agent should remain queued while high starts");
  holdNonSummary = false;
  while (heldNonSummary.length > 0) heldNonSummary.shift()();
  const allIds = [...blockers, low.agent.id, high.agent.id];
  const completed = await call("collaboration.wait_agent", { agent_ids: allIds, timeout_ms: 1000 });
  assert.equal(completed.agents.every((agent) => agent.status === "completed"), true);
});

test("queues a running message and injects it at the next checkpoint", async () => {
  const started = await call("collaboration.spawn_agent", { task: "initial task", read_only: true });
  const agentId = started.agent.id;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const delivered = await call("collaboration.send_message", {
    agent_id: agentId,
    message: "also check the tests",
  });
  assert.equal(delivered.delivery, "queued_for_next_checkpoint");
  const result = await waitTerminal(agentId);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.checkpoint_turns, 2);
  assert.equal(result.agents[0].pending_messages, 0);
  assert.equal(result.agents[0].delivered_messages, 1);
  assert.equal(result.agents[0].acknowledged_messages, 1);
  assert.equal(result.agents[0].unacknowledged_messages, 0);
  assert.equal(result.agents[0].result.includes("COLLABORATION_MESSAGE_ACKS"), false);
  const injected = sentOptions.find((options) => String(options.message).includes("also check the tests"));
  assert.ok(injected, "queued message must be present in the next model checkpoint");
});

test("structured progress requires another checkpoint and finish completes without exposing control", async () => {
  queuedRawResponses.push(
    (options) => `checkpoint one\n${controlFromOptions(options, "progress")}`,
    (options) => `structured final result\n${controlFromOptions(options, "finish")}`
  );
  const started = await call("collaboration.spawn_agent", { task: "structured progress", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.checkpoint_turns, 2);
  assert.equal(result.agents[0].execution.control_mode, "structured");
  assert.equal(result.agents[0].execution.control_status, "accepted");
  assert.equal(result.agents[0].execution.control_action, "finish");
  assert.equal(result.agents[0].result, "structured final result");
  assert.equal(result.agents[0].result.includes("COLLABORATION_CONTROL"), false);
});

test("structured fail terminates the run with the declared error", async () => {
  queuedRawResponses.push(
    (options) => `unable to continue\n${controlFromOptions(options, "fail", { error: "declared structured failure" })}`
  );
  const started = await call("collaboration.spawn_agent", { task: "structured failure", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "failed");
  assert.equal(result.agents[0].execution.control_mode, "structured");
  assert.equal(result.agents[0].execution.control_action, "fail");
  assert.equal(result.agents[0].error, "declared structured failure");
  assert.equal(result.agents[0].result, undefined);
});

test("wrong-epoch structured finish is isolated as a late result", async () => {
  queuedRawResponses.push(
    () => "stale output\nCOLLABORATION_CONTROL: " + JSON.stringify({
      version: 1,
      execution_epoch: "agent_stale:99:1",
      action: "finish",
      message_acks: [],
      error: "",
    })
  );
  const started = await call("collaboration.spawn_agent", { task: "wrong epoch", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "failed");
  assert.equal(result.agents[0].execution.control_status, "epoch_mismatch");
  assert.equal(result.agents[0].execution.late_result_recorded, true);
  assert.match(result.agents[0].error, /control epoch mismatch/);
  assert.equal(result.agents[0].result, undefined);
});

test("malformed control stays in compatibility mode and is never public", async () => {
  queuedRawResponses.push("compatibility result\nCOLLABORATION_CONTROL: {broken json");
  const started = await call("collaboration.spawn_agent", { task: "invalid control compatibility", read_only: true });
  const result = await waitTerminal(started.agent.id);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.control_mode, "compatibility");
  assert.equal(result.agents[0].execution.control_status, "invalid");
  assert.match(result.agents[0].execution.control_error, /invalid control JSON/);
  assert.equal(result.agents[0].result, "compatibility result");
  assert.equal(result.agents[0].result.includes("COLLABORATION_CONTROL"), false);
});

test("safe summary repairs a missing control envelope without fabricating message ACKs", async () => {
  acknowledgeMessages = false;
  queuedRawResponses.push("legacy model result 1", "legacy model result 2", "legacy model result 3");
  const started = await call("collaboration.spawn_agent", { task: "summary control repair", read_only: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call("collaboration.send_message", { agent_id: started.agent.id, message: "repair must not imply ACK" });
  const result = await waitTerminal(started.agent.id);
  acknowledgeMessages = true;
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].execution.control_mode, "structured");
  assert.equal(result.agents[0].execution.control_status, "repaired");
  assert.equal(result.agents[0].execution.control_action, "finish");
  assert.equal(result.agents[0].execution.control_source, "summary_repair");
  assert.equal(result.agents[0].execution.control_repaired, true);
  assert.equal(result.agents[0].acknowledged_messages, 0);
  assert.equal(result.agents[0].unacknowledged_messages, 1);
  assert.match(result.agents[0].execution.message_delivery_warning, /presented twice/);
  assert.ok(result.agents[0].result.startsWith("summary:collaboration_summary_service:"));
  assert.equal(result.agents[0].result.includes("COLLABORATION_CONTROL"), false);
});

test("binds children to the exact parent run and starts follow-ups as new root trees", async () => {
  holdNonSummary = true;
  const parent = await call("collaboration.spawn_agent", { task: "tree parent binding", read_only: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const child = await call("collaboration.spawn_agent", {
    task: "tree child binding",
    parent_agent_id: parent.agent.id,
    read_only: true,
  });
  const grandchild = await call("collaboration.spawn_agent", {
    task: "tree grandchild binding",
    parent_agent_id: child.agent.id,
    read_only: true,
  });

  assert.equal(child.agent.parent_agent_id, parent.agent.id);
  assert.equal(child.agent.execution.parent_run_id, parent.agent.execution.execution_id);
  assert.equal(child.agent.execution.parent_execution_epoch, parent.agent.execution.epoch);
  assert.equal(child.agent.execution.root_agent_id, parent.agent.id);
  assert.equal(child.agent.execution.root_run_id, parent.agent.execution.execution_id);
  assert.equal(child.agent.execution.tree_depth, 1);
  assert.equal(grandchild.agent.execution.parent_run_id, child.agent.execution.execution_id);
  assert.equal(grandchild.agent.execution.root_run_id, parent.agent.execution.execution_id);
  assert.equal(grandchild.agent.execution.tree_depth, 2);

  const listed = await call("collaboration.list_agents", {
    agent_ids: [parent.agent.id, child.agent.id, grandchild.agent.id],
    include_results: false,
  });
  const parentListed = listed.agents.find((agent) => agent.id === parent.agent.id);
  const childListed = listed.agents.find((agent) => agent.id === child.agent.id);
  assert.equal(parentListed.tree.root_run_id, parent.agent.execution.execution_id);
  assert.equal(parentListed.tree.direct_children, 1);
  assert.equal(parentListed.tree.total_runs, 3);
  assert.equal(parentListed.tree.active_runs, 3);
  assert.equal(childListed.tree.direct_children, 1);

  holdNonSummary = false;
  while (heldNonSummary.length > 0) heldNonSummary.shift()();
  const completed = await call("collaboration.wait_agent", {
    agent_ids: [parent.agent.id, child.agent.id, grandchild.agent.id],
    timeout_ms: 1000,
  });
  assert.equal(completed.agents.every((agent) => agent.status === "completed"), true);

  await assert.rejects(
    () => handlers.get("collaboration.spawn_agent")({
      task: "terminal parent child must fail",
      parent_agent_id: parent.agent.id,
      read_only: true,
    }),
    /parent run .* is terminal/
  );

  const followup = await call("collaboration.followup_task", {
    agent_id: parent.agent.id,
    task: "tree follow-up root",
    read_only: true,
  });
  assert.equal(followup.agent.execution.parent_run_id, undefined);
  assert.equal(followup.agent.execution.parent_execution_epoch, undefined);
  assert.equal(followup.agent.execution.root_agent_id, parent.agent.id);
  assert.equal(followup.agent.execution.root_run_id, followup.agent.execution.execution_id);
  assert.notEqual(followup.agent.execution.root_run_id, parent.agent.execution.root_run_id);
  assert.equal(followup.agent.execution.tree_depth, 0);
  assert.equal(followup.agent.tree.total_runs, 1);
  assert.equal(followup.agent.tree.direct_children, 0);
  await waitTerminal(parent.agent.id);
});

test("propagates cancellation only to descendants of the current run", async () => {
  holdNonSummary = true;
  const parent = await call("collaboration.spawn_agent", { task: "cancel tree parent", read_only: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const child = await call("collaboration.spawn_agent", {
    task: "cancel tree child",
    parent_agent_id: parent.agent.id,
    read_only: true,
  });
  const grandchild = await call("collaboration.spawn_agent", {
    task: "cancel tree grandchild",
    parent_agent_id: child.agent.id,
    read_only: true,
  });
  const unrelated = await call("collaboration.spawn_agent", { task: "cancel unrelated root", read_only: true });
  let duringCancel;
  let completed;
  try {
    const interrupted = await call("collaboration.interrupt_agent", { agent_id: parent.agent.id });
    assert.equal(interrupted.interrupt, "cancelling");
    assert.equal(interrupted.propagated_descendants, 2);

    duringCancel = await call("collaboration.list_agents", {
      agent_ids: [parent.agent.id, child.agent.id, grandchild.agent.id, unrelated.agent.id],
      include_results: false,
    });
  } finally {
    holdNonSummary = false;
    while (heldNonSummary.length > 0) heldNonSummary.shift()();
    completed = await call("collaboration.wait_agent", {
      agent_ids: [parent.agent.id, child.agent.id, grandchild.agent.id, unrelated.agent.id],
      timeout_ms: 1000,
    });
  }

  const statusById = new Map(duringCancel.agents.map((agent) => [agent.id, agent.status]));
  assert.equal(statusById.get(parent.agent.id), "cancelling");
  assert.ok(["cancelling", "interrupted"].includes(statusById.get(child.agent.id)));
  assert.ok(["cancelling", "interrupted"].includes(statusById.get(grandchild.agent.id)));
  assert.ok(["running", "queued"].includes(statusById.get(unrelated.agent.id)));

  const finalById = new Map(completed.agents.map((agent) => [agent.id, agent.status]));
  assert.ok(["interrupted", "interrupted_with_late_result"].includes(finalById.get(parent.agent.id)));
  assert.ok(["interrupted", "interrupted_with_late_result"].includes(finalById.get(child.agent.id)));
  assert.ok(["interrupted", "interrupted_with_late_result"].includes(finalById.get(grandchild.agent.id)));
  assert.equal(finalById.get(unrelated.agent.id), "completed");
});

test("limits one root tree to three active runs while another root can use remaining slots", async () => {
  holdNonSummary = true;
  const startIndex = nonSummaryStarts.length;
  const root = await call("collaboration.spawn_agent", { task: "quota root parent", read_only: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const children = [];
  for (let index = 0; index < 4; index += 1) {
    children.push(await call("collaboration.spawn_agent", {
      task: `quota root child ${index}`,
      parent_agent_id: root.agent.id,
      read_only: true,
    }));
  }
  const otherRoots = [];
  for (let index = 0; index < 3; index += 1) {
    otherRoots.push(await call("collaboration.spawn_agent", {
      task: `quota other root ${index}`,
      read_only: true,
    }));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const starts = nonSummaryStarts.slice(startIndex);
  const rootStarts = starts.filter((message) => message.includes("quota root parent") || message.includes("quota root child"));
  const otherStarts = starts.filter((message) => message.includes("quota other root"));
  assert.equal(rootStarts.length, 3);
  assert.equal(otherStarts.length, 3);
  assert.equal(starts.length, 6);

  holdNonSummary = false;
  while (heldNonSummary.length > 0) heldNonSummary.shift()();
  const allIds = [root.agent.id, ...children.map((entry) => entry.agent.id), ...otherRoots.map((entry) => entry.agent.id)];
  const completed = await call("collaboration.wait_agent", { agent_ids: allIds, timeout_ms: 1000 });
  assert.equal(completed.agents.every((agent) => agent.status === "completed"), true);
});

test("interrupts active work cooperatively and rejects overlapping active write paths", async () => {
  const first = await call("collaboration.spawn_agent", {
    task: "write one",
    target_paths: ["/repo/shared"],
  });
  await assert.rejects(
    () => handlers.get("collaboration.spawn_agent")({
      task: "write two",
      target_paths: ["/repo/shared/file.js"],
    }),
    /write path conflict/
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const interrupted = await call("collaboration.interrupt_agent", { agent_id: first.agent.id });
  assert.equal(interrupted.interrupt, "cancelling");
  const result = await waitTerminal(first.agent.id);
  assert.ok(["interrupted", "interrupted_with_late_result"].includes(result.agents[0].status));
});