"use strict";

const { cancelService, executeModelStep } = require("./engine.js");
const { createCollaborationStore, STATE_SCHEMA_VERSION } = require("./store.js");
const { createId, errorText, isPathWithin, normalizePath, now, pathsOverlap } = require("./helpers.js");
const {
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
} = require("./model.js");

const MAX_GLOBAL_CONCURRENCY = 6;
const MAX_TREE_DEPTH = 8;
const MAX_DIRECT_CHILDREN = 12;
const MAX_ACTIVE_PER_ROOT = 3;
const MAX_WAIT_MS = 12000;
const DEFAULT_WAIT_MS = 12000;
const MAX_CHECKPOINT_TURNS = 16;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const ACTIVE_RECOVERY_STATUSES = new Set(["running", "cancelling", "summarizing"]);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });

function requestFingerprint(payload) {
  return JSON.stringify({
    task: String(payload.task || "").trim(),
    context: String(payload.context || "").trim(),
    name: String(payload.name || "").trim(),
    parent_agent_id: String(payload.parent_agent_id || "").trim(),
    parent_chat_id: String(payload.parent_chat_id || "").trim(),
    workspace_path: String(payload.workspace_path || "").trim(),
    workspace_env: String(payload.workspace_env || "").trim() || "android",
    target_paths: Array.isArray(payload.target_paths) ? payload.target_paths : [],
    read_only: payload.read_only === true,
    priority: normalizePriority(payload.priority),
    timeout_ms: normalizeTimeout(payload.timeout_ms),
    max_tool_calls: normalizeMaxToolCalls(payload.max_tool_calls),
  });
}

function operationFingerprint(operation, payload) {
  if (operation === "spawn_agent") return requestFingerprint(payload);
  if (operation === "send_message") {
    return JSON.stringify({
      agent_id: String(payload.agent_id || "").trim(),
      message: String(payload.message || "").trim(),
    });
  }
  if (operation === "followup_task") {
    return JSON.stringify({
      agent_id: String(payload.agent_id || "").trim(),
      task: String(payload.task || "").trim(),
      context: String(payload.context || "").trim(),
      workspace_path: String(payload.workspace_path || "").trim(),
      workspace_env: String(payload.workspace_env || "").trim(),
      target_paths: payload.target_paths === undefined ? null : payload.target_paths,
      read_only: payload.read_only === undefined ? null : payload.read_only === true,
      priority: String(payload.priority || "").trim(),
      timeout_ms: payload.timeout_ms === undefined ? null : Number(payload.timeout_ms),
      max_tool_calls: payload.max_tool_calls === undefined ? null : Number(payload.max_tool_calls),
    });
  }
  if (operation === "interrupt_agent") {
    return JSON.stringify({ agent_id: String(payload.agent_id || "").trim() });
  }
  throw new Error(`unsupported idempotent operation: ${operation}`);
}

function createCollaborationManager() {
  const agents = new Map();
  const executions = new Map();
  const queue = [];
  const waiters = [];
  const activeByRoot = new Map();
  const store = createCollaborationStore();
  let active = 0;
  let lastScheduledRootId = "";
  let persistenceError = store.mode === "memory" && store.reason
    ? `SQLite unavailable: ${store.reason}`
    : "";
  let shuttingDown = false;

  function latestExecution(agent) {
    return agent.currentExecutionId ? executions.get(agent.currentExecutionId) || null : null;
  }

  function envelope(value) {
    return {
      success: true,
      persistence: store.mode,
      persistence_model: store.persistenceModel,
      persistence_schema: store.schemaVersion,
      persistence_revision: store.revision,
      persistence_migration: store.migration || undefined,
      persistence_error: persistenceError || undefined,
      path_isolation: "declarative",
      ...value,
    };
  }

  function snapshot() {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      saved_at: now(),
      agents: Array.from(agents.values()),
    };
  }

  function persist() {
    persistAgents(Array.from(agents.values()));
  }

  function persistAgents(changedAgents) {
    try {
      if (typeof store.saveAgents === "function") store.saveAgents(changedAgents);
      else store.save(snapshot());
      persistenceError = store.mode === "memory" && store.reason
        ? `SQLite unavailable: ${store.reason}`
        : "";
      return true;
    } catch (error) {
      persistenceError = errorText(error);
      return false;
    }
  }

  function persistAgent(agent) {
    return persistAgents([agent]);
  }

  function requestId(payload) {
    const value = String(payload && payload.request_id || "").trim();
    if (value.length > 200) throw new Error("request_id must be at most 200 characters");
    return value;
  }

  function priorRequest(operation, payload) {
    const id = requestId(payload);
    if (!id || typeof store.getRequest !== "function") return null;
    const fingerprint = operationFingerprint(operation, payload);
    const existing = store.getRequest(id, operation);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) {
      throw new Error(`request_id conflict: ${id} was already used with different ${operation} parameters`);
    }
    return existing;
  }

  function commitRequest(operation, payload, result, changedAgents) {
    const id = requestId(payload);
    if (!id || typeof store.commitRequest !== "function") {
      if (changedAgents && changedAgents.length > 0 && !persistAgents(changedAgents)) {
        throw new Error(`failed to persist ${operation}: ${persistenceError}`);
      }
      return result;
    }
    try {
      const committed = store.commitRequest({
        requestId: id,
        operation,
        fingerprint: operationFingerprint(operation, payload),
        result,
      }, changedAgents);
      persistenceError = store.mode === "memory" && store.reason
        ? `SQLite unavailable: ${store.reason}`
        : "";
      return committed.record.result;
    } catch (error) {
      persistenceError = errorText(error);
      throw error;
    }
  }

  function deduplicatedEnvelope(result, extra = {}) {
    return envelope({
      ...result,
      ...extra,
      delivery: "deduplicated",
      deduplicated: true,
    });
  }

  function cloneMutableAgentState(agent) {
    return JSON.parse(JSON.stringify(agent));
  }

  function restoreAgentState(agent, snapshot) {
    for (const key of Object.keys(agent)) delete agent[key];
    Object.assign(agent, snapshot);
    for (const execution of agent.executions) executions.set(execution.id, execution);
  }

  function encodeListCursor(agent) {
    return `${Number(agent.createdAt) || 0}:${agent.id}`;
  }

  function parseListCursor(value) {
    const cursor = String(value || "").trim();
    if (!cursor) return null;
    const separator = cursor.indexOf(":");
    const createdAt = Number(cursor.slice(0, separator));
    const agentId = cursor.slice(separator + 1);
    if (separator < 1 || !Number.isFinite(createdAt) || createdAt < 0 || !agentId) {
      throw new Error("cursor is invalid");
    }
    return { createdAt, agentId };
  }

  function afterListCursor(agent, cursor) {
    if (!cursor) return true;
    const createdAt = Number(agent.createdAt) || 0;
    return createdAt > cursor.createdAt || (createdAt === cursor.createdAt && agent.id > cursor.agentId);
  }

  function requireAgent(agentId) {
    const id = String(agentId || "").trim();
    const agent = agents.get(id);
    if (!agent) throw new Error(`agent not found: ${id}`);
    return agent;
  }

  function currentExecutionForAgentId(agentId) {
    const agent = agents.get(String(agentId || "").trim());
    return agent ? latestExecution(agent) : null;
  }

  function publicAgentWithTree(agent, includeResult = false, includeEvents = false) {
    return {
      ...publicAgent(agent, latestExecution(agent), includeResult, includeEvents),
      tree: treeSummary(agent),
    };
  }

  function treeSummary(agent) {
    const execution = latestExecution(agent);
    const rootAgentId = execution && execution.rootAgentId ? execution.rootAgentId : agent.id;
    const rootRunId = execution && execution.rootRunId ? execution.rootRunId : (execution ? execution.id : "");
    const memberExecutions = Array.from(executions.values()).filter((candidate) => {
      const candidateRootRunId = candidate.rootRunId || (candidate.treeDepth === 0 ? candidate.id : "");
      return rootRunId && candidateRootRunId === rootRunId;
    });
    const counts = {};
    for (const memberExecution of memberExecutions) {
      counts[memberExecution.status] = (counts[memberExecution.status] || 0) + 1;
    }
    return {
      root_agent_id: rootAgentId,
      root_run_id: rootRunId || undefined,
      direct_children: memberExecutions.filter((candidate) => candidate.parentRunId === (execution && execution.id)).length,
      total_runs: memberExecutions.length,
      active_runs: memberExecutions.filter((candidate) => !isTerminal(candidate.status)).length,
      statuses: counts,
      active: memberExecutions.some((candidate) => !isTerminal(candidate.status)),
    };
  }

  function relationForParent(payload) {
    const parentAgentId = String(payload && payload.parent_agent_id || "").trim();
    if (!parentAgentId) {
      return {
        parentAgentId: "",
        parentRunId: "",
        parentExecutionEpoch: "",
        rootAgentId: "",
        rootRunId: "",
        treeDepth: 0,
      };
    }
    const parentAgent = requireAgent(parentAgentId);
    const parentExecution = latestExecution(parentAgent);
    if (!parentExecution) throw new Error(`parent agent ${parentAgentId} has no current run`);
    if (isTerminal(parentExecution.status)) throw new Error(`parent run ${parentExecution.id} is terminal; use a follow-up run`);
    if (parentExecution.cancelRequested || parentExecution.status === "cancelling") {
      throw new Error(`parent run ${parentExecution.id} is cancelling; cannot attach a child run`);
    }
    const rootAgentId = parentExecution.rootAgentId || parentAgent.id;
    const treeDepth = (Number(parentExecution.treeDepth) || 0) + 1;
    if (treeDepth > MAX_TREE_DEPTH) throw new Error(`task tree depth exceeds ${MAX_TREE_DEPTH}`);
    const directChildren = Array.from(agents.values()).filter((agent) => {
      const execution = latestExecution(agent);
      return execution && execution.parentRunId === parentExecution.id;
    }).length;
    if (directChildren >= MAX_DIRECT_CHILDREN) throw new Error(`parent run direct child limit exceeded (${MAX_DIRECT_CHILDREN})`);
    const seen = new Set([parentAgent.id]);
    let current = parentAgent;
    while (current && current.parentAgentId) {
      if (seen.has(current.parentAgentId)) throw new Error("parent agent relationship contains a cycle");
      seen.add(current.parentAgentId);
      current = agents.get(current.parentAgentId);
    }
    return {
      parentAgentId,
      parentRunId: parentExecution.id,
      parentExecutionEpoch: parentExecution.epoch,
      rootAgentId,
      rootRunId: parentExecution.rootRunId || parentExecution.id,
      treeDepth,
    };
  }
  function indexAgent(agent) {
    agents.set(agent.id, agent);
    for (const execution of agent.executions) executions.set(execution.id, execution);
  }

  function beginRecoveryAttempt(agent, execution, reason) {
    const timestamp = now();
    const priorAttempt = execution.attempt;
    const priorEpoch = execution.epoch;
    const priorRecord = {
      attemptId: `${execution.id}:${priorAttempt}`,
      runId: execution.id,
      agentId: agent.id,
      runSeq: execution.seq,
      attempt: priorAttempt,
      executionEpoch: priorEpoch,
      status: "orphaned",
      recoveryReason: reason,
      contextReplayed: false,
      createdAt: execution.attemptCreatedAt || execution.createdAt,
      startedAt: execution.startedAt,
      completedAt: timestamp,
    };
    if (!execution.priorEpochs.includes(priorEpoch)) execution.priorEpochs.push(priorEpoch);
    execution.priorAttemptControls.push({
      attempt: priorAttempt,
      epoch: priorEpoch,
      mode: execution.controlMode || "compatibility",
      status: execution.controlStatus || "not_received",
      action: execution.controlAction || "",
      source: execution.controlSource || "none",
      repaired: execution.controlRepaired === true,
      error: execution.controlError || "",
    });
    if (execution.priorAttemptControls.length > 8) execution.priorAttemptControls.splice(0, execution.priorAttemptControls.length - 8);
    execution.attempt = priorAttempt + 1;
    execution.epoch = `${agent.id}:${execution.seq}:${execution.attempt}`;
    execution.attemptCreatedAt = timestamp;
    execution.recoveryCount += 1;
    execution.recoveryReason = reason;
    execution.contextReplayed = true;
    execution.status = "queued";
    execution.physicalStatus = "queued";
    execution.cancelRequested = false;
    execution.serviceKey = "";
    execution.currentTool = "";
    execution.startedAt = 0;
    execution.completedAt = 0;
    execution.result = "";
    execution.lateResult = "";
    execution.error = "";
    execution.summaryError = "";
    execution.summaryStatus = "not_required";
    execution.summaryFallbackUsed = false;
    execution.resultSuppressed = false;
    execution.messageDeliveryWarning = "";
    execution.controlMode = "compatibility";
    execution.controlStatus = "not_received";
    execution.controlAction = "";
    execution.controlEpoch = "";
    execution.controlSource = "none";
    execution.controlRepaired = false;
    execution.controlError = "";
    agent.status = "queued";
    agent.lastError = "";
    emitEvent(agent, execution, "run_recovery_started", {
      prior_epoch: priorEpoch,
      epoch: execution.epoch,
      attempt: execution.attempt,
      reason,
    });
    emitEvent(agent, execution, "context_replayed", {
      epoch: execution.epoch,
      task_context: !!execution.context,
      checkpoints: execution.checkpoints.length,
      history_entries: agent.history.length,
      pending_messages: agent.inbox.filter((message) => message.status === "queued").length,
    });
    return priorRecord;
  }

  function recover() {
    const loaded = store.load();
    if (!loaded || !Array.isArray(loaded.agents)) return;
    const loadedExecutions = new Map();
    for (const rawAgent of loaded.agents) {
      for (const rawExecution of Array.isArray(rawAgent && rawAgent.executions) ? rawAgent.executions : []) {
        if (rawExecution && rawExecution.id) loadedExecutions.set(rawExecution.id, rawExecution);
      }
    }
    function recoveredRootRunId(execution) {
      if (execution.rootRunId) return String(execution.rootRunId);
      let current = execution;
      const seen = new Set();
      while (current && current.parentRunId && !seen.has(current.parentRunId)) {
        seen.add(current.parentRunId);
        current = loadedExecutions.get(current.parentRunId) || null;
      }
      return String(current && current.id || execution.id || "");
    }
    let changed = false;
    const recoveryAttemptRecords = [];
    const recoveredQueueEntries = [];
    const existingQueueEntries = [];

    function orphanActiveRun(agent, execution, reason, error, effects = []) {
      execution.status = "orphaned";
      execution.physicalStatus = "orphaned";
      execution.error = error;
      execution.completedAt = execution.completedAt || now();
      execution.recoveryReason = reason;
      agent.status = "orphaned";
      agent.lastError = execution.error;
      appendHistory(agent, execution);
      emitEvent(agent, execution, "run_orphaned", {
        reason,
        epoch: execution.epoch,
        attempt: execution.attempt,
        unresolved_effects: effects.map((effect) => ({
          effect_key: effect.effectKey,
          status: effect.status,
          operation: effect.operation,
        })),
      });
    }

    function interruptRecoveredCancellation(agent, execution) {
      execution.status = "interrupted";
      execution.physicalStatus = "terminal";
      execution.error = "ToolPkg runtime restarted while cancellation was pending; the host call stack was not resumed";
      execution.completedAt = execution.completedAt || now();
      execution.recoveryReason = "runtime_restarted_during_cancellation";
      agent.status = "interrupted";
      agent.lastError = execution.error;
      appendHistory(agent, execution);
      emitEvent(agent, execution, "run_terminal", {
        status: "interrupted",
        error: execution.error,
        recovered: true,
      });
    }

    for (const raw of loaded.agents) {
      if (!raw || !raw.id) continue;
      const agent = {
        ...raw,
        requestId: String(raw.requestId || ""),
        requestFingerprint: String(raw.requestFingerprint || ""),
        inbox: Array.isArray(raw.inbox)
          ? raw.inbox.map((message) => {
            const acknowledged = message.acknowledged === true;
            const deliveryAttempts = Number.isFinite(Number(message.deliveryAttempts))
              ? Math.max(0, Math.floor(Number(message.deliveryAttempts)))
              : message.deliveredAt ? 1 : 0;
            let status = message.status || "queued";
            const ownerTerminal = isTerminal(raw.status);
            if (status === "inflight") {
              status = (!acknowledged && deliveryAttempts < 2 && !ownerTerminal) ? "queued" : "delivered";
              changed = true;
            } else if (!ownerTerminal && status === "delivered" && !acknowledged && deliveryAttempts < 2) {
              status = "queued";
              changed = true;
            }
            if (message.deliveryAttempts === undefined || message.acknowledged === undefined) changed = true;
            return {
              ...message,
              status,
              deliveryAttempts,
              acknowledged,
              acknowledgedAt: Number(message.acknowledgedAt) || 0,
              lastDeliveredRunSeq: Number(message.lastDeliveredRunSeq ?? message.deliveredRunSeq) || 0,
              lastDeliveredStep: Number(message.lastDeliveredStep ?? message.deliveredStep) || 0,
            };
          })
          : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        events: Array.isArray(raw.events) ? raw.events : [],
        executions: Array.isArray(raw.executions) ? raw.executions : [],
        targetPaths: Array.isArray(raw.targetPaths) ? raw.targetPaths : [],
      };
      for (const execution of agent.executions) {
        execution.checkpoints = Array.isArray(execution.checkpoints) ? execution.checkpoints : [];
        execution.parentRunId = String(execution.parentRunId || "");
        execution.parentExecutionEpoch = String(execution.parentExecutionEpoch || "");
        execution.rootAgentId = String(execution.rootAgentId || agent.id);
        execution.rootRunId = recoveredRootRunId(execution);
        execution.treeDepth = Math.max(0, Math.floor(Number(execution.treeDepth) || 0));
        execution.attempt = Math.max(1, Math.floor(Number(execution.attempt) || 1));
        execution.attemptCreatedAt = Number(execution.attemptCreatedAt || execution.createdAt) || now();
        execution.recoveryCount = Math.max(0, Math.floor(Number(execution.recoveryCount) || 0));
        execution.recoveryReason = String(execution.recoveryReason || "");
        execution.contextReplayed = execution.contextReplayed === true;
        execution.priorEpochs = Array.isArray(execution.priorEpochs) ? execution.priorEpochs : [];
        execution.priorAttemptControls = Array.isArray(execution.priorAttemptControls)
          ? execution.priorAttemptControls
          : [];
        execution.serviceKey = "";
        execution.summaryStatus = execution.summaryStatus || (execution.summaryError ? "failed" : "not_required");
        execution.summaryFallbackUsed = execution.summaryFallbackUsed === true;
        execution.resultSuppressed = execution.resultSuppressed === true;
        execution.messageDeliveryWarning = String(execution.messageDeliveryWarning || "");
        execution.controlMode = String(execution.controlMode || "compatibility");
        execution.controlStatus = String(execution.controlStatus || "not_received");
        execution.controlAction = String(execution.controlAction || "");
        execution.controlEpoch = String(execution.controlEpoch || "");
        execution.controlSource = String(execution.controlSource || "none");
        execution.controlRepaired = execution.controlRepaired === true;
        execution.controlError = String(execution.controlError || "");
      }
      indexAgent(agent);
      const execution = latestExecution(agent);
      if (execution && (ACTIVE_RECOVERY_STATUSES.has(execution.status) || ACTIVE_RECOVERY_STATUSES.has(agent.status))) {
        const wasCancelling = execution.status === "cancelling" || agent.status === "cancelling" || execution.cancelRequested;
        const unresolvedEffects = typeof store.listEffects === "function"
          ? store.listEffects(execution.epoch, ["prepared", "unknown"])
          : [];
        if (wasCancelling) {
          interruptRecoveredCancellation(agent, execution);
          changed = true;
        } else if (agent.readOnly === true && unresolvedEffects.length === 0) {
          recoveryAttemptRecords.push(
            beginRecoveryAttempt(agent, execution, "runtime_restarted_after_active_read_only_call")
          );
          recoveredQueueEntries.push({
            agentId: agent.id,
            executionId: execution.id,
            priority: agent.priority || "normal",
            rootAgentId: execution.rootAgentId || agent.id,
            rootRunId: execution.rootRunId || execution.id,
            enqueuedAt: now(),
          });
          changed = true;
        } else {
          const reason = unresolvedEffects.length > 0
            ? "runtime_restarted_with_unresolved_side_effects"
            : "runtime_restarted_write_capable";
          const error = unresolvedEffects.length > 0
            ? "ToolPkg runtime restarted with prepared or unknown side effects; automatic retry is blocked"
            : "ToolPkg runtime restarted during an active write-capable host call; automatic retry is blocked because side effects may be unknown";
          orphanActiveRun(agent, execution, reason, error, unresolvedEffects);
          changed = true;
        }
      } else if (execution && execution.status === "queued" && agent.status === "queued") {
        existingQueueEntries.push({
          agentId: agent.id,
          executionId: execution.id,
          priority: agent.priority || "normal",
          rootAgentId: execution.rootAgentId || agent.id,
          rootRunId: execution.rootRunId || execution.id,
          enqueuedAt: Number(execution.createdAt) || now(),
        });
      }
    }
    if (changed) {
      try {
        if (typeof store.saveRecovery === "function") {
          store.saveRecovery(snapshot(), recoveryAttemptRecords);
        } else {
          persist();
        }
        persistenceError = store.mode === "memory" && store.reason
          ? `SQLite unavailable: ${store.reason}`
          : "";
      } catch (error) {
        persistenceError = errorText(error);
        return;
      }
    }
    queue.push(...existingQueueEntries, ...recoveredQueueEntries);
    if (queue.length > 0) Promise.resolve().then(pump);
  }

  function assertNoPathConflict(targetPaths, excludeAgentId) {
    if (!targetPaths || targetPaths.length === 0) return;
    for (const other of agents.values()) {
      if (other.id === excludeAgentId || other.readOnly || isTerminal(other.status)) continue;
      for (const left of targetPaths) {
        for (const right of other.targetPaths) {
          if (pathsOverlap(left, right)) {
            throw new Error(`write path conflict with active agent ${other.id}: ${left} overlaps ${right}`);
          }
        }
      }
    }
  }

  function enqueue(agent, execution, options = {}) {
    executions.set(execution.id, execution);
    queue.push({
      agentId: agent.id,
      executionId: execution.id,
      priority: agent.priority,
      rootAgentId: execution.rootAgentId || agent.id,
      rootRunId: execution.rootRunId || execution.id,
      enqueuedAt: now(),
    });
    emitEvent(agent, execution, "run_queued", {
      task: execution.task,
      parent_run_id: execution.parentRunId,
      root_agent_id: execution.rootAgentId || agent.id,
      root_run_id: execution.rootRunId || execution.id,
      tree_depth: execution.treeDepth,
    });
    if (options.deferCommit === true) return;
    const persisted = persistAgent(agent);
    if (!persisted) {
      const index = queue.findIndex((entry) => entry.executionId === execution.id);
      if (index >= 0) queue.splice(index, 1);
      throw new Error(`failed to persist queued run: ${persistenceError}`);
    }
    pump();
  }

  function rootActiveCount(rootRunId) {
    return activeByRoot.get(String(rootRunId || "").trim()) || 0;
  }

  function canStartEntry(entry) {
    const root = String(entry.rootRunId || entry.executionId || "").trim();
    return rootActiveCount(root) < MAX_ACTIVE_PER_ROOT;
  }

  function queueRank(entry) {
    const priorityRank = PRIORITY_RANK[entry.priority] ?? PRIORITY_RANK.normal;
    const ageBonus = Math.min(2, Math.floor((now() - Number(entry.enqueuedAt || now())) / 30000));
    return priorityRank - ageBonus;
  }

  function takeNextQueueEntry() {
    let bestIndex = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestRoot = "";
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      if (!canStartEntry(entry)) continue;
      const rank = queueRank(entry);
      const root = String(entry.rootRunId || entry.executionId || "").trim();
      const fairnessPenalty = root === lastScheduledRootId ? 0.25 : 0;
      if (rank + fairnessPenalty < bestRank) {
        bestRank = rank + fairnessPenalty;
        bestIndex = index;
        bestRoot = root;
      }
    }
    if (bestIndex < 0) return null;
    lastScheduledRootId = bestRoot;
    return queue.splice(bestIndex, 1)[0];
  }

  function pendingMessages(agent) {
    return agent.inbox.filter((message) => message.status === "queued");
  }

  function stageMessages(agent, execution) {
    const messages = pendingMessages(agent);
    for (const message of messages) {
      message.status = "inflight";
      message.deliveredRunSeq = execution.seq;
      message.deliveredStep = execution.stepCount + 1;
      emitEvent(agent, execution, "message_staged", { message_id: message.id });
    }
    return messages;
  }

  function confirmMessages(agent, execution, messages) {
    const deliveredAt = now();
    for (const message of messages) {
      if (message.status !== "inflight") continue;
      message.status = "delivered";
      message.deliveredAt = deliveredAt;
      message.deliveryAttempts = (Number(message.deliveryAttempts) || 0) + 1;
      message.lastDeliveredRunSeq = execution.seq;
      message.lastDeliveredStep = execution.stepCount + 1;
      message.deliveredRunSeq = execution.seq;
      message.deliveredStep = execution.stepCount + 1;
      emitEvent(agent, execution, "message_delivered", {
        message_id: message.id,
        attempt: message.deliveryAttempts,
      });
    }
  }

  function acknowledgeMessages(agent, execution, messages, acknowledgedIds) {
    const ids = new Set((acknowledgedIds || []).map((id) => String(id || "").trim()));
    const acknowledgedAt = now();
    for (const message of messages) {
      if (!ids.has(message.id)) continue;
      message.status = "delivered";
      message.acknowledged = true;
      message.acknowledgedAt = acknowledgedAt;
      emitEvent(agent, execution, "message_acknowledged", { message_id: message.id });
    }
  }

  function requeueUnacknowledgedMessages(agent, execution, messages) {
    let requeued = 0;
    let exhausted = 0;
    for (const message of messages) {
      if (message.acknowledged === true) continue;
      if ((Number(message.deliveryAttempts) || 0) < 2) {
        message.status = "queued";
        requeued += 1;
        emitEvent(agent, execution, "message_requeued_unacknowledged", {
          message_id: message.id,
          attempt: message.deliveryAttempts,
        });
      } else {
        message.status = "delivered";
        exhausted += 1;
        emitEvent(agent, execution, "message_acknowledgement_exhausted", {
          message_id: message.id,
          attempts: message.deliveryAttempts,
        });
      }
    }
    return { requeued, exhausted };
  }

  function requeueMessages(agent, execution, messages) {
    for (const message of messages) {
      if (message.status !== "inflight") continue;
      message.status = "queued";
      message.deliveredRunSeq = 0;
      message.deliveredStep = 0;
      emitEvent(agent, execution, "message_requeued", { message_id: message.id });
    }
  }

  function finishExecution(agent, execution, status, error = "") {
    if (execution.completedAt && isTerminal(execution.status)) return;
    execution.status = status;
    execution.physicalStatus = "terminal";
    execution.currentTool = "";
    execution.error = error;
    execution.completedAt = execution.completedAt || now();
    agent.status = status;
    agent.lastError = error;
    if (status === "completed") agent.lastResult = execution.result;
    appendHistory(agent, execution);
    emitEvent(agent, execution, "run_terminal", { status, error });
    persistAgent(agent);
    resolveWaiters();
  }

  async function execute(agent, execution) {
    execution.status = "running";
    execution.physicalStatus = "running";
    execution.startedAt = now();
    agent.status = "running";
    emitEvent(agent, execution, "attempt_started", {
      epoch: execution.epoch,
      attempt: execution.attempt,
      recovered: execution.recoveryCount > 0,
    });
    emitEvent(agent, execution, "run_started", { epoch: execution.epoch, attempt: execution.attempt });
    persistAgent(agent);
    try {
      while (!execution.cancelRequested && execution.stepCount < MAX_CHECKPOINT_TURNS) {
        const messages = stageMessages(agent, execution);
        persistAgent(agent);
        let accepted = false;
        let response;
        try {
          response = await executeModelStep(agent, execution, messages, {
            onAccepted() {
              accepted = true;
              if (agent.currentExecutionId !== execution.id || isTerminal(execution.status)) return;
              confirmMessages(agent, execution, messages);
              persistAgent(agent);
            },
            onToolInvocation(toolName) {
              if (agent.currentExecutionId !== execution.id || isTerminal(execution.status)) return;
              execution.toolCount += 1;
              execution.currentTool = toolName;
              emitEvent(agent, execution, "tool_started", { tool_name: toolName });
              persistAgent(agent);
            },
          });
        } catch (error) {
          if (!accepted) {
            requeueMessages(agent, execution, messages);
            persistAgent(agent);
          }
          throw error;
        }
        execution.stepCount += 1;
        execution.currentTool = "";
        if (execution.cancelRequested || agent.currentExecutionId !== execution.id) {
          execution.lateResult = response.result;
          emitEvent(agent, execution, "late_result_ignored", { epoch: execution.epoch });
          finishExecution(agent, execution, "interrupted_with_late_result", "cancelled; host call returned late");
          return;
        }
        acknowledgeMessages(agent, execution, messages, response.acknowledgedMessageIds);
        const acknowledgement = requeueUnacknowledgedMessages(agent, execution, messages);
        const control = response.controlValid ? response.control : null;
        execution.controlMode = control ? "structured" : "compatibility";
        execution.controlStatus = control
          ? (control.executionEpoch !== execution.epoch
            ? "epoch_mismatch"
            : (response.controlRepaired ? "repaired" : "accepted"))
          : (response.controlPresent ? "invalid" : "not_received");
        execution.controlAction = control ? control.action : "";
        execution.controlEpoch = control ? control.executionEpoch : "";
        execution.controlSource = String(response.controlSource || (control ? "agent_response" : "none"));
        execution.controlRepaired = response.controlRepaired === true;
        execution.controlError = response.controlError || "";
        if (control && control.executionEpoch !== execution.epoch) {
          execution.lateResult = response.result;
          execution.result = "";
          execution.controlError = `control epoch mismatch: expected ${execution.epoch}, received ${control.executionEpoch}`;
          emitEvent(agent, execution, "control_epoch_mismatch", {
            expected_epoch: execution.epoch,
            received_epoch: control.executionEpoch,
            action: control.action,
          });
          finishExecution(agent, execution, "failed", execution.controlError);
          return;
        }
        execution.result = response.result;
        execution.summaryError = response.summaryError;
        execution.summaryStatus = response.summaryStatus;
        execution.summaryFallbackUsed = response.summaryFallbackUsed === true;
        execution.resultSuppressed = response.resultSuppressed === true;
        execution.messageDeliveryWarning = acknowledgement.exhausted > 0
          ? `${acknowledgement.exhausted} parent message(s) were presented twice but not acknowledged by the model`
          : "";
        execution.checkpoints.push({
          step: execution.stepCount,
          result: response.result,
          createdAt: now(),
        });
        emitEvent(agent, execution, "checkpoint", {
          step: execution.stepCount,
          acknowledged_messages: (response.acknowledgedMessageIds || []).length,
          requeued_messages: acknowledgement.requeued,
          exhausted_messages: acknowledgement.exhausted,
          control_mode: execution.controlMode,
          control_status: execution.controlStatus,
          control_action: execution.controlAction,
          control_source: execution.controlSource,
          control_repaired: execution.controlRepaired,
        });
        persistAgent(agent);
        if (control && control.action === "fail") {
          finishExecution(agent, execution, "failed", control.error);
          return;
        }
        if (control && control.action === "progress") continue;
        if (pendingMessages(agent).length === 0) {
          finishExecution(agent, execution, "completed");
          return;
        }
      }
      if (execution.cancelRequested) {
        finishExecution(agent, execution, "interrupted", "cancelled at execution checkpoint");
      } else {
        finishExecution(agent, execution, "failed", `checkpoint limit exceeded (${MAX_CHECKPOINT_TURNS})`);
      }
    } catch (error) {
      const text = errorText(error);
      if (execution.cancelRequested) finishExecution(agent, execution, "interrupted", "cancelled by parent agent");
      else if (/timed out/i.test(text)) finishExecution(agent, execution, "timed_out", text);
      else finishExecution(agent, execution, "failed", text);
    } finally {
      active = Math.max(0, active - 1);
      execution.serviceKey = "";
      Promise.resolve().then(pump);
    }
  }

  function pump() {
    if (shuttingDown) return;
    while (active < MAX_GLOBAL_CONCURRENCY && queue.length > 0) {
      const entry = takeNextQueueEntry();
      if (!entry) break;
      const agent = agents.get(entry.agentId);
      const execution = executions.get(entry.executionId);
      if (!agent || !execution || execution.status !== "queued") continue;
      active += 1;
      const rootRunId = String(entry.rootRunId || execution.rootRunId || execution.id);
      activeByRoot.set(rootRunId, rootActiveCount(rootRunId) + 1);
      Promise.resolve().then(() => execute(agent, execution).finally(() => {
        const remaining = Math.max(0, rootActiveCount(rootRunId) - 1);
        if (remaining === 0) activeByRoot.delete(rootRunId);
        else activeByRoot.set(rootRunId, remaining);
        pump();
      }));
    }
  }

  function selectedIds(payload) {
    const value = payload && payload.agent_ids;
    if (!Array.isArray(value) || value.length === 0) throw new Error("agent_ids must be a non-empty array");
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  }

  function waitResult(ids, timedOut) {
    return envelope({
      timed_out: timedOut || undefined,
      agents: ids.map((id) => {
        const agent = requireAgent(id);
        return publicAgentWithTree(agent, true, false);
      }),
    });
  }

  function resolveWaiters() {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.ids.every((id) => isTerminal(requireAgent(id).status))) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(waitResult(waiter.ids, false));
    }
  }

  function spawn(payload) {
    if (!payload || typeof payload !== "object") throw new Error("request must be an object");
    const task = String(payload.task || "").trim();
    if (!task) throw new Error("task is required");
    const requestKey = requestId(payload);
    const ledgerEntry = priorRequest("spawn_agent", payload);
    if (ledgerEntry) return deduplicatedEnvelope(ledgerEntry.result);
    if (requestKey) {
      const legacyAgent = Array.from(agents.values()).find((candidate) => candidate.requestId === requestKey);
      if (legacyAgent) {
        if (legacyAgent.requestFingerprint !== requestFingerprint(payload)) {
          throw new Error(`request_id conflict: ${requestKey} was already used with different spawn_agent parameters`);
        }
        return deduplicatedEnvelope({
          delivery: "queued",
          agent: publicAgentWithTree(legacyAgent, false, false),
        });
      }
    }
    const fingerprint = requestFingerprint(payload);
    const relation = relationForParent(payload);
    const agent = createAgent({
      ...payload,
      parent_agent_id: relation.parentAgentId,
      request_id: requestKey,
      request_fingerprint: fingerprint,
    });
    assertNoPathConflict(agent.readOnly ? [] : agent.targetPaths, "");
    indexAgent(agent);
    const execution = createExecution(agent, task, String(payload.context || "").trim(), relation);
    emitEvent(agent, execution, "agent_created", {
      parent_agent_id: agent.parentAgentId,
      parent_run_id: execution.parentRunId,
      parent_execution_epoch: execution.parentExecutionEpoch,
      root_agent_id: execution.rootAgentId,
      root_run_id: execution.rootRunId,
      tree_depth: execution.treeDepth,
    });
    enqueue(agent, execution, { deferCommit: true });
    const result = {
      delivery: "queued",
      agent: publicAgentWithTree(agent, false, false),
    };
    try {
      commitRequest("spawn_agent", payload, result, [agent]);
    } catch (error) {
      const queueIndex = queue.findIndex((entry) => entry.executionId === execution.id);
      if (queueIndex >= 0) queue.splice(queueIndex, 1);
      executions.delete(execution.id);
      agents.delete(agent.id);
      throw error;
    }
    pump();
    return envelope(result);
  }

  function list(payload) {
    const requestedIds = payload && Array.isArray(payload.agent_ids)
      ? new Set(payload.agent_ids.map((id) => String(id || "").trim()).filter(Boolean))
      : null;
    const requestedStatus = String((payload && payload.status) || "").trim();
    const includeResults = payload && payload.include_results === true;
    const filtered = Array.from(agents.values())
      .filter((agent) => !requestedIds || requestedIds.has(agent.id))
      .filter((agent) => !requestedStatus || agent.status === requestedStatus)
      .sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0) || left.id.localeCompare(right.id));
    if (requestedIds) {
      return envelope({
        active,
        queued: queue.length,
        total: filtered.length,
        has_more: false,
        agents: filtered.map((agent) => publicAgentWithTree(agent, includeResults, false)),
      });
    }
    const rawLimit = payload && payload.limit !== undefined ? Number(payload.limit) : DEFAULT_LIST_LIMIT;
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) throw new Error("limit must be a positive integer");
    const limit = Math.min(MAX_LIST_LIMIT, Math.floor(rawLimit));
    if (limit < 1) throw new Error("limit must be a positive integer");
    const cursor = parseListCursor(payload && payload.cursor);
    const remaining = filtered.filter((agent) => afterListCursor(agent, cursor));
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > page.length;
    return envelope({
      active,
      queued: queue.length,
      total: filtered.length,
      has_more: hasMore,
      next_cursor: hasMore && page.length > 0 ? encodeListCursor(page[page.length - 1]) : undefined,
      agents: page.map((agent) => publicAgentWithTree(agent, includeResults, false)),
    });
  }

  function sendMessage(payload) {
    const ledgerEntry = priorRequest("send_message", payload);
    if (ledgerEntry) return deduplicatedEnvelope(ledgerEntry.result);
    const agent = requireAgent(payload && payload.agent_id);
    const content = String((payload && payload.message) || "").trim();
    if (!content) throw new Error("message is required");
    if (isTerminal(agent.status)) {
      throw new Error(`agent ${agent.id} is ${agent.status}; use followup_task to start a new run`);
    }
    if (agent.status === "cancelling") throw new Error(`agent ${agent.id} is cancelling`);
    const execution = latestExecution(agent);
    if (!execution) throw new Error(`agent ${agent.id} has no active execution`);
    const priorState = cloneMutableAgentState(agent);
    const message = {
      id: createId("message"),
      content,
      status: "queued",
      createdAt: now(),
      deliveredAt: 0,
      deliveredRunSeq: 0,
      deliveredStep: 0,
      deliveryAttempts: 0,
      acknowledged: false,
      acknowledgedAt: 0,
      lastDeliveredRunSeq: 0,
      lastDeliveredStep: 0,
    };
    agent.inbox.push(message);
    emitEvent(agent, execution, "message_queued", { message_id: message.id });
    const result = {
      agent_id: agent.id,
      message_id: message.id,
      delivery: "queued_for_next_checkpoint",
      agent_status: agent.status,
      tree: treeSummary(agent),
    };
    try {
      commitRequest("send_message", payload, result, [agent]);
    } catch (error) {
      restoreAgentState(agent, priorState);
      throw error;
    }
    return envelope(result);
  }

  function followup(payload) {
    const ledgerEntry = priorRequest("followup_task", payload);
    if (ledgerEntry) return deduplicatedEnvelope(ledgerEntry.result);
    const agent = requireAgent(payload && payload.agent_id);
    if (!isTerminal(agent.status)) {
      throw new Error(`agent ${agent.id} is ${agent.status}; use send_message while it is active`);
    }
    const task = String((payload && payload.task) || "").trim();
    if (!task) throw new Error("task is required");
    const priorState = cloneMutableAgentState(agent);
    const paths = normalizeTargetPaths(payload.target_paths);
    const nextPaths = paths !== undefined ? paths : agent.targetPaths;
    const nextWorkspacePath = typeof payload.workspace_path === "string" && payload.workspace_path.trim()
      ? normalizePath(payload.workspace_path)
      : agent.workspacePath;
    if (nextWorkspacePath) {
      for (const path of nextPaths) {
        if (!isPathWithin(path, nextWorkspacePath)) {
          throw new Error(`target path is outside workspace: ${path}`);
        }
      }
    }
    let nextReadOnly = agent.readOnly;
    if (paths !== undefined && payload.read_only === undefined) nextReadOnly = paths.length === 0;
    if (payload.read_only !== undefined) nextReadOnly = payload.read_only === true;
    if (!nextReadOnly && nextPaths.length === 0) nextReadOnly = true;
    assertNoPathConflict(nextReadOnly ? [] : nextPaths, agent.id);
    agent.targetPaths = nextPaths;
    agent.readOnly = nextReadOnly;
    agent.workspacePath = nextWorkspacePath;
    if (typeof payload.workspace_env === "string" && payload.workspace_env.trim()) {
      agent.workspaceEnv = payload.workspace_env.trim();
    }
    if (payload.timeout_ms !== undefined) agent.timeoutMs = normalizeTimeout(payload.timeout_ms, agent.timeoutMs);
    if (payload.max_tool_calls !== undefined) {
      agent.maxToolCalls = normalizeMaxToolCalls(payload.max_tool_calls, agent.maxToolCalls);
    }
    if (typeof payload.priority === "string" && payload.priority.trim()) {
      agent.priority = normalizePriority(payload.priority);
    }
    for (const message of agent.inbox) {
      if (message.acknowledged === true) continue;
      message.status = "queued";
      message.deliveryAttempts = 0;
      emitEvent(agent, null, "message_requeued_for_followup", { message_id: message.id });
    }
    const execution = createExecution(agent, task, String(payload.context || "").trim(), {
      parentRunId: "",
      parentExecutionEpoch: "",
      rootAgentId: agent.id,
      rootRunId: "",
      treeDepth: 0,
    });
    emitEvent(agent, execution, "followup_created", { prior_run_seq: execution.seq - 1 });
    enqueue(agent, execution, { deferCommit: true });
    const result = {
      delivery: "queued",
      agent: publicAgentWithTree(agent, false, false),
    };
    try {
      commitRequest("followup_task", payload, result, [agent]);
    } catch (error) {
      const queueIndex = queue.findIndex((entry) => entry.executionId === execution.id);
      if (queueIndex >= 0) queue.splice(queueIndex, 1);
      executions.delete(execution.id);
      restoreAgentState(agent, priorState);
      throw error;
    }
    pump();
    return envelope(result);
  }

  function wait(payload) {
    const ids = selectedIds(payload);
    ids.forEach(requireAgent);
    if (ids.every((id) => isTerminal(requireAgent(id).status))) return Promise.resolve(waitResult(ids, false));
    const requested = Number(payload.timeout_ms ?? DEFAULT_WAIT_MS);
    const timeoutMs = Number.isFinite(requested)
      ? Math.max(1000, Math.min(MAX_WAIT_MS, Math.floor(requested)))
      : DEFAULT_WAIT_MS;
    return new Promise((resolve) => {
      const waiter = { ids, resolve, timeoutId: null };
      waiter.timeoutId = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(waitResult(ids, true));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function interruptDescendant(agent, execution, parentExecutionId, priorStates, servicesToCancel) {
    if (!execution || isTerminal(execution.status)) return false;
    if (!priorStates.has(agent.id)) priorStates.set(agent.id, cloneMutableAgentState(agent));
    execution.cancelRequested = true;
    emitEvent(agent, execution, "descendant_cancel_requested", {
      parent_run_id: parentExecutionId,
      root_agent_id: execution.rootAgentId || agent.id,
      root_run_id: execution.rootRunId || execution.id,
    });
    if (execution.status === "queued") {
      execution.status = "interrupted";
      execution.physicalStatus = "terminal";
      execution.error = "cancelled by parent agent";
      execution.completedAt = execution.completedAt || now();
      agent.status = "interrupted";
      agent.lastError = execution.error;
      const index = queue.findIndex((entry) => entry.executionId === execution.id);
      if (index >= 0) queue.splice(index, 1);
      appendHistory(agent, execution);
      emitEvent(agent, execution, "run_terminal", { status: "interrupted", propagated: true });
    } else {
      execution.status = "cancelling";
      agent.status = "cancelling";
      if (execution.serviceKey) servicesToCancel.add(execution.serviceKey);
    }
    return true;
  }

  function interruptTreeDescendants(parentExecution, priorStates, servicesToCancel) {
    const changed = [];
    for (const candidate of agents.values()) {
      const execution = latestExecution(candidate);
      if (!execution || execution.id === parentExecution.id) continue;
      let current = execution;
      const seen = new Set();
      while (current && current.parentRunId && !seen.has(current.parentRunId)) {
        if (current.parentRunId === parentExecution.id) {
          if (interruptDescendant(
            candidate,
            execution,
            parentExecution.id,
            priorStates,
            servicesToCancel
          )) changed.push(candidate);
          break;
        }
        seen.add(current.parentRunId);
        const parent = executions.get(current.parentRunId);
        current = parent || null;
      }
    }
    return changed;
  }

  function interrupt(payload) {
    const ledgerEntry = priorRequest("interrupt_agent", payload);
    if (ledgerEntry) return deduplicatedEnvelope(ledgerEntry.result);
    const agent = requireAgent(payload && payload.agent_id);
    const execution = latestExecution(agent);
    if (!execution || isTerminal(agent.status)) {
      const result = {
        agent: publicAgentWithTree(agent, true, false),
        interrupt: "already_terminal",
      };
      commitRequest("interrupt_agent", payload, result, []);
      return envelope(result);
    }
    const priorStates = new Map([[agent.id, cloneMutableAgentState(agent)]]);
    const priorQueue = queue.map((entry) => ({ ...entry }));
    const servicesToCancel = new Set();
    execution.cancelRequested = true;
    const descendants = interruptTreeDescendants(execution, priorStates, servicesToCancel);
    emitEvent(agent, execution, "cancel_requested", {
      physical_status: execution.physicalStatus,
      propagated_descendants: descendants.length,
    });
    let result;
    if (execution.status === "queued") {
      execution.status = "interrupted";
      execution.physicalStatus = "terminal";
      execution.error = "cancelled before start";
      execution.completedAt = now();
      agent.status = "interrupted";
      agent.lastError = execution.error;
      const index = queue.findIndex((entry) => entry.executionId === execution.id);
      if (index >= 0) queue.splice(index, 1);
      appendHistory(agent, execution);
      emitEvent(agent, execution, "run_terminal", { status: "interrupted" });
      result = {
        agent: publicAgentWithTree(agent, true, false),
        interrupt: "interrupted",
        propagated_descendants: descendants.length,
      };
    } else {
      execution.status = "cancelling";
      agent.status = "cancelling";
      if (execution.serviceKey) servicesToCancel.add(execution.serviceKey);
      result = {
        agent: publicAgentWithTree(agent, false, false),
        interrupt: "cancelling",
        propagated_descendants: descendants.length,
        note: "The host call may be non-cancellable; any late result will be isolated by execution epoch.",
      };
    }
    try {
      commitRequest("interrupt_agent", payload, result, [agent, ...descendants]);
    } catch (error) {
      for (const [agentId, snapshotValue] of priorStates) {
        restoreAgentState(requireAgent(agentId), snapshotValue);
      }
      queue.splice(0, queue.length, ...priorQueue);
      throw error;
    }
    for (const serviceKey of servicesToCancel) cancelService(serviceKey);
    resolveWaiters();
    return envelope(result);
  }

  function inspect(payload) {
    const agent = requireAgent(payload && payload.agent_id);
    return envelope({ agent: publicAgentWithTree(agent, true, true) });
  }

  function shutdown() {
    shuttingDown = true;
    for (const agent of agents.values()) {
      const execution = latestExecution(agent);
      if (!execution || isTerminal(agent.status) || execution.status === "queued") continue;
      execution.cancelRequested = true;
      cancelService(execution.serviceKey);
    }
    persist();
    store.close();
    return { ok: true };
  }

  recover();

  return {
    followup,
    inspect,
    interrupt,
    list,
    sendMessage,
    shutdown,
    spawn,
    wait,
    __test: { agents, executions, queue, latestExecution, persist },
  };
}

module.exports = { createCollaborationManager };