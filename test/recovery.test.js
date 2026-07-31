"use strict";

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

class PromptTurn {
  constructor(kind, content, toolName, metadata) {
    this.kind = kind;
    this.content = content;
    this.toolName = toolName;
    this.metadata = metadata;
  }
}

class SendMessageOptions {}

function execution(id, agentId, status) {
  return {
    id,
    agentId,
    seq: 1,
    attempt: 1,
    epoch: `${agentId}:1:1`,
    task: `task for ${agentId}`,
    context: "",
    status,
    physicalStatus: status,
    cancelRequested: false,
    serviceKey: "stale-service-key",
    stepCount: 0,
    toolCount: 0,
    currentTool: "",
    checkpoints: [],
    result: "",
    lateResult: "",
    error: "",
    summaryError: "",
    createdAt: 10,
    startedAt: status === "running" ? 20 : 0,
    completedAt: 0,
    timeoutMs: 30000,
    maxToolCalls: 4,
  };
}

function agent(id, status) {
  const run = execution(`execution_${id}`, id, status);
  return {
    id,
    name: id,
    parentAgentId: "",
    parentChatId: "",
    status,
    runSeq: 1,
    readOnly: true,
    targetPaths: [],
    workspacePath: "",
    workspaceEnv: "android",
    timeoutMs: 30000,
    maxToolCalls: 4,
    priority: "normal",
    inbox: [],
    history: [],
    events: [],
    executions: [run],
    currentExecutionId: run.id,
    lastResult: "",
    lastError: "",
    createdAt: 10,
    updatedAt: 20,
  };
}

const completedLegacyEcho = agent("agent_legacy_echo", "completed");
completedLegacyEcho.executions[0].result = "COLLABORATION_AGENT_CONSTRAINTS:\n思考过程指南：";
completedLegacyEcho.executions[0].completedAt = 25;
completedLegacyEcho.lastResult = completedLegacyEcho.executions[0].result;

const readOnlyRunning = agent("agent_running", "running");
readOnlyRunning.executions[0].context = "preserve recovery context";
readOnlyRunning.executions[0].stepCount = 1;
readOnlyRunning.executions[0].checkpoints = [{ step: 1, result: "committed checkpoint", createdAt: 22 }];
readOnlyRunning.inbox.push({
  id: "message_recovery",
  content: "recover this parent update",
  status: "delivered",
  createdAt: 15,
  deliveredAt: 18,
  deliveredRunSeq: 1,
  deliveredStep: 1,
  deliveryAttempts: 1,
  acknowledged: false,
  acknowledgedAt: 0,
  lastDeliveredRunSeq: 1,
  lastDeliveredStep: 1,
});

const writeRunning = agent("agent_write_running", "running");
writeRunning.readOnly = false;
writeRunning.targetPaths = ["/workspace/file.txt"];

const cancelling = agent("agent_cancelling", "cancelling");
cancelling.executions[0].cancelRequested = true;

const effectRunning = agent("agent_effect_running", "running");

const treeRoot = agent("agent_tree_root", "queued");
treeRoot.requestId = "recovered-idempotency-key";
treeRoot.requestFingerprint = JSON.stringify({
  task: "task for agent_tree_root",
  context: "",
  name: "agent_tree_root",
  parent_agent_id: "",
  parent_chat_id: "",
  include_conversation_context: false,
  workspace_path: "",
  workspace_env: "android",
  target_paths: [],
  read_only: true,
  priority: "normal",
  timeout_ms: 30000,
  max_tool_calls: null,
});
treeRoot.executions[0].rootAgentId = treeRoot.id;
treeRoot.executions[0].rootRunId = treeRoot.executions[0].id;
treeRoot.executions[0].treeDepth = 0;
const treeChild = agent("agent_tree_child", "queued");
treeChild.parentAgentId = treeRoot.id;
treeChild.executions[0].parentRunId = treeRoot.executions[0].id;
treeChild.executions[0].parentExecutionEpoch = treeRoot.executions[0].epoch;
treeChild.executions[0].rootAgentId = treeRoot.id;
treeChild.executions[0].rootRunId = treeRoot.executions[0].id;
treeChild.executions[0].treeDepth = 1;

const initialSnapshot = {
  schema_version: 1,
  saved_at: 30,
  agents: [
    readOnlyRunning,
    writeRunning,
    cancelling,
    effectRunning,
    agent("agent_queued", "queued"),
    treeRoot,
    treeChild,
    completedLegacyEcho,
  ],
};

function createAndroidDb(initial) {
  const database = new DatabaseSync(":memory:");
  let transactionSuccessful = false;
  database.exec(
    "CREATE TABLE collaboration_snapshot (" +
    "snapshot_id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, " +
    "snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  const escaped = JSON.stringify(initial).replace(/'/g, "''");
  database.exec(`INSERT INTO collaboration_snapshot VALUES (1, 1, '${escaped}', 30)`);
  return {
    execSQL(sql) {
      database.exec(String(sql));
    },
    rawQuery(sql) {
      const rows = database.prepare(String(sql)).all().map((row) => Object.values(row));
      let index = -1;
      return {
        moveToFirst() {
          index = rows.length > 0 ? 0 : -1;
          return index === 0;
        },
        moveToNext() {
          if (index < 0 || index + 1 >= rows.length) return false;
          index += 1;
          return true;
        },
        getInt(column) {
          return Number(rows[index][column]);
        },
        getString(column) {
          const value = rows[index][column];
          return value === null || value === undefined ? null : String(value);
        },
        close() {},
      };
    },
    enableWriteAheadLogging() {},
    beginTransaction() {
      transactionSuccessful = false;
      database.exec("BEGIN IMMEDIATE");
    },
    setTransactionSuccessful() {
      transactionSuccessful = true;
    },
    endTransaction() {
      database.exec(transactionSuccessful ? "COMMIT" : "ROLLBACK");
    },
    close() {},
    scalar(sql) {
      const row = database.prepare(String(sql)).get();
      return row ? Object.values(row)[0] : undefined;
    },
  };
}

const db = createAndroidDb(initialSnapshot);
const appContext = { openOrCreateDatabase: () => db };
const EnhancedAIService = {
  getChatInstance() {
    return {
      async callSuspend(method) {
        if (method === "getModelConfigForFunction") {
          return { contextLength: 8192, summaryTokenThreshold: 0.8 };
        }
        if (method !== "sendMessage") throw new Error(`unexpected method: ${method}`);
        return {
          async callSuspend(streamMethod, collector) {
            assert.equal(streamMethod, "collect");
            collector.emit("recovered queued run completed");
          },
        };
      },
    };
  },
  releaseChatInstance() {},
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
    return appContext;
  },
};

const { createCollaborationStore } = require("../dist/collaboration/store.js");
const setupStore = createCollaborationStore();
const preparedEffect = setupStore.prepareEffect({
  execution_epoch: "agent_effect_running:1:1",
  checkpoint_step: 0,
  operation: "external_write",
  request_hash: "effect-recovery-hash",
});
setupStore.resolveEffect(preparedEffect.effect.effectKey, "unknown", { reason: "test restart" });
setupStore.close();

const { createCollaborationManager } = require("../dist/collaboration/manager.js");

test("recovery starts a new attempt for safe read-only runs, blocks unresolved effects, resolves cancellation, and requeues queued runs", async () => {
  const manager = createCollaborationManager();
  const immediately = manager.list({ include_results: true });
  const recovering = immediately.agents.find((item) => item.id === "agent_running");
  assert.equal(recovering.status, "queued");
  const recoveredTreeRoot = immediately.agents.find((item) => item.id === "agent_tree_root");
  const deduplicatedTreeRoot = manager.spawn({
    task: "task for agent_tree_root",
    name: "agent_tree_root",
    request_id: "recovered-idempotency-key",
    read_only: true,
    timeout_ms: 30000,
    max_tool_calls: 4,
  });
  assert.equal(deduplicatedTreeRoot.delivery, "deduplicated");
  assert.equal(deduplicatedTreeRoot.agent.id, "agent_tree_root");
  const recoveredTreeChild = immediately.agents.find((item) => item.id === "agent_tree_child");
  assert.equal(recoveredTreeRoot.execution.root_run_id, "execution_agent_tree_root");
  assert.equal(recoveredTreeRoot.tree.total_runs, 2);
  assert.equal(recoveredTreeChild.execution.parent_run_id, "execution_agent_tree_root");
  assert.equal(recoveredTreeChild.execution.parent_execution_epoch, "agent_tree_root:1:1");
  assert.equal(recoveredTreeChild.execution.root_agent_id, "agent_tree_root");
  assert.equal(recoveredTreeChild.execution.root_run_id, "execution_agent_tree_root");
  assert.equal(recoveredTreeChild.execution.tree_depth, 1);
  assert.equal(recovering.execution.attempt, 2);
  assert.equal(recovering.execution.epoch, "agent_running:1:2");
  assert.deepEqual(recovering.execution.prior_epochs, ["agent_running:1:1"]);
  assert.equal(recovering.execution.recovery_count, 1);
  assert.equal(recovering.execution.context_replayed, true);
  assert.match(recovering.execution.recovery_reason, /read_only/);

  const orphaned = immediately.agents.find((item) => item.id === "agent_write_running");
  assert.equal(orphaned.status, "orphaned");
  assert.match(orphaned.error, /automatic retry is blocked/);
  const cancelled = immediately.agents.find((item) => item.id === "agent_cancelling");
  assert.equal(cancelled.status, "interrupted");
  assert.equal(cancelled.execution.attempt, 1);
  assert.match(cancelled.error, /cancellation was pending/);
  const effectBlocked = immediately.agents.find((item) => item.id === "agent_effect_running");
  assert.equal(effectBlocked.status, "orphaned");
  assert.equal(effectBlocked.execution.attempt, 1);
  assert.match(effectBlocked.error, /prepared or unknown side effects/);
  assert.ok(
    db.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'run_orphaned'") >= 2,
    "write and unresolved-effect recovery must be persisted as orphaned"
  );
  const legacyEcho = immediately.agents.find((item) => item.id === "agent_legacy_echo");
  assert.match(legacyEcho.result, /suppressed/);
  assert.equal(legacyEcho.result.includes("COLLABORATION_AGENT_CONSTRAINTS"), false);

  const waited = await manager.wait({
    agent_ids: ["agent_running", "agent_queued", "agent_tree_root", "agent_tree_child"],
    timeout_ms: 1000,
  });
  assert.equal(waited.timed_out, undefined);
  const recoveredReadOnly = waited.agents.find((item) => item.id === "agent_running");
  assert.equal(recoveredReadOnly.status, "completed");
  assert.equal(recoveredReadOnly.execution.attempt, 2);
  assert.equal(recoveredReadOnly.execution.context_replayed, true);
  assert.deepEqual(recoveredReadOnly.execution.prior_attempt_controls, [{
    attempt: 1,
    epoch: "agent_running:1:1",
    mode: "compatibility",
    status: "not_received",
    action: "",
    source: "none",
    repaired: false,
    error: "",
  }]);
  assert.equal(recoveredReadOnly.result, "recovered queued run completed");
  assert.equal(recoveredReadOnly.delivered_messages, 1);
  assert.equal(recoveredReadOnly.acknowledged_messages, 0);
  assert.equal(recoveredReadOnly.unacknowledged_messages, 1);
  assert.match(recoveredReadOnly.execution.message_delivery_warning, /presented twice/);
  assert.equal(db.scalar("SELECT delivery_attempts FROM messages WHERE message_id = 'message_recovery'"), 2);
  const recoveredQueued = waited.agents.find((item) => item.id === "agent_queued");
  assert.equal(recoveredQueued.status, "completed");
  assert.equal(recoveredQueued.execution.attempt, 1);
  assert.equal(recoveredQueued.result, "recovered queued run completed");
  assert.equal(db.scalar("SELECT COUNT(*) FROM run_attempts WHERE run_id = 'execution_agent_running'"), 2);
  const completedAt = recoveredReadOnly.execution.completed_at;
  manager.shutdown();

  const restarted = createCollaborationManager();
  const afterSecondRestart = restarted.list({
    agent_ids: ["agent_running", "agent_legacy_echo", "agent_tree_root", "agent_tree_child"],
    include_results: true,
  });
  const stableTreeRoot = afterSecondRestart.agents.find((item) => item.id === "agent_tree_root");
  const stableTreeChild = afterSecondRestart.agents.find((item) => item.id === "agent_tree_child");
  assert.equal(stableTreeRoot.execution.root_run_id, "execution_agent_tree_root");
  assert.equal(stableTreeRoot.tree.total_runs, 2);
  assert.equal(stableTreeChild.execution.parent_run_id, "execution_agent_tree_root");
  assert.equal(stableTreeChild.execution.root_run_id, "execution_agent_tree_root");
  assert.equal(stableTreeChild.execution.tree_depth, 1);
  const stableRun = afterSecondRestart.agents.find((item) => item.id === "agent_running");
  assert.equal(stableRun.status, "completed");
  assert.equal(stableRun.execution.attempt, 2);
  assert.equal(stableRun.execution.completed_at, completedAt);
  assert.equal(db.scalar("SELECT COUNT(*) FROM run_attempts WHERE run_id = 'execution_agent_running'"), 2);
  assert.equal(db.scalar("SELECT delivery_attempts FROM messages WHERE message_id = 'message_recovery'"), 2);
  restarted.shutdown();
});