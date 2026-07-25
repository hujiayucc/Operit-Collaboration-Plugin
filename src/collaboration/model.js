"use strict";

const { clipText, createId, isPathWithin, normalizePath, now, safePublicResult } = require("./helpers.js");

const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_MAX_TOOL_CALLS = 16;
const MAX_RESULT_CHARS = 12000;
const MAX_EVENTS = 300;
const MAX_EXECUTIONS = 30;
const MAX_HISTORY = 12;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || ""));
}

function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const requested = Number(value ?? fallback);
  return Number.isFinite(requested)
    ? Math.max(30000, Math.min(3600000, Math.floor(requested)))
    : fallback;
}

function normalizeMaxToolCalls(value, fallback = DEFAULT_MAX_TOOL_CALLS) {
  const requested = Number(value ?? fallback);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(50, Math.floor(requested)))
    : fallback;
}

function normalizeTargetPaths(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("target_paths must be an array");
  return Array.from(new Set(value.map(normalizePath).filter(Boolean)));
}

function createAgent(payload) {
  const targetPaths = normalizeTargetPaths(payload.target_paths) || [];
  const requestedReadOnly = payload.read_only === true;
  const workspacePath = normalizePath(payload.workspace_path);
  if (workspacePath) {
    for (const path of targetPaths) {
      if (!isPathWithin(path, workspacePath)) {
        throw new Error(`target path is outside workspace: ${path}`);
      }
    }
  }
  const agent = {
    id: createId("agent"),
    requestId: String(payload.request_id || "").trim(),
    requestFingerprint: String(payload.request_fingerprint || "").trim(),
    name: String(payload.name || "").trim(),
    parentAgentId: String(payload.parent_agent_id || "").trim(),
    parentChatId: String(payload.parent_chat_id || "").trim(),
    status: "queued",
    runSeq: 0,
    readOnly: requestedReadOnly || targetPaths.length === 0,
    targetPaths,
    workspacePath,
    workspaceEnv: String(payload.workspace_env || "").trim() || "android",
    timeoutMs: normalizeTimeout(payload.timeout_ms),
    maxToolCalls: normalizeMaxToolCalls(payload.max_tool_calls),
    priority: normalizePriority(payload.priority),
    inbox: [],
    history: [],
    events: [],
    executions: [],
    currentExecutionId: "",
    lastResult: "",
    lastError: "",
    createdAt: now(),
    updatedAt: now(),
  };
  return agent;
}

function normalizePriority(value) {
  const priority = String(value || "normal").trim().toLowerCase();
  return priority === "high" || priority === "low" ? priority : "normal";
}

function createExecution(agent, task, context, relation = {}) {
  agent.runSeq += 1;
  const executionId = createId("execution");
  const parentRunId = String(relation.parentRunId || "").trim();
  const execution = {
    id: executionId,
    agentId: agent.id,
    seq: agent.runSeq,
    attempt: 1,
    attemptCreatedAt: now(),
    epoch: `${agent.id}:${agent.runSeq}:1`,
    recoveryCount: 0,
    recoveryReason: "",
    contextReplayed: false,
    priorEpochs: [],
    priorAttemptControls: [],
    parentRunId,
    parentExecutionEpoch: String(relation.parentExecutionEpoch || "").trim(),
    rootAgentId: String(relation.rootAgentId || agent.id).trim() || agent.id,
    rootRunId: String(relation.rootRunId || executionId).trim() || executionId,
    treeDepth: Math.max(0, Math.floor(Number(relation.treeDepth) || 0)),
    task,
    context,
    status: "queued",
    physicalStatus: "queued",
    cancelRequested: false,
    serviceKey: "",
    stepCount: 0,
    toolCount: 0,
    currentTool: "",
    checkpoints: [],
    result: "",
    lateResult: "",
    error: "",
    summaryError: "",
    summaryStatus: "not_required",
    summaryFallbackUsed: false,
    resultSuppressed: false,
    messageDeliveryWarning: "",
    controlMode: "compatibility",
    controlStatus: "not_received",
    controlAction: "",
    controlEpoch: "",
    controlSource: "none",
    controlRepaired: false,
    controlError: "",
    createdAt: now(),
    startedAt: 0,
    completedAt: 0,
    timeoutMs: agent.timeoutMs,
    maxToolCalls: agent.maxToolCalls,
  };
  agent.executions.push(execution);
  if (agent.executions.length > MAX_EXECUTIONS) {
    agent.executions.splice(0, agent.executions.length - MAX_EXECUTIONS);
  }
  agent.currentExecutionId = execution.id;
  agent.status = "queued";
  agent.lastError = "";
  agent.updatedAt = now();
  return execution;
}

function emitEvent(agent, execution, type, data = {}) {
  const event = {
    id: createId("event"),
    type,
    agent_id: agent.id,
    execution_id: execution ? execution.id : "",
    run_seq: execution ? execution.seq : agent.runSeq,
    created_at: now(),
    data,
  };
  agent.events.push(event);
  if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
  agent.updatedAt = event.created_at;
  return event;
}

function appendHistory(agent, execution) {
  agent.history.push({
    run_seq: execution.seq,
    task: execution.task,
    status: execution.status,
    result: clipText(safePublicResult(execution.result), 4000),
    error: execution.error,
    completed_at: execution.completedAt,
  });
  if (agent.history.length > MAX_HISTORY) agent.history.splice(0, agent.history.length - MAX_HISTORY);
}

function publicExecution(execution, includeResult) {
  if (!execution) return undefined;
  const output = {
    execution_id: execution.id,
    run_seq: execution.seq,
    parent_run_id: execution.parentRunId || undefined,
    parent_execution_epoch: execution.parentExecutionEpoch || undefined,
    root_agent_id: execution.rootAgentId || execution.agentId,
    root_run_id: execution.rootRunId || execution.id,
    tree_depth: Number(execution.treeDepth) || 0,
    attempt: execution.attempt,
    epoch: execution.epoch,
    recovery_count: Number(execution.recoveryCount) || 0,
    recovery_reason: execution.recoveryReason || undefined,
    context_replayed: execution.contextReplayed || undefined,
    prior_attempt_controls: Array.isArray(execution.priorAttemptControls) && execution.priorAttemptControls.length > 0
      ? execution.priorAttemptControls
      : undefined,
    prior_epochs: Array.isArray(execution.priorEpochs) && execution.priorEpochs.length > 0
      ? execution.priorEpochs
      : undefined,
    status: execution.status,
    physical_status: execution.physicalStatus,
    checkpoint_turns: execution.stepCount,
    tool_count: execution.toolCount,
    current_tool: execution.currentTool || undefined,
    created_at: execution.createdAt,
    started_at: execution.startedAt || undefined,
    completed_at: execution.completedAt || undefined,
    error: execution.error || undefined,
    summary_error: execution.summaryError || undefined,
    summary_status: execution.summaryStatus || "not_required",
    summary_fallback_used: execution.summaryFallbackUsed || undefined,
    result_suppressed: execution.resultSuppressed || undefined,
    message_delivery_warning: execution.messageDeliveryWarning || undefined,
    control_mode: execution.controlMode || "compatibility",
    control_status: execution.controlStatus || "not_received",
    control_action: execution.controlAction || undefined,
    control_epoch: execution.controlEpoch || undefined,
    control_source: execution.controlSource || "none",
    control_repaired: execution.controlRepaired || undefined,
    control_error: execution.controlError || undefined,
    late_result_recorded: !!execution.lateResult || undefined,
  };
  if (includeResult && execution.result) output.result = clipText(safePublicResult(execution.result), MAX_RESULT_CHARS);
  return output;
}

function publicAgent(agent, execution, includeResult = false, includeEvents = false) {
  const acknowledgedMessages = agent.inbox.filter((message) => message.acknowledged === true).length;
  const deliveredMessages = agent.inbox.filter((message) => message.status === "delivered").length;
  const output = {
    id: agent.id,
    name: agent.name || undefined,
    parent_agent_id: agent.parentAgentId || undefined,
    status: agent.status,
    run_seq: agent.runSeq,
    read_only: agent.readOnly,
    target_paths: agent.targetPaths,
    workspace_path: agent.workspacePath || undefined,
    workspace_env: agent.workspaceEnv,
    pending_messages: agent.inbox.filter((message) => message.status === "queued").length,
    inflight_messages: agent.inbox.filter((message) => message.status === "inflight").length || undefined,
    delivered_messages: deliveredMessages,
    acknowledged_messages: acknowledgedMessages,
    unacknowledged_messages: Math.max(0, deliveredMessages - acknowledgedMessages),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    execution: publicExecution(execution, includeResult),
  };
  if (includeResult && agent.lastResult) output.result = clipText(safePublicResult(agent.lastResult), MAX_RESULT_CHARS);
  if (agent.lastError) output.error = agent.lastError;
  if (includeEvents) output.recent_events = agent.events.slice(-30);
  return output;
}

module.exports = {
  MAX_HISTORY,
  appendHistory,
  createAgent,
  createExecution,
  emitEvent,
  isTerminal,
  normalizeMaxToolCalls,
  normalizePriority,
  normalizeTargetPaths,
  normalizeTimeout,
  publicAgent,
};