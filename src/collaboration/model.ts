import {
  clipText,
  createId,
  isPathWithin,
  normalizePath,
  now,
  safePublicResult,
  type JsonRecord,
} from "./helpers.js";

export type CollaborationMessage = JsonRecord & {
  id: string;
  content: string;
  status: string;
  createdAt: number;
  acknowledged?: boolean;
  acknowledgedAt?: number;
  deliveredAt?: number;
  deliveredRunSeq?: number;
  deliveredStep?: number;
  deliveryAttempts?: number;
  lastDeliveredRunSeq?: number;
  lastDeliveredStep?: number;
  sourceAgentId?: string;
  sourceRunId?: string;
  target?: string;
  targetAgentId?: string;
  error?: string;
};

export type CollaborationActionGateState = JsonRecord & {
  kind: string;
  allowed_tools: string[];
  pending_metadata: string[];
  fingerprint: string;
  mutation_checkpoint_index?: number;
  failed_attempts?: number;
  unknown_outcome?: boolean;
};

export type CollaborationCheckpoint = JsonRecord & {
  step: number;
  result: string;
  diagnostics: JsonRecord | null;
  evidence: JsonRecord | null;
  createdAt: number;
};

export type TreeContextEventKind =
  | "fact"
  | "decision"
  | "constraint"
  | "artifact"
  | "message"
  | "tool_result"
  | "checkpoint";

export type TreeContextVisibility = "tree" | "parent" | "children" | "agent";

export type TreeContextEvent = JsonRecord & {
  eventId: string;
  rootRunId: string;
  revision: number;
  sourceAgentId: string;
  sourceRunId: string;
  sourceEpoch: string;
  kind: TreeContextEventKind;
  visibility: TreeContextVisibility;
  payload: unknown;
  idempotencyKey: string;
  committedAt: number;
};

export type TreeContextSnapshot = JsonRecord & {
  rootRunId: string;
  revision: number;
  events: TreeContextEvent[];
  truncated: boolean;
  updatedAt: number;
};

export type AgentContextCursor = JsonRecord & {
  rootRunId: string;
  agentId: string;
  lastAppliedRevision: number;
  dirtyRevision: number;
  updatedAt: number;
};

export type CollaborationStreamState = JsonRecord & {
  requestAttempt: number;
  streamSeq: number;
  offset: number;
  status: "idle" | "streaming" | "completed" | "interrupted";
  publicText: string;
  promptEchoSuppressed: boolean;
  startedAt: number;
  updatedAt: number;
  completedAt: number;
};

export type CollaborationTreeContextState = JsonRecord & {
  watcherActive: boolean;
  appliedRevision: number;
  pendingRevision: number;
  lastBroadcastRevision: number;
  broadcastCount: number;
  refreshCount: number;
  refreshRevision: number;
};

export type CollaborationExecution = JsonRecord & {
  id: string;
  agentId: string;
  seq: number;
  attempt: number;
  attemptCreatedAt: number;
  epoch: string;
  recoveryCount: number;
  recoveryReason: string;
  contextReplayed: boolean;
  priorEpochs: string[];
  priorAttemptControls: JsonRecord[];
  parentRunId: string;
  parentExecutionEpoch: string;
  rootAgentId: string;
  rootRunId: string;
  treeDepth: number;
  sharedContextChatId: string;
  task: unknown;
  context: unknown;
  status: string;
  physicalStatus: string;
  cancelRequested: boolean;
  serviceKey: string;
  stepCount: number;
  toolCount: number;
  currentTool: string;
  modelRequestAttempts: number;
  modelRetryCount: number;
  currentModelRequestAttempt: number;
  lastModelRetryError: string;
  lastModelRetryDelayMs: number;
  modelRetryToolOutcomeUnknown: boolean;
  retryVerificationPending: boolean;
  checkpoints: CollaborationCheckpoint[];
  result: string;
  lateResult: string;
  error: string;
  summaryError: string;
  summaryStatus: string;
  summaryFallbackUsed: boolean;
  resultSuppressed: boolean;
  continuationRequired: boolean;
  continuationRepairCount: number;
  continuationRepairStreak: number;
  dirtyRevision: number;
  streamState: CollaborationStreamState;
  treeContextState: CollaborationTreeContextState;
  currentActionGate: CollaborationActionGateState | null;
  actionGateActivationCount: number;
  actionGateBlockCount: number;
  lastStepDiagnostics: JsonRecord | null;
  messageDeliveryWarning: string;
  controlMode: string;
  controlStatus: string;
  controlAction: string;
  controlEpoch: string;
  controlSource: string;
  controlRepaired: boolean;
  controlError: string;
  createdAt: number;
  startedAt: number;
  completedAt: number;
  timeoutMs: number;
  maxToolCalls: number;
  conversationContext?: unknown;
};

export type CollaborationAgent = JsonRecord & {
  id: string;
  requestId: string;
  requestFingerprint: string;
  name: string;
  parentAgentId: string;
  parentChatId: string;
  sharedContextEnabled: boolean;
  status: string;
  runSeq: number;
  readOnly: boolean;
  targetPaths: string[];
  workspacePath: string;
  workspaceEnv: string;
  timeoutMs: number;
  maxToolCalls: number;
  priority: string;
  inbox: CollaborationMessage[];
  outbox: CollaborationMessage[];
  history: JsonRecord[];
  events: JsonRecord[];
  executions: CollaborationExecution[];
  currentExecutionId: string;
  lastResult: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
};

const MIN_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 3600000;
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_MAX_TOOL_CALLS = 16;
const MAX_RESULT_CHARS = 24000;
const MAX_EVENTS = 300;
const MAX_PUBLIC_EVENTS = 100;
const MAX_EXECUTIONS = 30;
export const MAX_HISTORY = 12;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);

export function isTerminal(status: unknown): boolean {
  return TERMINAL_STATUSES.has(String(status || ""));
}

export function normalizeTimeout(value: unknown, fallback: number = DEFAULT_TIMEOUT_MS): number {
  if (value === undefined || value === null || value === "") return fallback;
  const requested = Number(value);
  if (!Number.isFinite(requested) || !Number.isInteger(requested) ||
      (requested !== 0 && (requested < MIN_TIMEOUT_MS || requested > MAX_TIMEOUT_MS))) {
    throw new Error(`timeout_ms must be 0 (unlimited) or an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return requested;
}

export function normalizeMaxToolCalls(value: unknown, fallback: number = DEFAULT_MAX_TOOL_CALLS): number {
  const requested = Number(value ?? fallback);
  if (!Number.isFinite(requested) || !Number.isInteger(requested)) return fallback;
  if (requested === 0) return 0;
  return Math.max(1, Math.min(64, requested));
}

export function normalizeWorkspaceEnv(value: unknown, fallback: string = "android"): string {
  const workspaceEnv = String(value || fallback).trim().toLowerCase();
  if (workspaceEnv !== "android" && workspaceEnv !== "linux") {
    throw new Error("workspace_env must be android or linux");
  }
  return workspaceEnv;
}

export function normalizeTargetPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("target_paths must be an array");
  return Array.from(new Set(value.map(normalizePath).filter(Boolean)));
}

export function createAgent(payload: JsonRecord): CollaborationAgent {
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
  const agent: CollaborationAgent = {
    id: createId("agent"),
    requestId: String(payload.request_id || "").trim(),
    requestFingerprint: String(payload.request_fingerprint || "").trim(),
    name: String(payload.name || "").trim(),
    parentAgentId: String(payload.parent_agent_id || "").trim(),
    parentChatId: String(payload.parent_chat_id || "").trim(),
    sharedContextEnabled: payload.shared_context_enabled === true,
    status: "queued",
    runSeq: 0,
    readOnly: requestedReadOnly || targetPaths.length === 0,
    targetPaths,
    workspacePath,
    workspaceEnv: normalizeWorkspaceEnv(payload.workspace_env),
    timeoutMs: normalizeTimeout(payload.timeout_ms),
    maxToolCalls: normalizeMaxToolCalls(payload.max_tool_calls),
    priority: normalizePriority(payload.priority),
    inbox: [],
    outbox: [],
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

export function normalizePriority(value: unknown): string {
  const priority = String(value || "normal").trim().toLowerCase();
  return priority === "high" || priority === "low" ? priority : "normal";
}

export function createExecution(
  agent: CollaborationAgent,
  task: unknown,
  context: unknown,
  relation: JsonRecord = {},
): CollaborationExecution {
  agent.runSeq += 1;
  const executionId = createId("execution");
  const parentRunId = String(relation.parentRunId || "").trim();
  const execution: CollaborationExecution = {
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
    sharedContextChatId: agent.sharedContextEnabled === true
      ? String(relation.sharedContextChatId || agent.parentChatId || "").trim()
      : "",
    task,
    context,
    status: "queued",
    physicalStatus: "queued",
    cancelRequested: false,
    serviceKey: "",
    stepCount: 0,
    toolCount: 0,
    currentTool: "",
    modelRequestAttempts: 0,
    modelRetryCount: 0,
    currentModelRequestAttempt: 0,
    lastModelRetryError: "",
    lastModelRetryDelayMs: 0,
    modelRetryToolOutcomeUnknown: false,
    retryVerificationPending: false,
    checkpoints: [],
    result: "",
    lateResult: "",
    error: "",
    summaryError: "",
    summaryStatus: "not_required",
    summaryFallbackUsed: false,
    resultSuppressed: false,
    continuationRequired: false,
    continuationRepairCount: 0,
    dirtyRevision: 0,
    streamState: {
      requestAttempt: 0,
      streamSeq: 0,
      offset: 0,
      status: "idle",
      publicText: "",
      promptEchoSuppressed: false,
      startedAt: 0,
      updatedAt: 0,
      completedAt: 0,
    },
    treeContextState: {
      watcherActive: false,
      appliedRevision: 0,
      pendingRevision: 0,
      lastBroadcastRevision: 0,
      broadcastCount: 0,
      refreshCount: 0,
      refreshRevision: 0,
    },
    currentActionGate: null,
    actionGateActivationCount: 0,
    actionGateBlockCount: 0,
    continuationRepairStreak: 0,
    lastStepDiagnostics: null,
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

export function emitEvent(
  agent: CollaborationAgent,
  execution: CollaborationExecution | null | undefined,
  type: unknown,
  data: JsonRecord = {},
): JsonRecord {
  const event = {
    id: createId("event"),
    type,
    agent_id: agent.id,
    execution_id: execution ? execution.id : "",
    run_seq: execution ? execution.seq : agent.runSeq,
    created_at: now(),
    data: Object.assign({}, data),
  };
  agent.events.push(event);
  if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
  agent.updatedAt = event.created_at;
  return event;
}

export function appendHistory(agent: CollaborationAgent, execution: CollaborationExecution): void {
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

function publicExecution(
  execution: CollaborationExecution | null | undefined,
  includeResult: boolean,
): JsonRecord | undefined {
  if (!execution) return undefined;
  const output: JsonRecord = {
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
    task_excerpt: clipText(String(execution.task || ""), 240),
    shared_context: !!execution.sharedContextChatId || undefined,
    checkpoint_turns: execution.stepCount,
    tool_count: execution.toolCount,
    model_request_attempts: Number(execution.modelRequestAttempts) || 0,
    model_retry_count: Number(execution.modelRetryCount) || 0,
    current_model_request_attempt: Number(execution.currentModelRequestAttempt) || undefined,
    last_model_retry_error: execution.lastModelRetryError || undefined,
    last_model_retry_delay_ms: Number(execution.lastModelRetryDelayMs) || undefined,
    model_retry_tool_outcome_unknown: execution.modelRetryToolOutcomeUnknown || undefined,
    retry_verification_pending: execution.retryVerificationPending || undefined,
    current_tool: execution.currentTool || undefined,
    current_action_gate: execution.currentActionGate || null,
    action_gate_activation_count: Number(execution.actionGateActivationCount) || 0,
    action_gate_block_count: Number(execution.actionGateBlockCount) || 0,
    created_at: execution.createdAt,
    started_at: execution.startedAt || undefined,
    completed_at: execution.completedAt || undefined,
    error: execution.error || undefined,
    summary_error: execution.summaryError || undefined,
    summary_status: execution.summaryStatus || "not_required",
    summary_fallback_used: execution.summaryFallbackUsed || undefined,
    result_suppressed: execution.resultSuppressed || undefined,
    continuation_required: execution.continuationRequired || undefined,
    continuation_repair_count: Number(execution.continuationRepairCount) || undefined,
    continuation_repair_streak: Number(execution.continuationRepairStreak) || undefined,
    dirty_revision: Number(execution.dirtyRevision) || undefined,
    stream_state: execution.streamState && typeof execution.streamState === "object"
      ? {
        request_attempt: Number(execution.streamState.requestAttempt) || 0,
        stream_seq: Number(execution.streamState.streamSeq) || 0,
        offset: Number(execution.streamState.offset) || 0,
        status: execution.streamState.status || "idle",
        public_text: execution.streamState.publicText || undefined,
        prompt_echo_suppressed: execution.streamState.promptEchoSuppressed === true || undefined,
        started_at: Number(execution.streamState.startedAt) || undefined,
        updated_at: Number(execution.streamState.updatedAt) || undefined,
        completed_at: Number(execution.streamState.completedAt) || undefined,
      }
      : undefined,
    tree_context: execution.treeContextState && typeof execution.treeContextState === "object"
      ? {
        watcher_active: execution.treeContextState.watcherActive === true || undefined,
        applied_revision: Number(execution.treeContextState.appliedRevision) || 0,
        pending_revision: Number(execution.treeContextState.pendingRevision) || 0,
        last_broadcast_revision: Number(execution.treeContextState.lastBroadcastRevision) || 0,
        broadcast_count: Number(execution.treeContextState.broadcastCount) || 0,
        refresh_count: Number(execution.treeContextState.refreshCount) || 0,
        refresh_revision: Number(execution.treeContextState.refreshRevision) || 0,
      }
      : undefined,
    diagnostics: execution.lastStepDiagnostics || undefined,
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

export function publicAgent(
  agent: CollaborationAgent,
  execution: CollaborationExecution | null | undefined,
  includeResult: boolean = false,
  includeEvents: boolean = false,
): JsonRecord {
  const acknowledgedMessages = agent.inbox.filter((message) => message.acknowledged === true).length;
  const deliveredMessages = agent.inbox.filter((message) => message.status === "delivered").length;
  const mainMessages = (Array.isArray(agent.outbox) ? agent.outbox : [])
    .filter((message) => message.target === "main" && message.status === "delivered_to_main")
    .map((message) => ({
      message_id: message.id,
      content: message.content,
      source_agent_id: agent.id,
      source_run_id: message.sourceRunId,
      created_at: message.createdAt,
    }));
  const output: JsonRecord = {
    id: agent.id,
    name: agent.name || undefined,
    parent_agent_id: agent.parentAgentId || undefined,
    status: agent.status,
    run_seq: agent.runSeq,
    read_only: agent.readOnly,
    target_paths: agent.targetPaths,
    workspace_path: agent.workspacePath || undefined,
    workspace_env: agent.workspaceEnv,
    priority: agent.priority,
    timeout_ms: agent.timeoutMs,
    max_tool_calls: agent.maxToolCalls,
    shared_context: agent.sharedContextEnabled === true || undefined,
    pending_messages: agent.inbox.filter((message) => message.status === "queued").length,
    inflight_messages: agent.inbox.filter((message) => message.status === "inflight").length || undefined,
    delivered_messages: deliveredMessages,
    acknowledged_messages: acknowledgedMessages,
    unacknowledged_messages: Math.max(0, deliveredMessages - acknowledgedMessages),
    main_messages: mainMessages.length > 0 ? mainMessages : undefined,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    execution: publicExecution(execution, includeResult),
  };
  if (includeResult && agent.lastResult) output.result = clipText(safePublicResult(agent.lastResult), MAX_RESULT_CHARS);
  if (agent.lastError) output.error = agent.lastError;
  if (includeEvents) output.recent_events = agent.events.slice(-MAX_PUBLIC_EVENTS);
  return output;
}

export {};