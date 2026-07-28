"use strict";

const { actionGateForAgent, actionGateToolAllowed, cancelService, clearModelRetryVerification, executeModelStep } = require("./engine.js");
const { createCollaborationStore, STATE_SCHEMA_VERSION } = require("./store.js");
const { clipText, createId, errorText, isPathWithin, normalizePath, now, pathsOverlap } = require("./helpers.js");
const {
  appendHistory,
  createAgent,
  createExecution,
  emitEvent,
  isTerminal,
  normalizePriority,
  normalizeTargetPaths,
  normalizeTimeout,
  normalizeWorkspaceEnv,
  publicAgent,
} = require("./model.js");

const DEFAULT_GLOBAL_CONCURRENCY = 6;
const MIN_GLOBAL_CONCURRENCY = 1;
const MAX_GLOBAL_CONCURRENCY = 16;
const DEFAULT_GLOBAL_MAX_TOOL_CALLS = 16;
const MIN_GLOBAL_MAX_TOOL_CALLS = 1;
const MAX_GLOBAL_MAX_TOOL_CALLS = 64;
const DEFAULT_MODEL_RETRIES = 5;
const MIN_MODEL_RETRIES = 0;
const MAX_MODEL_RETRIES = 12;
const MODEL_RETRY_BASE_DELAY_MS = 1000;
const MODEL_RETRY_MAX_DELAY_MS = 16000;
const MODEL_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_CONVERSATION_CONTEXT_MODE = "auto";
const CONVERSATION_CONTEXT_MODES = new Set(["off", "on", "auto"]);
const MAX_CONVERSATION_CONTEXT_TURNS = 40;
const MAX_CONVERSATION_CONTEXT_CHARS = 32000;
const SETTINGS_META_KEY = "collaboration_settings_v1";
const MAX_TREE_DEPTH = 8;
const MAX_DIRECT_CHILDREN = 12;
const DEFAULT_ACTIVE_RUNS_PER_ROOT = 3;
const MIN_ACTIVE_RUNS_PER_ROOT = 1;
const MAX_ACTIVE_RUNS_PER_ROOT = 8;
const MAX_WAIT_MS = 12000;
const DEFAULT_WAIT_MS = 12000;
const MAX_ACTION_CHECKPOINT_TURNS = 16;
const MAX_FINALIZATION_REPAIRS = 3;
const MAX_SCOPED_MUTATION_FAILURES = 3;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const QUEUE_AGING_STEP_MS = 120000;
const ACTIVE_RECOVERY_STATUSES = new Set(["running", "cancelling", "summarizing"]);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });

function requestFingerprint(payload) {
  return JSON.stringify({
    task: String(payload.task || "").trim(),
    context: String(payload.context || "").trim(),
    name: String(payload.name || "").trim(),
    parent_agent_id: String(payload.parent_agent_id || "").trim(),
    parent_chat_id: String(payload.parent_chat_id || "").trim(),
    include_conversation_context: payload.include_conversation_context === true,
    workspace_path: String(payload.workspace_path || "").trim(),
    workspace_env: normalizeWorkspaceEnv(payload.workspace_env),
    target_paths: Array.isArray(payload.target_paths) ? payload.target_paths : [],
    read_only: payload.read_only === true,
    priority: normalizePriority(payload.priority),
    timeout_ms: normalizeTimeout(payload.timeout_ms),
    max_tool_calls: null,
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
      parent_chat_id: String(payload.parent_chat_id || "").trim(),
      include_conversation_context: payload.include_conversation_context === true,
      workspace_path: String(payload.workspace_path || "").trim(),
      workspace_env: String(payload.workspace_env || "").trim()
        ? normalizeWorkspaceEnv(payload.workspace_env)
        : "",
      target_paths: payload.target_paths === undefined ? null : payload.target_paths,
      read_only: payload.read_only === undefined ? null : payload.read_only === true,
      priority: String(payload.priority || "").trim(),
      timeout_ms: payload.timeout_ms === undefined ? null : Number(payload.timeout_ms),
      max_tool_calls: null,
    });
  }
  if (operation === "interrupt_agent") {
    return JSON.stringify({ agent_id: String(payload.agent_id || "").trim() });
  }
  throw new Error(`unsupported idempotent operation: ${operation}`);
}

function createCollaborationManager(options = {}) {
  const agents = new Map();
  const executions = new Map();
  const queue = [];
  const waiters = [];
  const modelRetryWaiters = new Map();
  const activeByRoot = new Map();
  const retryDelayScale = Number.isFinite(Number(options.retryDelayScale))
    ? Math.max(0, Number(options.retryDelayScale))
    : 1;
  const store = options.store && typeof options.store.load === "function"
    ? options.store
    : createCollaborationStore();
  const getConversationContext = typeof options.getConversationContext === "function"
    ? options.getConversationContext
    : () => [];
  const onAgentToolInvocation = typeof options.onAgentToolInvocation === "function"
    ? options.onAgentToolInvocation
    : () => {};
  let active = 0;
  let settings = {
    maxConcurrentAgents: DEFAULT_GLOBAL_CONCURRENCY,
    maxActiveRunsPerRoot: DEFAULT_ACTIVE_RUNS_PER_ROOT,
    maxToolCalls: DEFAULT_GLOBAL_MAX_TOOL_CALLS,
    maxModelRetries: DEFAULT_MODEL_RETRIES,
    conversationContextMode: DEFAULT_CONVERSATION_CONTEXT_MODE,
  };
  let lastScheduledRootId = "";
  let persistenceError = store.mode === "memory" && store.reason
    ? `SQLite unavailable: ${store.reason}`
    : "";
  let shuttingDown = false;

  function latestExecution(agent) {
    return agent.currentExecutionId ? executions.get(agent.currentExecutionId) || null : null;
  }

  function normalizeGlobalConcurrency(value, fallback = DEFAULT_GLOBAL_CONCURRENCY) {
    const requested = Number(value);
    return Number.isInteger(requested) && requested >= MIN_GLOBAL_CONCURRENCY && requested <= MAX_GLOBAL_CONCURRENCY
      ? requested
      : fallback;
  }

  function normalizeActiveRunsPerRoot(value, fallback = DEFAULT_ACTIVE_RUNS_PER_ROOT) {
    const requested = Number(value);
    return Number.isInteger(requested) && requested >= MIN_ACTIVE_RUNS_PER_ROOT && requested <= MAX_ACTIVE_RUNS_PER_ROOT
      ? requested
      : fallback;
  }

  function normalizeGlobalMaxToolCalls(value, fallback = DEFAULT_GLOBAL_MAX_TOOL_CALLS) {
    const requested = Number(value);
    return Number.isInteger(requested) && requested >= MIN_GLOBAL_MAX_TOOL_CALLS && requested <= MAX_GLOBAL_MAX_TOOL_CALLS
      ? requested
      : fallback;
  }

  function normalizeModelRetries(value, fallback = DEFAULT_MODEL_RETRIES) {
    const requested = Number(value);
    return Number.isInteger(requested) && requested >= MIN_MODEL_RETRIES && requested <= MAX_MODEL_RETRIES
      ? requested
      : fallback;
  }

  function normalizeConversationContextMode(value, fallback = DEFAULT_CONVERSATION_CONTEXT_MODE) {
    const requested = String(value || "").trim().toLowerCase();
    return CONVERSATION_CONTEXT_MODES.has(requested) ? requested : fallback;
  }

  function normalizeConversationContext(value) {
    const source = Array.isArray(value) ? value.slice(-MAX_CONVERSATION_CONTEXT_TURNS) : [];
    const reversed = [];
    let remaining = MAX_CONVERSATION_CONTEXT_CHARS;
    for (let index = source.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const turn = source[index] || {};
      const kind = String(turn.kind || "").trim().toUpperCase();
      if (kind !== "USER" && kind !== "ASSISTANT") continue;
      const content = clipText(turn.content, remaining);
      if (!content) continue;
      reversed.push({ kind, content });
      remaining -= content.length;
    }
    return reversed.reverse();
  }

  function conversationContextFor(payload) {
    const requested = payload && payload.include_conversation_context === true;
    const include = settings.conversationContextMode === "on" ||
      (settings.conversationContextMode === "auto" && requested);
    if (!include) return [];
    const chatIds = [];
    const directChatId = String(payload && payload.parent_chat_id || "").trim();
    if (directChatId) chatIds.push(directChatId);
    let parentId = String(payload && payload.parent_agent_id || "").trim();
    for (let depth = 0; parentId && depth < MAX_TREE_DEPTH; depth += 1) {
      const parent = agents.get(parentId);
      if (!parent) break;
      const inheritedChatId = String(parent.parentChatId || "").trim();
      if (inheritedChatId && !chatIds.includes(inheritedChatId)) chatIds.push(inheritedChatId);
      parentId = String(parent.parentAgentId || "").trim();
    }
    for (const chatId of chatIds) {
      try {
        const snapshot = normalizeConversationContext(getConversationContext(chatId));
        if (snapshot.length > 0) return snapshot;
      } catch (error) {
        persistenceError = persistenceError || `conversation context unavailable: ${errorText(error)}`;
      }
    }
    return [];
  }

  function loadSettings() {
    try {
      const raw = typeof store.getMeta === "function" ? store.getMeta(SETTINGS_META_KEY) : "";
      const parsed = raw ? JSON.parse(raw) : {};
      const maxConcurrentAgents = normalizeGlobalConcurrency(parsed.max_concurrent_agents);
      settings = {
        maxConcurrentAgents,
        maxActiveRunsPerRoot: Math.min(
          parsed.max_active_runs_per_root === undefined
            ? DEFAULT_ACTIVE_RUNS_PER_ROOT
            : normalizeActiveRunsPerRoot(parsed.max_active_runs_per_root, maxConcurrentAgents),
          maxConcurrentAgents
        ),
        maxToolCalls: normalizeGlobalMaxToolCalls(parsed.max_tool_calls),
        maxModelRetries: normalizeModelRetries(parsed.max_model_retries),
        conversationContextMode: normalizeConversationContextMode(parsed.conversation_context_mode),
      };
    } catch (error) {
      persistenceError = persistenceError || `settings load failed: ${errorText(error)}`;
    }
  }

  function publicSettings() {
    return {
      max_concurrent_agents: settings.maxConcurrentAgents,
      max_active_runs_per_root: settings.maxActiveRunsPerRoot,
      max_tool_calls: settings.maxToolCalls,
      max_model_retries: settings.maxModelRetries,
      conversation_context_mode: settings.conversationContextMode,
      conversation_context_modes: [...CONVERSATION_CONTEXT_MODES],
      max_concurrent_agents_range: [MIN_GLOBAL_CONCURRENCY, MAX_GLOBAL_CONCURRENCY],
      max_active_runs_per_root_range: [MIN_ACTIVE_RUNS_PER_ROOT, MAX_ACTIVE_RUNS_PER_ROOT],
      max_tool_calls_range: [MIN_GLOBAL_MAX_TOOL_CALLS, MAX_GLOBAL_MAX_TOOL_CALLS],
      max_model_retries_range: [MIN_MODEL_RETRIES, MAX_MODEL_RETRIES],
      active_agents: active,
      queued_runs: queue.length,
      tool_limit_mode: "agent_prompt_budget",
      settings_persistence: store.mode,
    };
  }

  function getSettings() {
    return envelope({ settings: publicSettings() });
  }

  function updateSettings(payload) {
    if (!payload || typeof payload !== "object") throw new Error("settings request must be an object");
    const maxConcurrentAgents = Number(payload.max_concurrent_agents);
    const maxActiveRunsPerRoot = payload.max_active_runs_per_root === undefined
      ? Math.min(settings.maxActiveRunsPerRoot, maxConcurrentAgents)
      : Number(payload.max_active_runs_per_root);
    const maxToolCalls = Number(payload.max_tool_calls);
    const maxModelRetries = payload.max_model_retries === undefined
      ? settings.maxModelRetries
      : Number(payload.max_model_retries);
    const conversationContextMode = payload.conversation_context_mode === undefined
      ? settings.conversationContextMode
      : String(payload.conversation_context_mode || "").trim().toLowerCase();
    if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < MIN_GLOBAL_CONCURRENCY ||
        maxConcurrentAgents > MAX_GLOBAL_CONCURRENCY) {
      throw new Error(`max_concurrent_agents must be an integer between ${MIN_GLOBAL_CONCURRENCY} and ${MAX_GLOBAL_CONCURRENCY}`);
    }
    if (!Number.isInteger(maxActiveRunsPerRoot) || maxActiveRunsPerRoot < MIN_ACTIVE_RUNS_PER_ROOT ||
        maxActiveRunsPerRoot > MAX_ACTIVE_RUNS_PER_ROOT) {
      throw new Error(`max_active_runs_per_root must be an integer between ${MIN_ACTIVE_RUNS_PER_ROOT} and ${MAX_ACTIVE_RUNS_PER_ROOT}`);
    }
    if (maxActiveRunsPerRoot > maxConcurrentAgents) {
      throw new Error("max_active_runs_per_root must not exceed max_concurrent_agents");
    }
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < MIN_GLOBAL_MAX_TOOL_CALLS ||
        maxToolCalls > MAX_GLOBAL_MAX_TOOL_CALLS) {
      throw new Error(`max_tool_calls must be an integer between ${MIN_GLOBAL_MAX_TOOL_CALLS} and ${MAX_GLOBAL_MAX_TOOL_CALLS}`);
    }
    if (!Number.isInteger(maxModelRetries) || maxModelRetries < MIN_MODEL_RETRIES ||
        maxModelRetries > MAX_MODEL_RETRIES) {
      throw new Error(`max_model_retries must be an integer between ${MIN_MODEL_RETRIES} and ${MAX_MODEL_RETRIES}`);
    }
    if (!CONVERSATION_CONTEXT_MODES.has(conversationContextMode)) {
      throw new Error("conversation_context_mode must be off, on, or auto");
    }
    settings = { maxConcurrentAgents, maxActiveRunsPerRoot, maxToolCalls, maxModelRetries, conversationContextMode };
    if (typeof store.setMeta === "function") {
      store.setMeta(SETTINGS_META_KEY, JSON.stringify({
        max_concurrent_agents: settings.maxConcurrentAgents,
        max_active_runs_per_root: settings.maxActiveRunsPerRoot,
        max_tool_calls: settings.maxToolCalls,
        max_model_retries: settings.maxModelRetries,
        conversation_context_mode: settings.conversationContextMode,
      }));
    }
    pump();
    return envelope({ settings: publicSettings() });
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
    const createdAtText = cursor.slice(0, separator);
    const agentId = cursor.slice(separator + 1);
    if (separator < 1 || !/^(?:0|[1-9]\d*)$/.test(createdAtText) || !agentId) {
      throw new Error("cursor is invalid");
    }
    const createdAt = Number(createdAtText);
    if (!Number.isSafeInteger(createdAt)) throw new Error("cursor is invalid");
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

  function normalizeActionGate(actionGate) {
    if (!actionGate) return null;
    const normalized = {
      kind: String(actionGate.kind || ""),
      allowed_tools: Array.from(new Set(
        (Array.isArray(actionGate.allowedTools) ? actionGate.allowedTools : [])
          .map((toolName) => String(toolName || "").trim())
          .filter(Boolean)
      )).sort(),
      pending_metadata: Array.from(new Set(
        (Array.isArray(actionGate.pendingMetadata) ? actionGate.pendingMetadata : [])
          .map((packageName) => String(packageName || "").trim())
          .filter(Boolean)
      )).sort(),
    };
    if (Number.isInteger(actionGate.mutationCheckpointIndex)) {
      normalized.mutation_checkpoint_index = actionGate.mutationCheckpointIndex;
    }
    if (Number(actionGate.failedAttempts) > 0) normalized.failed_attempts = Number(actionGate.failedAttempts);
    if (actionGate.unknownOutcome === true) normalized.unknown_outcome = true;
    normalized.fingerprint = JSON.stringify(normalized);
    return normalized;
  }

  function syncActionGate(agent, execution, derivedGate = actionGateForAgent(agent, execution)) {
    if (!execution) return null;
    const previous = execution.currentActionGate && typeof execution.currentActionGate === "object"
      ? execution.currentActionGate
      : null;
    const next = normalizeActionGate(derivedGate);
    if (previous?.fingerprint === next?.fingerprint) return next;
    if (previous) {
      emitEvent(agent, execution, "action_gate_released", {
        kind: previous.kind,
        fingerprint: previous.fingerprint,
      });
    }
    execution.currentActionGate = next;
    if (next) {
      execution.actionGateActivationCount = (Number(execution.actionGateActivationCount) || 0) + 1;
      emitEvent(agent, execution, "action_gate_activated", {
        kind: next.kind,
        fingerprint: next.fingerprint,
        allowed_tools: next.allowed_tools,
        pending_metadata: next.pending_metadata,
        mutation_checkpoint_index: next.mutation_checkpoint_index,
      });
    }
    return next;
  }

  function recordActionGateBlocked(agent, execution, actionGate, gateViolations = [], details = {}) {
    const current = syncActionGate(agent, execution, actionGate);
    execution.actionGateBlockCount = (Number(execution.actionGateBlockCount) || 0) + 1;
    emitEvent(agent, execution, "action_gate_blocked", {
      kind: current?.kind || String(actionGate?.kind || ""),
      fingerprint: current?.fingerprint,
      tools: Array.from(new Set(gateViolations.map((toolName) => String(toolName || "")))).sort(),
      step: execution.stepCount,
      ...details,
    });
  }

  function publicAgentWithTree(agent, includeResult = false, includeEvents = false) {
    const execution = latestExecution(agent);
    if (execution && !isTerminal(execution.status)) syncActionGate(agent, execution);
    return {
      ...publicAgent(agent, execution, includeResult, includeEvents),
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
    const directChildren = Array.from(executions.values()).filter(
      (execution) => execution.parentRunId === parentExecution.id
    ).length;
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
    execution.currentModelRequestAttempt = 0;
    execution.modelRetryToolOutcomeUnknown = false;
    execution.retryVerificationPending = false;
    execution.startedAt = 0;
    execution.completedAt = 0;
    execution.result = "";
    execution.lateResult = "";
    execution.error = "";
    execution.summaryError = "";
    execution.summaryStatus = "not_required";
    execution.summaryFallbackUsed = false;
    execution.resultSuppressed = false;
    execution.continuationRepairCount = 0;
    execution.continuationRepairStreak = 0;
    execution.lastStepDiagnostics = null;
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
        parentChatId: String(raw.parentChatId || ""),
      };
      for (const execution of agent.executions) {
        execution.checkpoints = Array.isArray(execution.checkpoints) ? execution.checkpoints : [];
        const recoveredConversationContext = normalizeConversationContext(execution.conversationContext);
        if (recoveredConversationContext.length !== (Array.isArray(execution.conversationContext) ? execution.conversationContext.length : 0)) {
          changed = true;
        }
        execution.conversationContext = recoveredConversationContext;
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
        execution.modelRequestAttempts = Math.max(0, Math.floor(Number(execution.modelRequestAttempts) || 0));
        execution.modelRetryCount = Math.max(0, Math.floor(Number(execution.modelRetryCount) || 0));
        execution.currentModelRequestAttempt = 0;
        execution.lastModelRetryError = String(execution.lastModelRetryError || "");
        execution.lastModelRetryDelayMs = Math.max(0, Math.floor(Number(execution.lastModelRetryDelayMs) || 0));
        execution.modelRetryToolOutcomeUnknown = execution.modelRetryToolOutcomeUnknown === true;
        execution.retryVerificationPending = execution.retryVerificationPending === true;
        execution.summaryStatus = execution.summaryStatus || (execution.summaryError ? "failed" : "not_required");
        execution.summaryFallbackUsed = execution.summaryFallbackUsed === true;
        execution.resultSuppressed = execution.resultSuppressed === true;
        execution.continuationRequired = execution.continuationRequired === true;
        execution.continuationRepairCount = Math.max(0, Math.floor(Number(execution.continuationRepairCount) || 0));
        execution.currentActionGate = execution.currentActionGate && typeof execution.currentActionGate === "object"
          ? execution.currentActionGate
          : null;
        execution.actionGateActivationCount = Math.max(0, Math.floor(Number(execution.actionGateActivationCount) || 0));
        execution.actionGateBlockCount = Math.max(0, Math.floor(Number(execution.actionGateBlockCount) || 0));
        execution.continuationRepairStreak = Math.max(0, Math.floor(Number(execution.continuationRepairStreak) || 0));
        execution.lastStepDiagnostics = execution.lastStepDiagnostics && typeof execution.lastStepDiagnostics === "object"
          ? execution.lastStepDiagnostics
          : null;
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
        for (const entry of recoveredQueueEntries) {
          const agent = agents.get(entry.agentId);
          const execution = executions.get(entry.executionId);
          if (!agent || !execution || execution.status !== "queued") continue;
          orphanActiveRun(
            agent,
            execution,
            "recovery_state_persistence_failed",
            `Recovery state could not be persisted; automatic retry is blocked: ${persistenceError}`
          );
        }
        recoveredQueueEntries.splice(0, recoveredQueueEntries.length);
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
    return rootActiveCount(root) < settings.maxActiveRunsPerRoot;
  }

  function queueRank(entry) {
    const priorityRank = PRIORITY_RANK[entry.priority] ?? PRIORITY_RANK.normal;
    const ageBonus = Math.min(2, Math.floor((now() - Number(entry.enqueuedAt || now())) / QUEUE_AGING_STEP_MS));
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

  function modelErrorText(error) {
    if (!error) return "unknown model error";
    if (error instanceof Error && error.message) return String(error.message);
    if (typeof error === "object") {
      for (const key of ["message", "error", "detail", "body", "response"]) {
        if (typeof error[key] === "string" && error[key].trim()) return error[key].trim();
      }
      try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== "{}") return serialized;
      } catch (_) {}
    }
    return String(error);
  }

  function modelErrorStatus(error, text) {
    const candidates = [
      error && error.status,
      error && error.statusCode,
      error && error.httpStatus,
      error && error.response && error.response.status,
    ];
    for (const value of candidates) {
      const status = Number(value);
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
    const match = String(text || "").match(/(?:http(?:\s+status)?|status|code)[\s:=_-]*(\d{3})\b/i) ||
      String(text || "").match(/\b(408|409|425|429|5\d\d)\b/);
    return match ? Number(match[1]) : 0;
  }

  function modelErrorRetryAfterMs(error, text) {
    const values = [
      error && error.retryAfterMs,
      error && error.retry_after_ms,
      error && error.response && error.response.retryAfterMs,
    ];
    for (const value of values) {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) return Math.min(MODEL_RETRY_MAX_DELAY_MS, Math.floor(delay));
    }
    const seconds = String(text || "").match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/i);
    if (!seconds) return 0;
    return Math.min(MODEL_RETRY_MAX_DELAY_MS, Math.max(0, Math.floor(Number(seconds[1]) * 1000)));
  }

  function classifyModelError(error) {
    const text = modelErrorText(error);
    const normalized = text.toLowerCase();
    const status = modelErrorStatus(error, text);
    const deterministic = status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 405 || status === 406 || status === 410 || status === 413 || status === 415 || status === 422 ||
      /(?:insufficient[_\s-]*(?:balance|quota|credits?|funds?)|余额不足|余额|欠费|payment required|billing|recharge|top[ -]?up|invalid[_\s-]*(?:api[_\s-]*)?key|authentication|unauthorized|forbidden|permission denied|access denied|invalid (?:request|parameter|argument)|bad request|context (?:length|window)|maximum context|token limit|content policy|safety policy|policy (?:violation|rejection)|not allowed)/i.test(normalized);
    const transientStatus = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    const transientText = /(?:timed? out|timeout|network|socket|connection|connect|econnreset|econnrefused|enetunreach|ehostunreach|dns|broken pipe|stream (?:closed|reset|interrupted|ended)|unexpected eof|temporar(?:y|ily)|service unavailable|server (?:error|busy|overload)|rate limit|too many requests|try again|gateway|upstream|api.*(?:unavailable|failed)|provider.*(?:unavailable|failed)|网络|连接|超时|限流|服务繁忙|服务暂时|服务器错误|接口异常)/i.test(normalized);
    return {
      text,
      status,
      retryable: !deterministic && (transientStatus || transientText),
      retryAfterMs: modelErrorRetryAfterMs(error, text),
    };
  }

  function modelRetryDelayMs(retryIndex, retryAfterMs = 0) {
    if (retryAfterMs > 0) return retryAfterMs;
    const exponential = Math.min(MODEL_RETRY_MAX_DELAY_MS, MODEL_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryIndex - 1)));
    const jitter = 1 + ((Math.random() * 2 - 1) * MODEL_RETRY_JITTER_RATIO);
    return Math.max(0, Math.round(exponential * jitter));
  }

  function waitForModelRetry(execution, delayMs) {
    if (execution.cancelRequested) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        timeoutId: null,
        resolve(value) {
          if (modelRetryWaiters.get(execution.id) !== waiter) return;
          modelRetryWaiters.delete(execution.id);
          if (waiter.timeoutId !== null) clearTimeout(waiter.timeoutId);
          resolve(value);
        },
      };
      modelRetryWaiters.set(execution.id, waiter);
      waiter.timeoutId = setTimeout(() => waiter.resolve(!execution.cancelRequested), delayMs);
    });
  }

  function cancelModelRetryWait(execution) {
    const waiter = execution && modelRetryWaiters.get(execution.id);
    if (waiter && typeof waiter.resolve === "function") waiter.resolve(false);
  }

  async function executeModelStepWithRetry(agent, execution, messages, callbacks) {
    let priorAccepted = false;
    let toolsInvoked = false;
    let requestAttempt = 0;
    while (true) {
      requestAttempt += 1;
      execution.modelRequestAttempts = (Number(execution.modelRequestAttempts) || 0) + 1;
      execution.currentModelRequestAttempt = requestAttempt;
      emitEvent(agent, execution, "model_request_started", {
        checkpoint_step: execution.stepCount + 1,
        request_attempt: requestAttempt,
        max_retries: settings.maxModelRetries,
      });
      persistAgent(agent);
      try {
        const response = await executeModelStep(agent, execution, messages, {
          ...callbacks,
          finalizationHandoff: callbacks.finalizationHandoff,
          serviceKeySuffix: `attempt:${requestAttempt}`,
          retryContext: priorAccepted
            ? {
                request_attempt: requestAttempt,
                prior_attempt_failed: true,
                tool_outcome_unknown: toolsInvoked,
              }
            : null,
          onAccepted() {
            priorAccepted = true;
            if (callbacks.onAccepted) callbacks.onAccepted();
          },
          onToolInvocation(toolName) {
            toolsInvoked = true;
            if (callbacks.onToolInvocation) callbacks.onToolInvocation(toolName);
          },
        });
        response.diagnostics = {
          ...(response.diagnostics || {}),
          model_request_attempt: requestAttempt,
          model_request_retries: requestAttempt - 1,
        };
        execution.currentModelRequestAttempt = 0;
        return response;
      } catch (error) {
        const classification = classifyModelError(error);
        const retryAccepted = priorAccepted;
        const canRetry = classification.retryable && requestAttempt <= settings.maxModelRetries && !execution.cancelRequested;
        emitEvent(agent, execution, "model_request_failed", {
          checkpoint_step: execution.stepCount + 1,
          request_attempt: requestAttempt,
          retryable: classification.retryable,
          status: classification.status || undefined,
          error: clipText(classification.text, 500),
          tool_outcome_unknown: toolsInvoked || undefined,
        });
        persistAgent(agent);
        if (!canRetry) {
          execution.currentModelRequestAttempt = 0;
          const terminalError = error instanceof Error ? error : new Error(classification.text);
          terminalError.modelRequestAccepted = priorAccepted;
          throw terminalError;
        }
        const delayMs = Math.round(modelRetryDelayMs(requestAttempt, classification.retryAfterMs) * retryDelayScale);
        if (toolsInvoked) {
          execution.modelRetryToolOutcomeUnknown = true;
          execution.retryVerificationPending = true;
        }
        execution.modelRetryCount = (Number(execution.modelRetryCount) || 0) + 1;
        execution.lastModelRetryError = clipText(classification.text, 1000);
        execution.lastModelRetryDelayMs = delayMs;
        emitEvent(agent, execution, "model_request_retry_scheduled", {
          checkpoint_step: execution.stepCount + 1,
          failed_request_attempt: requestAttempt,
          next_request_attempt: requestAttempt + 1,
          delay_ms: delayMs,
          status: classification.status || undefined,
          tool_outcome_unknown: toolsInvoked || undefined,
        });
        persistAgent(agent);
        const shouldContinue = await waitForModelRetry(execution, delayMs);
        if (!shouldContinue) {
          const cancelled = new Error("model retry cancelled");
          cancelled.modelRequestAccepted = retryAccepted;
          throw cancelled;
        }
      }
    }
  }

  function finishExecution(agent, execution, status, error = "") {
    if (isTerminal(execution.status)) return;
    syncActionGate(agent, execution, null);
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

  function actionCheckpointTurns(execution) {
    return (execution.checkpoints || []).reduce(
      (count, checkpoint) => count + (checkpoint?.diagnostics?.finalization_checkpoint === true ? 0 : 1),
      0
    );
  }

  function hasActionCheckpointBudget(execution) {
    return actionCheckpointTurns(execution) < MAX_ACTION_CHECKPOINT_TURNS;
  }

  async function execute(agent, execution) {
    let pendingFinalizationHandoff = "";
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
    syncActionGate(agent, execution);
    persistAgent(agent);
    try {
      while (!execution.cancelRequested && (execution.continuationRequired || hasActionCheckpointBudget(execution))) {
        const messages = stageMessages(agent, execution);
        persistAgent(agent);
        let accepted = false;
        let response;
        try {
          response = await executeModelStepWithRetry(agent, execution, messages, {
            finalizationHandoff: execution.continuationRequired ? pendingFinalizationHandoff : "",
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
        try {
          onAgentToolInvocation({
            agent_id: agent.id,
            execution_epoch: execution.epoch,
            tool_name: toolName,
          });
        } catch (_) {}
        emitEvent(agent, execution, "tool_started", { tool_name: toolName });
        persistAgent(agent);
      },
            onSummaryStarted() {
              if (agent.currentExecutionId !== execution.id || isTerminal(execution.status) || execution.cancelRequested) return;
              execution.status = "summarizing";
              agent.status = "summarizing";
              emitEvent(agent, execution, "summary_started");
              persistAgent(agent);
            },
            onSummaryFinished() {
              if (agent.currentExecutionId !== execution.id || execution.status !== "summarizing" || execution.cancelRequested) return;
              execution.status = "running";
              agent.status = "running";
              emitEvent(agent, execution, "summary_finished");
              persistAgent(agent);
            },
          });
        } catch (error) {
          if (!accepted && error?.modelRequestAccepted !== true) {
            requeueMessages(agent, execution, messages);
            persistAgent(agent);
          }
          throw error;
        }
        execution.stepCount += 1;
        execution.currentTool = "";
        const wasFinalizationCheckpoint = response.diagnostics?.finalization_checkpoint === true;
        pendingFinalizationHandoff = response.continuationRequired && !wasFinalizationCheckpoint
          ? String(response.finalizationHandoff || "")
          : "";
        response.finalizationHandoff = "";
        if (execution.cancelRequested || agent.currentExecutionId !== execution.id) {
          execution.lateResult = response.result;
          emitEvent(agent, execution, "late_result_ignored", { epoch: execution.epoch });
          finishExecution(agent, execution, "interrupted_with_late_result", "cancelled; host call returned late");
          return;
        }
        acknowledgeMessages(agent, execution, messages, response.acknowledgedMessageIds);
        const acknowledgement = requeueUnacknowledgedMessages(agent, execution, messages);
        let control = response.controlValid ? response.control : null;
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
        execution.continuationRequired = response.continuationRequired === true;
        execution.lastStepDiagnostics = response.diagnostics || null;
        if (execution.continuationRequired) {
          execution.continuationRepairCount = (Number(execution.continuationRepairCount) || 0) + 1;
          const finalizationCheckpoint = response.diagnostics?.finalization_checkpoint === true;
          execution.continuationRepairStreak = finalizationCheckpoint
            ? (Number(execution.continuationRepairStreak) || 0) + 1
            : 0;
        } else {
          execution.continuationRepairStreak = 0;
        }
        const stepTools = Array.isArray(response.diagnostics?.tool_names)
          ? response.diagnostics.tool_names.filter(Boolean)
          : [];
        const modelRetryVerificationActive = execution.retryVerificationPending === true;
        const actionGate = actionGateForAgent(agent, execution);
        if (modelRetryVerificationActive && stepTools.length > 0) clearModelRetryVerification(execution);
        const normalizedStepTools = stepTools.map((toolName) => String(toolName).split(":").at(-1));
        if (actionGate?.kind === "pending_mutation" && normalizedStepTools.includes("edit_file")) {
          const receipts = response.evidence?.version === 1
            ? (response.evidence.mutation_receipts || []).filter((receipt) => receipt?.tool === "edit_file")
            : [];
          const mutationStatus = String(receipts.at(-1)?.status || "unknown");
          const terminalMutationError = mutationStatus === "unknown"
            ? "edit_file outcome is unknown; verify the assigned target state before a follow-up mutation"
            : (mutationStatus === "failed" && actionGate.failedAttempts + 1 >= MAX_SCOPED_MUTATION_FAILURES
              ? `scoped edit_file retry limit exceeded (${MAX_SCOPED_MUTATION_FAILURES})`
              : "");
          if (terminalMutationError) {
            execution.checkpoints.push({
              step: execution.stepCount,
              result: response.result,
              diagnostics: response.diagnostics || null,
              evidence: response.evidence || null,
              createdAt: now(),
            });
            finishExecution(agent, execution, "failed", terminalMutationError);
            return;
          }
        }
        const gateViolations = actionGate
          ? stepTools.filter((toolName) => !actionGateToolAllowed(actionGate, toolName))
          : [];
        if (gateViolations.length > 0) {
          recordActionGateBlocked(agent, execution, actionGate, gateViolations);
          execution.controlAction = "progress";
          execution.controlSource = "action_gate_repair";
          execution.controlRepaired = true;
          execution.continuationRequired = false;
          response.result = [
            `ACTION_GATE_BLOCKED tools=${Array.from(new Set(gateViolations)).join(",")}`,
            actionGate.kind === "metadata_before_creation"
              ? `Only authoritative source acquisition tools are available until these METADATA package contracts are committed: ${actionGate.pendingMetadata.join(", ")}.`
              : "Only edit_file is available until the committed scoped mutation succeeds; invoke edit_file now."
          ].join("\n");
          response.control = {
            version: 1,
            executionEpoch: execution.epoch,
            action: "progress",
            messageAcks: [],
            error: "",
          };
          response.controlValid = true;
          response.controlSource = "action_gate_repair";
          response.controlRepaired = true;
          execution.result = response.result;
          control = response.control;
          execution.controlMode = "structured";
          execution.controlStatus = "repaired";
          execution.controlAction = "progress";
          execution.controlEpoch = execution.epoch;
          execution.controlSource = "action_gate_repair";
          execution.controlRepaired = true;
        }
        execution.messageDeliveryWarning = acknowledgement.exhausted > 0
          ? `${acknowledgement.exhausted} parent message(s) were presented twice but not acknowledged by the model`
          : "";
        const checkpoint = {
          step: execution.stepCount,
          result: response.result,
          diagnostics: response.diagnostics || null,
          evidence: response.evidence || null,
          createdAt: now(),
        };
        execution.checkpoints.push(checkpoint);
        const postCheckpointActionGate = actionGateForAgent(agent, execution);
        syncActionGate(agent, execution, postCheckpointActionGate);
        const completionRequested = control?.action === "finish" ||
          (!control && !execution.continuationRequired && pendingMessages(agent).length === 0);
        if (postCheckpointActionGate && completionRequested) {
          const requestedControlAction = control?.action || "compatibility_finish";
          recordActionGateBlocked(agent, execution, postCheckpointActionGate, [], {
            reason: "premature_completion",
            control_action: requestedControlAction,
          });
          response.result = [
            response.result,
            `ACTION_GATE_BLOCKED control=${requestedControlAction}`,
            postCheckpointActionGate.kind === "metadata_before_creation"
              ? `Completion is blocked until these METADATA package contracts are committed: ${postCheckpointActionGate.pendingMetadata.join(", ")}.`
              : "Completion is blocked until the committed scoped mutation succeeds; invoke edit_file now.",
          ].filter(Boolean).join("\n");
          response.control = {
            version: 1,
            executionEpoch: execution.epoch,
            action: "progress",
            messageAcks: [],
            error: "",
          };
          response.controlValid = true;
          response.controlSource = "action_gate_repair";
          response.controlRepaired = true;
          response.continuationRequired = false;
          checkpoint.result = response.result;
          execution.result = response.result;
          execution.controlMode = "structured";
          execution.controlStatus = "repaired";
          execution.controlAction = "progress";
          execution.controlEpoch = execution.epoch;
          execution.controlSource = "action_gate_repair";
          execution.controlRepaired = true;
          execution.continuationRequired = false;
          control = response.control;
        }
        emitEvent(agent, execution, "model_step_classified", response.diagnostics || {});
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
          continuation_required: execution.continuationRequired,
          continuation_repair_count: execution.continuationRepairCount,
        });
        persistAgent(agent);
        if (control && control.action === "fail") {
          finishExecution(agent, execution, "failed", control.error);
          return;
        }
        if (control && control.action === "progress") {
          if (execution.continuationRequired && execution.continuationRepairStreak >= MAX_FINALIZATION_REPAIRS) {
            finishExecution(
              agent,
              execution,
              "failed",
              `agent did not return a valid finalization control after tool use (${MAX_FINALIZATION_REPAIRS} finalization repairs exhausted)`
            );
            return;
          }
          continue;
        }
        if (pendingMessages(agent).length === 0) {
          if (execution.continuationRequired) {
            if (execution.continuationRepairStreak >= MAX_FINALIZATION_REPAIRS) {
              finishExecution(
                agent,
                execution,
                "failed",
                `agent did not return a valid finalization control after tool use (${MAX_FINALIZATION_REPAIRS} finalization repairs exhausted)`
              );
              return;
            }
            continue;
          }
          finishExecution(agent, execution, "completed");
          return;
        }
      }
      if (execution.cancelRequested) {
        finishExecution(agent, execution, "interrupted", "cancelled at execution checkpoint");
      } else {
        finishExecution(agent, execution, "failed", `action checkpoint limit exceeded (${MAX_ACTION_CHECKPOINT_TURNS})`);
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
    while (active < settings.maxConcurrentAgents && queue.length > 0) {
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
    payload = { ...payload };
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
      max_tool_calls: settings.maxToolCalls,
      parent_agent_id: relation.parentAgentId,
      request_id: requestKey,
      request_fingerprint: fingerprint,
    });
    assertNoPathConflict(agent.readOnly ? [] : agent.targetPaths, "");
    indexAgent(agent);
    const execution = createExecution(agent, task, String(payload.context || "").trim(), relation,
      conversationContextFor({ ...payload, parent_agent_id: relation.parentAgentId }));
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

  function listSummary(filtered) {
    const statusCounts = {};
    for (const agent of filtered) {
      statusCounts[agent.status] = (statusCounts[agent.status] || 0) + 1;
    }
    return {
      active,
      queued: queue.length,
      status_counts: statusCounts,
      limits: {
        global_active_runs: settings.maxConcurrentAgents,
        active_runs_per_root: settings.maxActiveRunsPerRoot,
        max_tree_depth: MAX_TREE_DEPTH,
        max_direct_children: MAX_DIRECT_CHILDREN,
        max_tool_calls: settings.maxToolCalls,
        max_model_retries: settings.maxModelRetries,
      },
    };
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
        ...listSummary(filtered),
        total: filtered.length,
        has_more: false,
        agents: filtered.map((agent) => publicAgentWithTree(agent, includeResults, false)),
      });
    }
    const rawLimit = payload && payload.limit !== undefined ? Number(payload.limit) : DEFAULT_LIST_LIMIT;
    if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit) || rawLimit <= 0 || rawLimit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    const limit = rawLimit;
    const cursor = parseListCursor(payload && payload.cursor);
    const remaining = filtered.filter((agent) => afterListCursor(agent, cursor));
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > page.length;
    return envelope({
      ...listSummary(filtered),
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
    const agent = requireAgent(payload && payload.agent_id);
    payload = { ...payload, parent_chat_id: String(payload && payload.parent_chat_id || agent.parentChatId || "").trim() };
    const ledgerEntry = priorRequest("followup_task", payload);
    if (ledgerEntry) return deduplicatedEnvelope(ledgerEntry.result);
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
    const nextWorkspaceEnv = typeof payload.workspace_env === "string" && payload.workspace_env.trim()
      ? normalizeWorkspaceEnv(payload.workspace_env, agent.workspaceEnv)
      : agent.workspaceEnv;
    const nextTimeoutMs = payload.timeout_ms !== undefined
      ? normalizeTimeout(payload.timeout_ms, agent.timeoutMs)
      : agent.timeoutMs;
    let nextReadOnly = agent.readOnly;
    if (paths !== undefined && payload.read_only === undefined) nextReadOnly = paths.length === 0;
    if (payload.read_only !== undefined) nextReadOnly = payload.read_only === true;
    if (!nextReadOnly && nextPaths.length === 0) nextReadOnly = true;
    assertNoPathConflict(nextReadOnly ? [] : nextPaths, agent.id);
    agent.targetPaths = nextPaths;
    agent.readOnly = nextReadOnly;
    agent.workspacePath = nextWorkspacePath;
    agent.workspaceEnv = nextWorkspaceEnv;
    agent.timeoutMs = nextTimeoutMs;
    agent.maxToolCalls = settings.maxToolCalls;
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
    }, conversationContextFor(payload));
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
    cancelModelRetryWait(execution);
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
    cancelModelRetryWait(execution);
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

  function executionRootRunId(execution) {
    return execution && (execution.rootRunId || ((Number(execution.treeDepth) || 0) === 0 ? execution.id : ""));
  }

  function activeRootRunIds() {
    return new Set(Array.from(executions.values())
      .filter((execution) => execution && !isTerminal(execution.status))
      .map(executionRootRunId)
      .filter(Boolean));
  }

  function agentTouchesRoots(agent, rootRunIds) {
    return Array.isArray(agent && agent.executions) && agent.executions.some(
      (execution) => rootRunIds.has(executionRootRunId(execution))
    );
  }

  function protectedAgentIdsForActiveWork() {
    const activeRoots = activeRootRunIds();
    const protectedIds = new Set();
    for (const agent of agents.values()) {
      if (!isTerminal(agent.status) || agentTouchesRoots(agent, activeRoots)) protectedIds.add(agent.id);
    }
    for (const agentId of Array.from(protectedIds)) {
      let parentId = agents.get(agentId) && agents.get(agentId).parentAgentId;
      while (parentId && !protectedIds.has(parentId)) {
        protectedIds.add(parentId);
        parentId = agents.get(parentId) && agents.get(parentId).parentAgentId;
      }
    }
    return protectedIds;
  }

  function resolveRemovalWaiters(agentIds) {
    const removed = new Set(agentIds);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.ids.some((id) => removed.has(id))) continue;
      const timedOut = !waiter.ids.every((id) => isTerminal(requireAgent(id).status));
      waiters.splice(index, 1);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(waitResult(waiter.ids, timedOut));
    }
  }

  function removeAgents(agentIds) {
    const ids = Array.from(new Set(agentIds)).filter((id) => agents.has(id));
    if (ids.length === 0) return [];
    try {
      store.deleteAgents(ids);
      persistenceError = store.mode === "memory" && store.reason
        ? `SQLite unavailable: ${store.reason}`
        : "";
    } catch (error) {
      persistenceError = errorText(error);
      throw error;
    }
    resolveRemovalWaiters(ids);
    const removed = new Set(ids);
    for (const [executionId, execution] of executions) {
      if (removed.has(execution.agentId)) executions.delete(executionId);
    }
    for (const agentId of ids) agents.delete(agentId);
    return ids;
  }

  function deleteAgent(payload) {
    const agent = requireAgent(payload && payload.agent_id);
    if (!isTerminal(agent.status)) throw new Error(`agent ${agent.id} is ${agent.status}; only terminal agents can be deleted`);
    const protectedIds = protectedAgentIdsForActiveWork();
    if (protectedIds.has(agent.id)) {
      throw new Error(`agent ${agent.id} belongs to active work and cannot be deleted`);
    }
    const runIds = new Set((Array.isArray(agent.executions) ? agent.executions : [])
      .map((execution) => execution && execution.id)
      .filter(Boolean));
    const referenced = Array.from(agents.values()).some((candidate) => candidate.id !== agent.id && (
      candidate.parentAgentId === agent.id ||
      (Array.isArray(candidate.executions) && candidate.executions.some(
        (execution) => execution && runIds.has(execution.parentRunId)
      ))
    ));
    if (referenced) throw new Error(`agent ${agent.id} still has child history and cannot be deleted individually`);
    const deleted = removeAgents([agent.id]);
    return envelope({ deleted: deleted.length, deleted_agent_ids: deleted });
  }

  function clearHistory() {
    const protectedIds = protectedAgentIdsForActiveWork();
    const candidateSet = new Set(Array.from(agents.values())
      .filter((agent) => isTerminal(agent.status))
      .filter((agent) => !protectedIds.has(agent.id))
      .map((agent) => agent.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const agentId of Array.from(candidateSet)) {
        const agent = agents.get(agentId);
        if (!agent) continue;
        const runIds = new Set((Array.isArray(agent.executions) ? agent.executions : [])
          .map((execution) => execution && execution.id)
          .filter(Boolean));
        const externalChild = Array.from(agents.values()).some((candidate) =>
          candidate.id !== agentId && !candidateSet.has(candidate.id) && (
            candidate.parentAgentId === agentId ||
            (Array.isArray(candidate.executions) && candidate.executions.some(
              (execution) => execution && runIds.has(execution.parentRunId)
            ))
          )
        );
        if (externalChild) {
          candidateSet.delete(agentId);
          changed = true;
        }
      }
    }
    const deleted = removeAgents(Array.from(candidateSet));
    return envelope({ deleted: deleted.length, deleted_agent_ids: deleted });
  }

  function inspect(payload) {
    const agent = requireAgent(payload && payload.agent_id);
    return envelope({ agent: publicAgentWithTree(agent, true, true) });
  }

  function listTree(payload) {
    const requestedRootRunId = String(payload && payload.root_run_id || "").trim();
    const requestedAgentId = String(payload && payload.agent_id || "").trim();
    let rootRunId = requestedRootRunId;
    if (!rootRunId && requestedAgentId) {
      const execution = latestExecution(requireAgent(requestedAgentId));
      if (!execution) throw new Error(`agent ${requestedAgentId} has no current run`);
      rootRunId = execution.rootRunId || execution.id;
    }
    if (!rootRunId) throw new Error("root_run_id or agent_id is required");
    const nodes = Array.from(executions.values())
      .filter((execution) => (execution.rootRunId || (execution.treeDepth === 0 ? execution.id : "")) === rootRunId)
      .sort((left, right) => (Number(left.treeDepth) || 0) - (Number(right.treeDepth) || 0) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0) || left.id.localeCompare(right.id))
      .map((execution) => {
        const agent = agents.get(execution.agentId);
        return {
          agent_id: execution.agentId,
          name: agent && agent.name || undefined,
          parent_agent_id: agent && agent.parentAgentId || undefined,
          execution_id: execution.id,
          parent_run_id: execution.parentRunId || undefined,
          root_run_id: rootRunId,
          tree_depth: Number(execution.treeDepth) || 0,
          run_seq: execution.seq,
          status: execution.status,
          read_only: agent ? agent.readOnly : true,
          task: String(execution.task || ""),
          task_excerpt: String(execution.task || "").slice(0, 240),
          created_at: execution.createdAt,
          updated_at: agent && agent.updatedAt || execution.completedAt || execution.startedAt || execution.createdAt,
        };
      });
    if (nodes.length === 0) throw new Error(`task tree not found: ${rootRunId}`);
    return envelope({ root_run_id: rootRunId, nodes });
  }

  function getActionGate(agentId) {
    const agent = agents.get(String(agentId || "").trim());
    const execution = agent ? latestExecution(agent) : null;
    if (!agent || !execution || isTerminal(execution.status)) return null;
    syncActionGate(agent, execution);
    return actionGateForAgent(agent, execution);
  }

  function shutdown() {
    shuttingDown = true;
    for (const agent of agents.values()) {
      const execution = latestExecution(agent);
      if (!execution || isTerminal(agent.status) || execution.status === "queued") continue;
      execution.cancelRequested = true;
      cancelModelRetryWait(execution);
      cancelService(execution.serviceKey);
    }
    persist();
    store.close();
    return { ok: true };
  }

  loadSettings();
  recover();

  return {
    clearHistory,
    deleteAgent,
    followup,
    getActionGate,
    getSettings,
    inspect,
    interrupt,
    list,
    listTree,
    sendMessage,
    shutdown,
    spawn,
    updateSettings,
    wait,
    __test: {
      agents,
      executions,
      queue,
      latestExecution,
      persist,
      queueRank,
      classifyModelError,
      modelRetryDelayMs,
    },
  };
}

module.exports = { createCollaborationManager };