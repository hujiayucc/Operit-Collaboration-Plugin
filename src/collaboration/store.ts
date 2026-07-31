import { createId, now, sqliteLiteral } from "./helpers.js";
import type {
  AgentContextCursor,
  TreeContextEvent,
  TreeContextEventKind,
  TreeContextSnapshot,
  TreeContextVisibility,
} from "./model.js";

type SQLiteValue = string | number | null;
type SQLiteRow = Record<string, SQLiteValue>;
type DynamicRecord = Record<string, unknown>;
type SnapshotRecord = DynamicRecord & { agents?: DynamicRecord[]; revision?: number; saved_at?: number };
type AttemptRecord = DynamicRecord & {
  attemptId: string;
  runId: string;
  agentId: string;
  runSeq: number;
  attempt: number;
  executionEpoch: string;
  status: string;
  recoveryReason: string;
  contextReplayed: boolean;
  createdAt: number;
  startedAt: number;
  completedAt: number;
};
type EffectRequest = {
  effectKey: string;
  executionEpoch: string;
  checkpointStep: number;
  operation: string;
  requestHash: string;
};
type EffectRecord = EffectRequest & DynamicRecord & {
  status: string;
  result: unknown;
  createdAt: number;
  updatedAt: number;
};
type RequestRecord = DynamicRecord & {
  requestKey: string;
  requestId: string;
  operation: string;
  fingerprint: string;
  status: string;
  result: unknown;
  createdAt: number;
  updatedAt: number;
};
type EffectOwner = AttemptRecord;
type CommitResult<T> = { deduplicated: boolean; record: T };
type EffectDisposition = { disposition: "reuse" | "blocked" | "execute"; effect: EffectRecord };
type TreeContextEventInput = {
  eventId?: string;
  rootRunId: string;
  sourceAgentId: string;
  sourceRunId: string;
  sourceEpoch: string;
  kind: TreeContextEventKind;
  visibility?: TreeContextVisibility;
  payload: unknown;
  idempotencyKey?: string;
  committedAt?: number;
};
type TreeContextCommit = {
  deduplicated: boolean;
  event: TreeContextEvent;
  checkpoint?: DynamicRecord | null;
};
type TreeContextCommitOptions = {
  cursor?: AgentContextCursor;
  snapshot?: TreeContextSnapshot;
  changedAgents?: DynamicRecord[];
};

interface SQLiteCursor {
  moveToFirst(): boolean;
  moveToNext?(): boolean;
  getString(index: number): string | null;
  close(): void;
}

interface DynamicDatabase {
  execSQL(sql: string): void;
  rawQuery(sql: string, args: unknown): SQLiteCursor;
  beginTransaction(): void;
  setTransactionSuccessful(): void;
  endTransaction(): void;
  enableWriteAheadLogging?(): void;
  close(): void;
}

export interface CollaborationStore {
  readonly mode: "memory" | "sqlite";
  readonly reason: string;
  readonly migration: string;
  readonly schemaVersion: number;
  readonly persistenceModel: "event_store";
  readonly revision: number;
  load(): SnapshotRecord | null;
  save(snapshot: SnapshotRecord): void;
  saveAgent(agent: DynamicRecord): void;
  saveAgents(changedAgents: DynamicRecord[]): void;
  deleteAgents(agentIds: string[]): number;
  getMeta(key: unknown): string;
  setMeta(key: unknown, value: unknown): string;
  getRequest(requestId: unknown, operation: unknown): RequestRecord | null;
  commitRequest(input: unknown, changedAgents?: DynamicRecord[]): CommitResult<RequestRecord>;
  saveRecovery(snapshot: SnapshotRecord, records?: AttemptRecord[]): void;
  recordAttempt(record: AttemptRecord): AttemptRecord;
  listAttempts(runId?: unknown): AttemptRecord[];
  prepareEffect(input: unknown): EffectDisposition;
  resolveEffect(effectKey: unknown, status: string, result: unknown): EffectRecord;
  getEffect(effectKey: unknown): EffectRecord | null;
  listEffects(executionEpoch: unknown, statuses?: string[]): EffectRecord[];
  appendTreeContextEvent(input: TreeContextEventInput, options?: TreeContextCommitOptions): TreeContextCommit;
  listTreeContextEvents(rootRunId: unknown, afterRevision?: unknown, limit?: unknown): TreeContextEvent[];
  getTreeContextSnapshot(rootRunId: unknown): TreeContextSnapshot | null;
  saveTreeContextSnapshot(snapshot: TreeContextSnapshot): TreeContextSnapshot;
  getAgentContextCursor(rootRunId: unknown, agentId: unknown): AgentContextCursor | null;
  saveAgentContextCursor(cursor: AgentContextCursor): AgentContextCursor;
  close(): void;
}

type StoreInitialization = {
  revision: number;
  migration: string;
};

const STATE_DB_NAME = "operit_collaboration.db";
export const LEGACY_SCHEMA_VERSION = 1;
const EVENT_STORE_SCHEMA_V2 = 2;
const EVENT_STORE_SCHEMA_V3 = 3;
export const STATE_SCHEMA_VERSION = 4;
const MAX_LOADED_EVENTS = 300;
const MAX_LOADED_EXECUTIONS = 30;
const MAX_TREE_CONTEXT_EVENT_LIMIT = 500;
const MAX_TREE_CONTEXT_SNAPSHOT_EVENTS = 80;
const SQLITE_BATCH_SIZE = 500;

const SCHEMA_SQL = [
  [
    "CREATE TABLE IF NOT EXISTS collaboration_meta (",
    "meta_key TEXT PRIMARY KEY,",
    "meta_value TEXT NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS agents (",
    "agent_id TEXT PRIMARY KEY,",
    "parent_agent_id TEXT NOT NULL,",
    "status TEXT NOT NULL,",
    "run_seq INTEGER NOT NULL,",
    "current_run_id TEXT NOT NULL,",
    "state_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS runs (",
    "run_id TEXT PRIMARY KEY,",
    "agent_id TEXT NOT NULL,",
    "run_seq INTEGER NOT NULL,",
    "attempt INTEGER NOT NULL,",
    "execution_epoch TEXT NOT NULL UNIQUE,",
    "status TEXT NOT NULL,",
    "state_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "started_at INTEGER NOT NULL,",
    "completed_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS run_attempts (",
    "attempt_id TEXT PRIMARY KEY,",
    "run_id TEXT NOT NULL,",
    "agent_id TEXT NOT NULL,",
    "run_seq INTEGER NOT NULL,",
    "attempt INTEGER NOT NULL,",
    "execution_epoch TEXT NOT NULL UNIQUE,",
    "status TEXT NOT NULL,",
    "attempt_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "started_at INTEGER NOT NULL,",
    "completed_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS messages (",
    "message_id TEXT PRIMARY KEY,",
    "agent_id TEXT NOT NULL,",
    "status TEXT NOT NULL,",
    "acknowledged INTEGER NOT NULL,",
    "delivery_attempts INTEGER NOT NULL,",
    "state_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS events (",
    "event_id TEXT PRIMARY KEY,",
    "agent_id TEXT NOT NULL,",
    "run_id TEXT NOT NULL,",
    "run_seq INTEGER NOT NULL,",
    "event_type TEXT NOT NULL,",
    "payload_json TEXT NOT NULL,",
    "event_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS checkpoints (",
    "checkpoint_id TEXT PRIMARY KEY,",
    "run_id TEXT NOT NULL,",
    "agent_id TEXT NOT NULL,",
    "step INTEGER NOT NULL,",
    "checkpoint_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS path_claims (",
    "claim_id TEXT PRIMARY KEY,",
    "agent_id TEXT NOT NULL,",
    "path TEXT NOT NULL,",
    "claim_mode TEXT NOT NULL,",
    "active INTEGER NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS request_ledger (",
    "request_key TEXT PRIMARY KEY,",
    "request_id TEXT NOT NULL,",
    "operation TEXT NOT NULL,",
    "fingerprint TEXT NOT NULL,",
    "status TEXT NOT NULL,",
    "result_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS side_effects (",
    "effect_key TEXT PRIMARY KEY,",
    "execution_epoch TEXT NOT NULL,",
    "checkpoint_step INTEGER NOT NULL,",
    "operation TEXT NOT NULL,",
    "request_hash TEXT NOT NULL,",
    "status TEXT NOT NULL,",
    "result_json TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS tree_context_events (",
    "event_id TEXT PRIMARY KEY,",
    "root_run_id TEXT NOT NULL,",
    "revision INTEGER NOT NULL,",
    "source_agent_id TEXT NOT NULL,",
    "source_run_id TEXT NOT NULL,",
    "source_epoch TEXT NOT NULL,",
    "event_kind TEXT NOT NULL,",
    "visibility TEXT NOT NULL,",
    "idempotency_key TEXT,",
    "event_json TEXT NOT NULL,",
    "committed_at INTEGER NOT NULL,",
    "UNIQUE(root_run_id, idempotency_key)",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS tree_context_snapshots (",
    "root_run_id TEXT PRIMARY KEY,",
    "revision INTEGER NOT NULL,",
    "snapshot_json TEXT NOT NULL,",
    "updated_at INTEGER NOT NULL",
    ")",
  ].join(" "),
  [
    "CREATE TABLE IF NOT EXISTS agent_context_cursors (",
    "root_run_id TEXT NOT NULL,",
    "agent_id TEXT NOT NULL,",
    "last_applied_revision INTEGER NOT NULL,",
    "dirty_revision INTEGER NOT NULL,",
    "cursor_json TEXT NOT NULL,",
    "updated_at INTEGER NOT NULL,",
    "PRIMARY KEY(root_run_id, agent_id)",
    ")",
  ].join(" "),
  "CREATE INDEX IF NOT EXISTS idx_runs_agent_seq ON runs(agent_id, run_seq)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_run_attempt ON run_attempts(run_id, attempt)",
  "CREATE INDEX IF NOT EXISTS idx_messages_agent_created ON messages(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_agent_created ON events(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_checkpoints_run_step ON checkpoints(run_id, step)",
  "CREATE INDEX IF NOT EXISTS idx_path_claims_active_path ON path_claims(active, path)",
  "CREATE INDEX IF NOT EXISTS idx_request_ledger_id ON request_ledger(request_id, operation)",
  "CREATE INDEX IF NOT EXISTS idx_tree_context_root_revision ON tree_context_events(root_run_id, revision)",
  "CREATE INDEX IF NOT EXISTS idx_tree_context_source_run ON tree_context_events(source_run_id, revision)",
  "CREATE INDEX IF NOT EXISTS idx_agent_context_cursor_agent ON agent_context_cursors(agent_id, root_run_id)",
];

function cloneSnapshot<T>(snapshot: T): T;
function cloneSnapshot<T>(snapshot: T | null | undefined): T | null;
function cloneSnapshot<T>(snapshot: T | null | undefined): T | null {
  return snapshot ? JSON.parse(JSON.stringify(snapshot)) as T : null;
}

function asRecord(value: unknown): DynamicRecord {
  return value !== null && typeof value === "object" ? value as DynamicRecord : {};
}

function requestResultReferencesAgentIds(
  value: unknown,
  agentIds: Set<string>,
  key: string = "",
): boolean {
  if (Array.isArray(value)) {
    return value.some((item: unknown) => requestResultReferencesAgentIds(item, agentIds, key));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && agentIds.has(value) && [
      "id",
      "agent_id",
      "parent_agent_id",
      "root_agent_id",
    ].includes(key);
  }
  return Object.entries(value).some(([childKey, childValue]: [string, unknown]) =>
    requestResultReferencesAgentIds(childValue, agentIds, childKey)
  );
}

function normalizeEffectRequest(input: unknown): EffectRequest {
  const record = asRecord(input);
  if (Object.keys(record).length === 0) throw new Error("effect request must be an object");
  const executionEpoch = String(record.execution_epoch || record.executionEpoch || "").trim();
  const checkpointStep = Math.max(0, Math.floor(Number(record.checkpoint_step ?? record.checkpointStep) || 0));
  const operation = String(record.operation || "").trim();
  const requestHash = String(record.request_hash || record.requestHash || "").trim();
  if (!executionEpoch) throw new Error("effect execution_epoch is required");
  if (!operation) throw new Error("effect operation is required");
  if (!requestHash) throw new Error("effect request_hash is required");
  return {
    effectKey: String(record.effect_key || record.effectKey ||
      `${executionEpoch}:${checkpointStep}:${operation}:${requestHash}`).trim(),
    executionEpoch,
    checkpointStep,
    operation,
    requestHash,
  };
}

function normalizeRequestRecord(input: unknown): RequestRecord {
  const record = asRecord(input);
  if (Object.keys(record).length === 0) throw new Error("request record must be an object");
  const requestId = String(record.requestId || record.request_id || "").trim();
  const operation = String(record.operation || "").trim();
  const fingerprint = String(record.fingerprint || "");
  if (!requestId) throw new Error("request_id is required");
  if (requestId.length > 200) throw new Error("request_id must be at most 200 characters");
  if (!operation) throw new Error("request operation is required");
  if (!fingerprint) throw new Error("request fingerprint is required");
  const timestamp = now();
  return {
    requestKey: `${operation}:${requestId}`,
    requestId,
    operation,
    fingerprint,
    status: "committed",
    result: cloneSnapshot(record.result),
    createdAt: Number(record.createdAt) || timestamp,
    updatedAt: timestamp,
  };
}

const TREE_CONTEXT_KINDS = new Set<TreeContextEventKind>([
  "fact",
  "decision",
  "constraint",
  "artifact",
  "message",
  "tool_result",
  "checkpoint",
]);
const TREE_CONTEXT_VISIBILITIES = new Set<TreeContextVisibility>(["tree", "parent", "children", "agent"]);

function normalizeTreeContextEventInput(input: TreeContextEventInput): TreeContextEventInput {
  const record = asRecord(input);
  const rootRunId = String(record.rootRunId || "").trim();
  const sourceAgentId = String(record.sourceAgentId || "").trim();
  const sourceRunId = String(record.sourceRunId || "").trim();
  const sourceEpoch = String(record.sourceEpoch || "").trim();
  const kind = String(record.kind || "").trim() as TreeContextEventKind;
  const visibility = String(record.visibility || "tree").trim() as TreeContextVisibility;
  if (!rootRunId) throw new Error("tree context rootRunId is required");
  if (!sourceAgentId) throw new Error("tree context sourceAgentId is required");
  if (!sourceRunId) throw new Error("tree context sourceRunId is required");
  if (!sourceEpoch) throw new Error("tree context sourceEpoch is required");
  if (!TREE_CONTEXT_KINDS.has(kind)) throw new Error(`invalid tree context kind: ${kind}`);
  if (!TREE_CONTEXT_VISIBILITIES.has(visibility)) throw new Error(`invalid tree context visibility: ${visibility}`);
  return {
    eventId: String(record.eventId || "").trim() || createId("tree_context"),
    rootRunId,
    sourceAgentId,
    sourceRunId,
    sourceEpoch,
    kind,
    visibility,
    payload: cloneSnapshot(record.payload),
    idempotencyKey: String(record.idempotencyKey || "").trim(),
    committedAt: Number(record.committedAt) || now(),
  };
}

function treeContextEventFingerprint(event: TreeContextEvent | TreeContextEventInput): string {
  return JSON.stringify({
    rootRunId: event.rootRunId,
    sourceAgentId: event.sourceAgentId,
    sourceRunId: event.sourceRunId,
    sourceEpoch: event.sourceEpoch,
    kind: event.kind,
    visibility: event.visibility || "tree",
    payload: event.payload,
    idempotencyKey: event.idempotencyKey || "",
  });
}

function assertMatchingTreeContextEvent(existing: TreeContextEvent, incoming: TreeContextEventInput): void {
  if (treeContextEventFingerprint(existing) !== treeContextEventFingerprint(incoming)) {
    throw new Error(`tree context idempotency collision: ${incoming.idempotencyKey || incoming.eventId}`);
  }
}

function normalizeTreeContextSnapshot(value: TreeContextSnapshot): TreeContextSnapshot {
  const record = asRecord(value);
  const rootRunId = String(record.rootRunId || "").trim();
  if (!rootRunId) throw new Error("tree context snapshot rootRunId is required");
  const events = (Array.isArray(record.events) ? record.events : []).map((event) => {
    if (!event || typeof event !== "object") throw new Error("tree context snapshot contains an invalid event");
    const treeEvent = event as TreeContextEvent;
    if (String(treeEvent.rootRunId || "").trim() !== rootRunId) {
      throw new Error("tree context snapshot event rootRunId does not match snapshot rootRunId");
    }
    return cloneSnapshot(treeEvent);
  });
  return {
    rootRunId,
    revision: Math.max(0, Math.floor(Number(record.revision) || 0)),
    events,
    truncated: record.truncated === true,
    updatedAt: Number(record.updatedAt) || now(),
  };
}

function normalizeAgentContextCursor(value: AgentContextCursor): AgentContextCursor {
  const record = asRecord(value);
  const rootRunId = String(record.rootRunId || "").trim();
  const agentId = String(record.agentId || "").trim();
  if (!rootRunId) throw new Error("agent context cursor rootRunId is required");
  if (!agentId) throw new Error("agent context cursor agentId is required");
  const lastAppliedRevision = Math.max(0, Math.floor(Number(record.lastAppliedRevision) || 0));
  return {
    rootRunId,
    agentId,
    lastAppliedRevision,
    dirtyRevision: Math.max(lastAppliedRevision, Math.floor(Number(record.dirtyRevision) || 0)),
    updatedAt: Number(record.updatedAt) || now(),
  };
}

function mergeAgentContextCursor(
  existing: AgentContextCursor | null | undefined,
  incoming: AgentContextCursor,
): AgentContextCursor {
  if (!existing) return cloneSnapshot(incoming);
  return {
    ...incoming,
    lastAppliedRevision: Math.max(existing.lastAppliedRevision, incoming.lastAppliedRevision),
    dirtyRevision: Math.max(existing.dirtyRevision, incoming.dirtyRevision),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function stampTreeContextRevision(
  changedAgents: DynamicRecord[],
  input: TreeContextEventInput,
  revision: number,
): DynamicRecord | null {
  if (input.kind !== "checkpoint") return null;
  const step = Math.max(0, Math.floor(Number(asRecord(input.payload).step) || 0));
  for (const agent of changedAgents) {
    for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
      if (!execution || execution.id !== input.sourceRunId) continue;
      const checkpoint = (Array.isArray(execution.checkpoints) ? execution.checkpoints : [])
        .find((candidate: DynamicRecord) => candidate && Number(candidate.step) === step);
      if (checkpoint) {
        return { ...checkpoint, treeContextRevision: revision };
      }
    }
  }
  return null;
}

function applyStampedCheckpoint(
  changedAgents: DynamicRecord[],
  sourceRunId: string,
  stampedCheckpoint: DynamicRecord | null,
): void {
  if (!stampedCheckpoint) return;
  for (const agent of changedAgents) {
    for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
      if (!execution || execution.id !== sourceRunId) continue;
      const checkpoint = (Array.isArray(execution.checkpoints) ? execution.checkpoints : [])
        .find((candidate: DynamicRecord) => candidate && Number(candidate.step) === Number(stampedCheckpoint.step));
      if (checkpoint) Object.assign(checkpoint, stampedCheckpoint);
    }
  }
}

function treeContextSnapshotForCommit(
  prior: TreeContextSnapshot | null | undefined,
  provided: TreeContextSnapshot | null | undefined,
  event: TreeContextEvent,
): TreeContextSnapshot {
  if (provided && provided.rootRunId !== event.rootRunId) {
    throw new Error("tree context snapshot rootRunId does not match event rootRunId");
  }
  const byId = new Map<string, TreeContextEvent>();
  for (const candidate of [...(prior?.events || []), ...(provided?.events || []), event]) {
    if (candidate.rootRunId !== event.rootRunId) {
      throw new Error("tree context snapshot event rootRunId does not match event rootRunId");
    }
    const existing = byId.get(candidate.eventId);
    if (existing && treeContextEventFingerprint(existing) !== treeContextEventFingerprint(candidate)) {
      throw new Error(`tree context event collision in snapshot: ${candidate.eventId}`);
    }
    byId.set(candidate.eventId, cloneSnapshot(candidate));
  }
  const allEvents = Array.from(byId.values())
    .sort((left, right) => left.revision - right.revision || left.eventId.localeCompare(right.eventId));
  return {
    rootRunId: event.rootRunId,
    revision: event.revision,
    events: allEvents.slice(-MAX_TREE_CONTEXT_SNAPSHOT_EVENTS),
    truncated: prior?.truncated === true || provided?.truncated === true ||
      allEvents.length > MAX_TREE_CONTEXT_SNAPSHOT_EVENTS,
    updatedAt: event.committedAt,
  };
}

export function memoryStore(
  reason: string = "",
  initialSnapshot: SnapshotRecord | null = null,
  migration: string = "",
): CollaborationStore {
  let current: SnapshotRecord = cloneSnapshot(initialSnapshot) || {
    schema_version: STATE_SCHEMA_VERSION,
    saved_at: now(),
    agents: [],
  };
  let revision = Number(current.revision) || 0;
  const attempts = new Map<string, AttemptRecord>();
  const effects = new Map<string, EffectRecord>();
  const requests = new Map<string, RequestRecord>();
  const meta = new Map<string, string>();
  const treeContextEvents = new Map<string, TreeContextEvent>();
  const treeContextIdempotency = new Map<string, string>();
  const treeContextSnapshots = new Map<string, TreeContextSnapshot>();
  const agentContextCursors = new Map<string, AgentContextCursor>();

  function projectAttempts(
    snapshot: SnapshotRecord,
    target: Map<string, AttemptRecord> = attempts,
  ): void {
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    for (const agent of agents) {
      const executions = Array.isArray(agent.executions) ? agent.executions : [];
      for (const execution of executions) {
        if (!execution || !execution.id) continue;
        const record = attemptRecord(execution);
        target.set(record.attemptId, cloneSnapshot(record));
      }
    }
  }

  function ownerForEpoch(executionEpoch: unknown): EffectOwner {
    const epoch = String(executionEpoch || "").trim();
    const owner = Array.from(attempts.values()).find((record: AttemptRecord) => record.executionEpoch === epoch);
    if (!owner) throw new Error(`effect execution epoch not found: ${epoch}`);
    return owner;
  }

  function assertMemorySnapshotNotStale(snapshot: SnapshotRecord): void {
    const currentAgents = new Map<string, DynamicRecord>(
      (Array.isArray(current.agents) ? current.agents : [])
        .filter((agent: DynamicRecord) => agent && agent.id)
        .map((agent: DynamicRecord) => [String(agent.id), agent])
    );
    for (const agent of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
      const storedAgent = currentAgents.get(String(agent && agent.id || ""));
      if (!storedAgent) continue;
      const storedRunSeq = Number(storedAgent.runSeq) || 0;
      const incomingRunSeq = Number(agent.runSeq) || 0;
      if (storedRunSeq > incomingRunSeq) {
        throw new Error(`stale agent projection for ${agent.id}: stored run_seq ${storedRunSeq}, incoming ${incomingRunSeq}`);
      }
      if (storedRunSeq === incomingRunSeq && storedAgent.currentExecutionId && agent.currentExecutionId &&
          storedAgent.currentExecutionId !== agent.currentExecutionId) {
        throw new Error(`stale agent projection for ${agent.id}: current run changed`);
      }
      if (storedRunSeq === incomingRunSeq && isTerminalStatus(storedAgent.status) &&
          storedAgent.status !== String(agent.status || "")) {
        throw new Error(`stale agent projection for ${agent.id}: stored terminal status ${storedAgent.status}`);
      }
      const storedRuns = new Map<string, DynamicRecord>(
        (Array.isArray(storedAgent.executions) ? storedAgent.executions : [])
          .filter((execution: DynamicRecord) => execution && execution.id)
          .map((execution: DynamicRecord) => [String(execution.id), execution])
      );
      for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
        const storedRun = storedRuns.get(String(execution && execution.id || ""));
        if (!storedRun) continue;
        const storedAttempt = Number(storedRun.attempt) || 1;
        const incomingAttempt = Number(execution.attempt) || 1;
        if (storedAttempt > incomingAttempt) {
          throw new Error(`stale run projection for ${execution.id}: stored attempt ${storedAttempt}, incoming ${incomingAttempt}`);
        }
        if (storedAttempt === incomingAttempt && String(storedRun.epoch || "") !== String(execution.epoch || "")) {
          throw new Error(`stale run projection for ${execution.id}: execution epoch changed`);
        }
        if (storedAttempt === incomingAttempt && isTerminalStatus(storedRun.status) &&
            storedRun.status !== String(execution.status || "")) {
          throw new Error(`stale run projection for ${execution.id}: stored terminal status ${storedRun.status}`);
        }
      }
    }
  }

  function appendEffectEvent(
    owner: EffectOwner,
    effect: EffectRecord,
    type: string,
    nextRevision: number,
    extra: DynamicRecord = {},
  ): void {
    const agent = Array.isArray(current.agents)
      ? current.agents.find((item: DynamicRecord) => item && item.id === owner.agentId)
      : null;
    if (!agent) throw new Error(`effect owner agent not found: ${owner.agentId}`);
    const createdAt = now();
    const data = {
      effect_key: effect.effectKey,
      execution_epoch: effect.executionEpoch,
      checkpoint_step: effect.checkpointStep,
      operation: effect.operation,
      request_hash: effect.requestHash,
      status: effect.status,
      ...extra,
    };
    const events: DynamicRecord[] = Array.isArray(agent.events) ? agent.events : [];
    if (!Array.isArray(agent.events)) agent.events = events;
    events.push({
      id: `effect:${effect.effectKey}:${type}:${nextRevision}`,
      type,
      agent_id: owner.agentId,
      execution_id: owner.runId,
      run_seq: owner.runSeq,
      created_at: createdAt,
      data,
    });
    if (events.length > MAX_LOADED_EVENTS) {
      events.splice(0, events.length - MAX_LOADED_EVENTS);
    }
    agent.updatedAt = createdAt;
  }

  projectAttempts(current);
  return {
    mode: "memory",
    reason,
    migration,
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceModel: "event_store",
    get revision() {
      return revision;
    },
    load() {
      return cloneSnapshot(current);
    },
    save(snapshot) {
      assertMemorySnapshotNotStale(snapshot);
      current = cloneSnapshot(snapshot);
      projectAttempts(current);
      revision += 1;
    },
    saveAgent(agent) {
      return this.saveAgents([agent]);
    },
    saveAgents(changedAgents) {
      const incoming = (Array.isArray(changedAgents) ? changedAgents : []).filter((agent) => agent && agent.id);
      if (incoming.length === 0) return;
      const delta = { agents: incoming };
      assertMemorySnapshotNotStale(delta);
      const next = cloneSnapshot(current) || { schema_version: STATE_SCHEMA_VERSION, saved_at: now(), agents: [] };
      const replacements = new Map(incoming.map((agent) => [agent.id, cloneSnapshot(agent)]));
      next.agents = (Array.isArray(next.agents) ? next.agents : [])
        .filter((agent) => !replacements.has(agent.id));
      next.agents.push(...replacements.values());
      next.saved_at = now();
      current = next;
      projectAttempts(delta);
      revision += 1;
    },
    deleteAgents(agentIds) {
      const ids = new Set((Array.isArray(agentIds) ? agentIds : []).map((id) => String(id || "").trim()).filter(Boolean));
      if (ids.size === 0) return 0;
      const removed = (Array.isArray(current.agents) ? current.agents : [])
        .filter((agent) => agent && ids.has(String(agent.id || "")));
      if (removed.length === 0) return 0;
      const removedRunIds = new Set();
      const removedEpochs = new Set();
      for (const agent of removed) {
        for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
          if (execution && execution.id) removedRunIds.add(execution.id);
          if (execution && execution.epoch) removedEpochs.add(execution.epoch);
        }
      }
      current = cloneSnapshot(current) || { schema_version: STATE_SCHEMA_VERSION, saved_at: now(), agents: [] };
      current.agents = (Array.isArray(current.agents) ? current.agents : [])
        .filter((agent) => agent && !ids.has(String(agent.id || "")));
      current.saved_at = now();
      for (const [key, record] of attempts) {
        if (ids.has(record.agentId) || removedRunIds.has(record.runId)) attempts.delete(key);
      }
      for (const [key, effect] of effects) {
        if (removedEpochs.has(effect.executionEpoch)) effects.delete(key);
      }
      for (const [key, request] of requests) {
        if (requestResultReferencesAgentIds(request.result, ids)) requests.delete(key);
      }
      revision += 1;
      return removed.length;
    },
    getMeta(key) {
      return meta.get(String(key || "").trim()) || "";
    },
    setMeta(key, value) {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) throw new Error("meta key is required");
      meta.set(normalizedKey, String(value ?? ""));
      revision += 1;
      return meta.get(normalizedKey) || "";
    },
    getRequest(requestId, operation) {
      return cloneSnapshot(requests.get(`${String(operation || "").trim()}:${String(requestId || "").trim()}`) || null);
    },
    commitRequest(input, changedAgents = []) {
      const record = normalizeRequestRecord(input);
      const existing = requests.get(record.requestKey);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint) throw new Error(`request_id conflict: ${record.requestId}`);
        return { deduplicated: true, record: cloneSnapshot(existing) };
      }
      const incoming = (Array.isArray(changedAgents) ? changedAgents : []).filter((agent) => agent && agent.id);
      if (incoming.length > 0) this.saveAgents(incoming);
      else revision += 1;
      requests.set(record.requestKey, cloneSnapshot(record));
      return { deduplicated: false, record: cloneSnapshot(record) };
    },
    saveRecovery(snapshot, records = []) {
      assertMemorySnapshotNotStale(snapshot);
      const next = cloneSnapshot(snapshot);
      const nextAttempts = new Map(attempts);
      for (const record of records) {
        const value = cloneSnapshot(record);
        nextAttempts.set(value.attemptId, value);
      }
      projectAttempts(next, nextAttempts);
      current = next;
      attempts.clear();
      for (const [key, value] of nextAttempts) attempts.set(key, value);
      revision += 1;
    },
    recordAttempt(record) {
      const value = cloneSnapshot(record);
      attempts.set(value.attemptId, value);
      revision += 1;
      return cloneSnapshot(value);
    },
    listAttempts(runId) {
      return Array.from(attempts.values())
        .filter((item) => !runId || item.runId === runId)
        .sort((left, right) => left.attempt - right.attempt)
        .map((item): AttemptRecord => cloneSnapshot(item));

    },
    prepareEffect(input) {
      const request = normalizeEffectRequest(input);
      const existing = effects.get(request.effectKey);
      if (existing) {
        if (existing.executionEpoch !== request.executionEpoch || existing.operation !== request.operation ||
            existing.requestHash !== request.requestHash || existing.checkpointStep !== request.checkpointStep) {
          throw new Error(`effect key collision: ${request.effectKey}`);
        }
        if (existing.status === "committed") {
          const owner = ownerForEpoch(existing.executionEpoch);
          appendEffectEvent(owner, existing, "effect_reused", revision + 1);
          revision += 1;
          return { disposition: "reuse", effect: cloneSnapshot(existing) };
        }
        return { disposition: "blocked", effect: cloneSnapshot(existing) };
      }
      const owner = ownerForEpoch(request.executionEpoch);
      const timestamp = now();
      const effect = { ...request, status: "prepared", result: null, createdAt: timestamp, updatedAt: timestamp };
      effects.set(effect.effectKey, effect);
      appendEffectEvent(owner, effect, "effect_prepared", revision + 1);
      revision += 1;
      return { disposition: "execute", effect: cloneSnapshot(effect) };
    },
    resolveEffect(effectKey, status, result) {
      const key = String(effectKey || "").trim();
      const effect = effects.get(key);
      if (!effect) throw new Error(`effect not found: ${key}`);
      if (!["committed", "unknown", "failed"].includes(status)) throw new Error(`invalid effect status: ${status}`);
      if (effect.status === "committed" && status !== "committed") {
        throw new Error(`committed effect cannot transition to ${status}: ${key}`);
      }
      if (effect.status === "committed") return cloneSnapshot(effect);
      const owner = ownerForEpoch(effect.executionEpoch);
      effect.status = status;
      effect.result = cloneSnapshot(result);
      effect.updatedAt = now();
      appendEffectEvent(owner, effect, effectEventType(status), revision + 1);
      revision += 1;
      return cloneSnapshot(effect);
    },
    getEffect(effectKey) {
      return cloneSnapshot(effects.get(String(effectKey || "").trim()) || null);
    },
    listEffects(executionEpoch, statuses = []) {
      const epoch = String(executionEpoch || "").trim();
      const allowed = new Set((Array.isArray(statuses) ? statuses : []).map((status) => String(status || "").trim()));
      return Array.from(effects.values())
        .filter((effect) => !epoch || effect.executionEpoch === epoch)
        .filter((effect) => allowed.size === 0 || allowed.has(effect.status))
        .sort((left, right) => left.createdAt - right.createdAt || left.effectKey.localeCompare(right.effectKey))
        .map((effect): EffectRecord => cloneSnapshot(effect));
    },
    appendTreeContextEvent(input, options = {}) {
      const normalized = normalizeTreeContextEventInput(input);
      const changedAgents = (Array.isArray(options.changedAgents) ? options.changedAgents : [])
        .filter((agent) => agent && agent.id)
        .map((agent) => cloneSnapshot(agent));
      const idempotencyLookup = normalized.idempotencyKey
        ? treeContextIdempotency.get(`${normalized.rootRunId}:${normalized.idempotencyKey}`)
        : "";
      const existing = treeContextEvents.get(idempotencyLookup || normalized.eventId || "");
      if (existing) {
        assertMatchingTreeContextEvent(existing, normalized);
        return { deduplicated: true, event: cloneSnapshot(existing) };
      }
      const committedRevision = revision + 1;
      if (changedAgents.length > 0) {
        assertMemorySnapshotNotStale({ agents: changedAgents });
      }
      const event: TreeContextEvent = {
        eventId: normalized.eventId || createId("tree_context"),
        rootRunId: normalized.rootRunId,
        revision: committedRevision,
        sourceAgentId: normalized.sourceAgentId,
        sourceRunId: normalized.sourceRunId,
        sourceEpoch: normalized.sourceEpoch,
        kind: normalized.kind,
        visibility: normalized.visibility || "tree",
        payload: cloneSnapshot(normalized.payload),
        idempotencyKey: normalized.idempotencyKey || "",
        committedAt: normalized.committedAt || now(),
      };
      const priorSnapshot = treeContextSnapshots.get(event.rootRunId);
      const providedSnapshot = options.snapshot ? normalizeTreeContextSnapshot(options.snapshot) : null;
      const snapshot = treeContextSnapshotForCommit(priorSnapshot, providedSnapshot, event);
      const stagedCursors = new Map<string, AgentContextCursor>();
      for (const [key, cursor] of agentContextCursors) {
        if (cursor.rootRunId !== event.rootRunId) continue;
        stagedCursors.set(key, mergeAgentContextCursor(cursor, {
          ...cursor,
          dirtyRevision: event.revision,
          updatedAt: event.committedAt,
        }));
      }
      if (options.cursor) {
        const cursor = normalizeAgentContextCursor(options.cursor);
        if (cursor.rootRunId !== event.rootRunId) {
          throw new Error("agent context cursor rootRunId does not match event rootRunId");
        }
        const key = `${cursor.rootRunId}:${cursor.agentId}`;
        stagedCursors.set(key, mergeAgentContextCursor(stagedCursors.get(key) || agentContextCursors.get(key), {
          ...cursor,
          dirtyRevision: Math.max(cursor.dirtyRevision, event.revision),
          updatedAt: Math.max(cursor.updatedAt, event.committedAt),
        }));
      }
      const stampedCheckpoint = stampTreeContextRevision(changedAgents, normalized, committedRevision);
      applyStampedCheckpoint(changedAgents, normalized.sourceRunId, stampedCheckpoint);
      const nextCurrent = changedAgents.length > 0
        ? cloneSnapshot(current) || { schema_version: STATE_SCHEMA_VERSION, saved_at: now(), agents: [] }
        : null;
      if (nextCurrent) {
        const replacements = new Map(changedAgents.map((agent) => [agent.id, cloneSnapshot(agent)]));
        nextCurrent.agents = (Array.isArray(nextCurrent.agents) ? nextCurrent.agents : [])
          .filter((agent) => !replacements.has(agent.id));
        nextCurrent.agents.push(...replacements.values());
        nextCurrent.saved_at = now();
      }
      treeContextEvents.set(event.eventId, cloneSnapshot(event));
      if (event.idempotencyKey) {
        treeContextIdempotency.set(`${event.rootRunId}:${event.idempotencyKey}`, event.eventId);
      }
      treeContextSnapshots.set(event.rootRunId, cloneSnapshot(snapshot));
      for (const [key, cursor] of stagedCursors) agentContextCursors.set(key, cloneSnapshot(cursor));
      if (nextCurrent) {
        current = nextCurrent;
        projectAttempts({ agents: changedAgents });
      }
      revision = committedRevision;
      return {
        deduplicated: false,
        event: cloneSnapshot(event),
        checkpoint: cloneSnapshot(stampedCheckpoint),
      };
    },
    listTreeContextEvents(rootRunId, afterRevision = 0, limit = MAX_TREE_CONTEXT_EVENT_LIMIT) {
      const root = String(rootRunId || "").trim();
      if (!root) return [];
      const after = Math.max(0, Math.floor(Number(afterRevision) || 0));
      const boundedLimit = Math.max(1, Math.min(MAX_TREE_CONTEXT_EVENT_LIMIT, Math.floor(Number(limit) || MAX_TREE_CONTEXT_EVENT_LIMIT)));
      return Array.from(treeContextEvents.values())
        .filter((event) => event.rootRunId === root && event.revision > after)
        .sort((left, right) => left.revision - right.revision || left.eventId.localeCompare(right.eventId))
        .slice(0, boundedLimit)
        .map((event) => cloneSnapshot(event));
    },
    getTreeContextSnapshot(rootRunId) {
      return cloneSnapshot(treeContextSnapshots.get(String(rootRunId || "").trim()) || null);
    },
    saveTreeContextSnapshot(value) {
      const snapshot = normalizeTreeContextSnapshot(value);
      const existing = treeContextSnapshots.get(snapshot.rootRunId);
      if (existing && existing.revision > snapshot.revision) {
        throw new Error(`stale tree context snapshot for ${snapshot.rootRunId}`);
      }
      treeContextSnapshots.set(snapshot.rootRunId, cloneSnapshot(snapshot));
      revision += 1;
      return cloneSnapshot(snapshot);
    },
    getAgentContextCursor(rootRunId, agentId) {
      return cloneSnapshot(agentContextCursors.get(`${String(rootRunId || "").trim()}:${String(agentId || "").trim()}`) || null);
    },
    saveAgentContextCursor(value) {
      const cursor = normalizeAgentContextCursor(value);
      const key = `${cursor.rootRunId}:${cursor.agentId}`;
      const existing = agentContextCursors.get(key);
      const merged = mergeAgentContextCursor(existing, cursor);
      agentContextCursors.set(key, cloneSnapshot(merged));
      revision += 1;
      return cloneSnapshot(merged);
    },
    close() {},
  };
}

function requireDatabaseApi(db: unknown): asserts db is DynamicDatabase {
  const record = asRecord(db);
  for (const method of ["execSQL", "rawQuery", "beginTransaction", "setTransactionSuccessful", "endTransaction"]) {
    if (typeof record[method] !== "function") {
      throw new Error(`SQLite database does not expose ${method}`);
    }
  }
}

function withTransaction<T>(db: DynamicDatabase, action: () => T): T {
  db.beginTransaction();
  try {
    const result = action();
    db.setTransactionSuccessful();
    return result;
  } finally {
    db.endTransaction();
  }
}

function queryRows(db: DynamicDatabase, sql: string, columns: string[]): string[][] {
  let cursor: SQLiteCursor | null = null;
  try {
    cursor = db.rawQuery(sql, null);
    const rows: string[][] = [];
    if (!cursor.moveToFirst()) return rows;
    do {
      rows.push(columns.map((_column: string, index: number) => String(cursor!.getString(index) ?? "")));
    } while (typeof cursor.moveToNext === "function" && cursor.moveToNext());
    return rows;
  } finally {
    if (cursor) {
      try {
        cursor.close();
      } catch (_) {}
    }
  }
}

function valueBatches(values: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += SQLITE_BATCH_SIZE) {
    batches.push(values.slice(index, index + SQLITE_BATCH_SIZE));
  }
  return batches;
}

function queryColumnInBatches(
  db: DynamicDatabase,
  table: string,
  selectedColumn: string,
  filterColumn: string,
  values: string[],
): string[] {
  const rows: string[] = [];
  for (const batch of valueBatches(values)) {
    rows.push(...queryRows(
      db,
      `SELECT ${selectedColumn} FROM ${table} WHERE ${filterColumn} IN (${batch.map(sqliteLiteral).join(", ")})`,
      [selectedColumn]
    ).map(([value]: string[]) => value));
  }
  return rows;
}

function deleteInBatches(db: DynamicDatabase, table: string, column: string, values: string[]): void {
  for (const batch of valueBatches(values)) {
    db.execSQL(`DELETE FROM ${table} WHERE ${column} IN (${batch.map(sqliteLiteral).join(", ")})`);
  }
}

function readJsonRow<T extends DynamicRecord>(db: DynamicDatabase, sql: string, label: string): T | null {
  const rows = queryRows(db, sql, ["json"]);
  return rows.length > 0 ? parseJsonRow<T>(rows[0][0], label) : null;
}

function readTreeContextEvent(
  db: DynamicDatabase,
  rootRunId: string,
  eventId: string,
  idempotencyKey: string,
): TreeContextEvent | null {
  const clauses = [`root_run_id = ${sqliteLiteral(rootRunId)}`];
  if (idempotencyKey) clauses.push(`idempotency_key = ${sqliteLiteral(idempotencyKey)}`);
  else clauses.push(`event_id = ${sqliteLiteral(eventId)}`);
  return readJsonRow<TreeContextEvent>(
    db,
    `SELECT event_json FROM tree_context_events WHERE ${clauses.join(" AND ")} LIMIT 1`,
    "tree context event"
  );
}

function writeTreeContextSnapshot(
  db: DynamicDatabase,
  value: TreeContextSnapshot,
): TreeContextSnapshot {
  const snapshot = normalizeTreeContextSnapshot(value);
  const existing = queryRows(
    db,
    `SELECT revision FROM tree_context_snapshots WHERE root_run_id = ${sqliteLiteral(snapshot.rootRunId)}`,
    ["revision"]
  );
  if (existing.length > 0 && Number(existing[0][0]) > snapshot.revision) {
    throw new Error(`stale tree context snapshot for ${snapshot.rootRunId}`);
  }
  db.execSQL(
    `INSERT OR REPLACE INTO tree_context_snapshots (` +
    `root_run_id, revision, snapshot_json, updated_at) VALUES (` +
    `${sqliteLiteral(snapshot.rootRunId)}, ${snapshot.revision}, ${sqliteLiteral(JSON.stringify(snapshot))}, ` +
    `${snapshot.updatedAt})`
  );
  return snapshot;
}

function writeAgentContextCursor(
  db: DynamicDatabase,
  value: AgentContextCursor,
): AgentContextCursor {
  const cursor = normalizeAgentContextCursor(value);
  const existing = readJsonRow<AgentContextCursor>(
    db,
    `SELECT cursor_json FROM agent_context_cursors WHERE root_run_id = ${sqliteLiteral(cursor.rootRunId)} ` +
    `AND agent_id = ${sqliteLiteral(cursor.agentId)}`,
    "agent context cursor"
  );
  const merged = mergeAgentContextCursor(existing, cursor);
  db.execSQL(
    `INSERT OR REPLACE INTO agent_context_cursors (` +
    `root_run_id, agent_id, last_applied_revision, dirty_revision, cursor_json, updated_at) VALUES (` +
    `${sqliteLiteral(merged.rootRunId)}, ${sqliteLiteral(merged.agentId)}, ${merged.lastAppliedRevision}, ` +
    `${merged.dirtyRevision}, ${sqliteLiteral(JSON.stringify(merged))}, ${merged.updatedAt})`
  );
  return merged;
}

function queryMeta(db: DynamicDatabase, key: unknown): string {
  const rows = queryRows(
    db,
    `SELECT meta_value FROM collaboration_meta WHERE meta_key = ${sqliteLiteral(key)}`,
    ["meta_value"]
  );
  return rows.length > 0 ? rows[0][0] : "";
}

function writeMeta(
  db: DynamicDatabase,
  key: unknown,
  value: unknown,
  timestamp: number = now(),
): void {
  db.execSQL(
    `INSERT OR REPLACE INTO collaboration_meta (meta_key, meta_value, updated_at) VALUES (` +
    `${sqliteLiteral(key)}, ${sqliteLiteral(value)}, ${timestamp})`
  );
}

function effectEventType(status: unknown): string {
  if (status === "committed") return "effect_committed";
  if (status === "unknown") return "effect_state_unknown";
  if (status === "failed") return "effect_failed";
  return "effect_prepared";
}

function requireEffectOwner(db: DynamicDatabase, executionEpoch: unknown): string[] {
  const rows = queryRows(
    db,
    `SELECT run_id, agent_id, run_seq FROM run_attempts WHERE execution_epoch = ${sqliteLiteral(executionEpoch)}`,
    ["run_id", "agent_id", "run_seq"]
  );
  if (rows.length === 0) throw new Error(`effect execution epoch not found: ${executionEpoch}`);
  return rows[0];
}

function writeEffectEvent(
  db: DynamicDatabase,
  effect: EffectRecord,
  type: string,
  revision: number,
  extra: DynamicRecord = {},
): void {
  const [runId, agentId, runSeq] = requireEffectOwner(db, effect.executionEpoch);
  const createdAt = now();
  const data = {
    effect_key: effect.effectKey,
    execution_epoch: effect.executionEpoch,
    checkpoint_step: effect.checkpointStep,
    operation: effect.operation,
    request_hash: effect.requestHash,
    status: effect.status,
    ...extra,
  };
  const event = {
    id: `effect:${effect.effectKey}:${type}:${revision}`,
    type,
    agent_id: agentId,
    execution_id: runId,
    run_seq: Number(runSeq) || 0,
    created_at: createdAt,
    data,
  };
  db.execSQL(
    `INSERT OR IGNORE INTO events (` +
    `event_id, agent_id, run_id, run_seq, event_type, payload_json, event_json, revision, created_at` +
    `) VALUES (` +
    `${sqliteLiteral(event.id)}, ${sqliteLiteral(agentId)}, ${sqliteLiteral(runId)}, ${Number(runSeq) || 0}, ` +
    `${sqliteLiteral(type)}, ${sqliteLiteral(JSON.stringify(data))}, ${sqliteLiteral(JSON.stringify(event))}, ` +
    `${revision}, ${createdAt})`
  );
}

function markPreparedEffectsUnknown(db: DynamicDatabase, revision: number): number {
  const rows = queryRows(
    db,
    "SELECT effect_key, result_json FROM side_effects WHERE status = 'prepared' ORDER BY effect_key",
    ["effect_key", "result_json"]
  );
  const timestamp = now();
  for (const [effectKey, json] of rows) {
    const effect = parseJsonRow<EffectRecord>(json, "prepared side effect");
    effect.status = "unknown";
    effect.updatedAt = timestamp;
    db.execSQL(
      `UPDATE side_effects SET status = 'unknown', result_json = ${sqliteLiteral(JSON.stringify(effect))}, ` +
      `revision = ${revision}, updated_at = ${timestamp} WHERE effect_key = ${sqliteLiteral(effectKey)}`
    );
    writeEffectEvent(db, effect, "effect_state_unknown", revision, { reason: "runtime_restarted_after_prepare" });
  }
  return rows.length;
}

function readLegacySnapshot(db: DynamicDatabase): SnapshotRecord | null {
  let rows: string[][];
  try {
    rows = queryRows(
      db,
      "SELECT schema_version, snapshot_json FROM collaboration_snapshot WHERE snapshot_id = 1",
      ["schema_version", "snapshot_json"]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|does not exist/i.test(message)) return null;
    throw error;
  }
  if (rows.length === 0) return null;
  const schemaVersion = Number(rows[0][0]);
  if (schemaVersion !== LEGACY_SCHEMA_VERSION) {
    throw new Error(`unsupported legacy collaboration snapshot schema: ${rows[0][0]}`);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(rows[0][1]);
  } catch (error) {
    throw new Error(`legacy collaboration snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(snapshot);
  if (!Array.isArray(record.agents)) {
    throw new Error("legacy collaboration snapshot does not contain an agents array");
  }
  return record as SnapshotRecord;
}

function withoutKeys(value: DynamicRecord, keys: string[]): DynamicRecord {
  const output = { ...value };
  for (const key of keys) delete output[key];
  return output;
}

function isTerminalStatus(status: unknown): boolean {
  return [
    "completed",
    "failed",
    "interrupted",
    "interrupted_with_late_result",
    "timed_out",
    "orphaned",
  ].includes(String(status || ""));
}

function attemptRecord(execution: DynamicRecord, overrides: DynamicRecord = {}): AttemptRecord {
  const attempt = Number(execution && execution.attempt) || 1;
  const epoch = String(overrides.executionEpoch || (execution && execution.epoch) || "");
  return {
    attemptId: String(overrides.attemptId || `${execution.id}:${attempt}`),
    runId: String(execution.id || ""),
    agentId: String(execution.agentId || ""),
    runSeq: Number(execution.seq) || 0,
    attempt,
    executionEpoch: epoch,
    status: String(overrides.status || execution.status || "queued"),
    recoveryReason: String(overrides.recoveryReason || execution.recoveryReason || ""),
    contextReplayed: overrides.contextReplayed === true || execution.contextReplayed === true,
    createdAt: Number(overrides.createdAt || execution.attemptCreatedAt || execution.createdAt) || now(),
    startedAt: Number(overrides.startedAt ?? execution.startedAt) || 0,
    completedAt: Number(overrides.completedAt ?? execution.completedAt) || 0,
  };
}

function writeAttemptRecord(
  db: DynamicDatabase,
  record: AttemptRecord,
  revision: number,
): AttemptRecord {
  db.execSQL(
    `INSERT OR REPLACE INTO run_attempts (` +
    `attempt_id, run_id, agent_id, run_seq, attempt, execution_epoch, status, attempt_json, revision, ` +
    `created_at, started_at, completed_at) VALUES (` +
    `${sqliteLiteral(record.attemptId)}, ${sqliteLiteral(record.runId)}, ${sqliteLiteral(record.agentId)}, ` +
    `${Number(record.runSeq) || 0}, ${Number(record.attempt) || 1}, ${sqliteLiteral(record.executionEpoch)}, ` +
    `${sqliteLiteral(record.status)}, ${sqliteLiteral(JSON.stringify(record))}, ${revision}, ` +
    `${Number(record.createdAt) || now()}, ${Number(record.startedAt) || 0}, ${Number(record.completedAt) || 0})`
  );
  return record;
}

function writeAttemptProjection(
  db: DynamicDatabase,
  execution: DynamicRecord,
  revision: number,
  overrides: DynamicRecord = {},
): AttemptRecord {
  return writeAttemptRecord(db, attemptRecord(execution, overrides), revision);
}

function assertSnapshotNotStale(db: DynamicDatabase, agents: DynamicRecord[]): void {
  for (const agent of agents) {
    if (!agent || !agent.id) continue;
    const storedAgent = queryRows(
      db,
      `SELECT run_seq, current_run_id, status FROM agents WHERE agent_id = ${sqliteLiteral(agent.id)}`,
      ["run_seq", "current_run_id", "status"]
    );
    if (storedAgent.length > 0) {
      const storedRunSeq = Number(storedAgent[0][0]) || 0;
      const incomingRunSeq = Number(agent.runSeq) || 0;
      if (storedRunSeq > incomingRunSeq) {
        throw new Error(`stale agent projection for ${agent.id}: stored run_seq ${storedRunSeq}, incoming ${incomingRunSeq}`);
      }
      if (storedRunSeq === incomingRunSeq && storedAgent[0][1] && agent.currentExecutionId &&
          storedAgent[0][1] !== agent.currentExecutionId) {
        throw new Error(`stale agent projection for ${agent.id}: current run changed`);
      }
      if (storedRunSeq === incomingRunSeq && isTerminalStatus(storedAgent[0][2]) &&
          storedAgent[0][2] !== String(agent.status || "")) {
        throw new Error(`stale agent projection for ${agent.id}: stored terminal status ${storedAgent[0][2]}`);
      }
    }
    for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
      if (!execution || !execution.id) continue;
      const storedRun = queryRows(
        db,
        `SELECT attempt, execution_epoch, status FROM runs WHERE run_id = ${sqliteLiteral(execution.id)}`,
        ["attempt", "execution_epoch", "status"]
      );
      if (storedRun.length === 0) continue;
      const storedAttempt = Number(storedRun[0][0]) || 1;
      const incomingAttempt = Number(execution.attempt) || 1;
      if (storedAttempt > incomingAttempt) {
        throw new Error(`stale run projection for ${execution.id}: stored attempt ${storedAttempt}, incoming ${incomingAttempt}`);
      }
      if (storedAttempt === incomingAttempt && storedRun[0][1] !== String(execution.epoch || "")) {
        throw new Error(`stale run projection for ${execution.id}: execution epoch changed`);
      }
      if (storedAttempt === incomingAttempt && isTerminalStatus(storedRun[0][2]) &&
          storedRun[0][2] !== String(execution.status || "")) {
        throw new Error(`stale run projection for ${execution.id}: stored terminal status ${storedRun[0][2]}`);
      }
    }
  }
}

function writeSnapshotInTransaction(
  db: DynamicDatabase,
  snapshot: SnapshotRecord,
  revision: number,
): void {
  const timestamp = now();
  const agents: DynamicRecord[] = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  assertSnapshotNotStale(db, agents);
  for (const agent of agents) {
    if (!agent || !agent.id) continue;
    const agentState = withoutKeys(agent, ["inbox", "outbox", "events", "executions"]);
    db.execSQL(
      `INSERT OR REPLACE INTO agents (` +
      `agent_id, parent_agent_id, status, run_seq, current_run_id, state_json, revision, created_at, updated_at` +
      `) VALUES (` +
      `${sqliteLiteral(agent.id)}, ${sqliteLiteral(agent.parentAgentId)}, ${sqliteLiteral(agent.status)}, ` +
      `${Number(agent.runSeq) || 0}, ${sqliteLiteral(agent.currentExecutionId)}, ` +
      `${sqliteLiteral(JSON.stringify(agentState))}, ${revision}, ${Number(agent.createdAt) || timestamp}, ` +
      `${Number(agent.updatedAt) || timestamp})`
    );

    const executions = Array.isArray(agent.executions) ? agent.executions : [];
    for (const execution of executions) {
      if (!execution || !execution.id) continue;
      const runState = withoutKeys(execution, ["checkpoints"]);
      db.execSQL(
        `INSERT OR REPLACE INTO runs (` +
        `run_id, agent_id, run_seq, attempt, execution_epoch, status, state_json, revision, ` +
        `created_at, started_at, completed_at) VALUES (` +
        `${sqliteLiteral(execution.id)}, ${sqliteLiteral(agent.id)}, ${Number(execution.seq) || 0}, ` +
        `${Number(execution.attempt) || 1}, ${sqliteLiteral(execution.epoch)}, ${sqliteLiteral(execution.status)}, ` +
        `${sqliteLiteral(JSON.stringify(runState))}, ${revision}, ${Number(execution.createdAt) || timestamp}, ` +
        `${Number(execution.startedAt) || 0}, ${Number(execution.completedAt) || 0})`
      );
      writeAttemptProjection(db, execution, revision);
      const checkpoints = Array.isArray(execution.checkpoints) ? execution.checkpoints : [];
      for (const checkpoint of checkpoints) {
        const step = Number(checkpoint && checkpoint.step) || 0;
        const checkpointId = `${execution.id}:${step}`;
        db.execSQL(
          `INSERT OR IGNORE INTO checkpoints (` +
          `checkpoint_id, run_id, agent_id, step, checkpoint_json, revision, created_at) VALUES (` +
          `${sqliteLiteral(checkpointId)}, ${sqliteLiteral(execution.id)}, ${sqliteLiteral(agent.id)}, ${step}, ` +
          `${sqliteLiteral(JSON.stringify(checkpoint || {}))}, ${revision}, ` +
          `${Number(checkpoint && checkpoint.createdAt) || timestamp})`
        );
      }
    }

    const messages: DynamicRecord[] = [
      ...(Array.isArray(agent.inbox) ? agent.inbox.map((message: DynamicRecord) => ({ ...message, direction: "inbound" })) : []),
      ...(Array.isArray(agent.outbox) ? agent.outbox.map((message: DynamicRecord) => ({ ...message, direction: "outbound" })) : []),
    ];
    for (const message of messages) {
      if (!message || !message.id) continue;
      const messageProjectionId = message.direction === "outbound"
        ? `${agent.id}:outbound:${message.deliveryKey || message.id}`
        : message.id;
      const messageUpdatedAt = Number(message.acknowledgedAt || message.deliveredAt || message.createdAt) || timestamp;
      db.execSQL(
        `INSERT OR REPLACE INTO messages (` +
        `message_id, agent_id, status, acknowledged, delivery_attempts, state_json, revision, created_at, updated_at` +
        `) VALUES (` +
        `${sqliteLiteral(messageProjectionId)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(message.status)}, ` +
        `${message.acknowledged === true ? 1 : 0}, ${Number(message.deliveryAttempts) || 0}, ` +
        `${sqliteLiteral(JSON.stringify(message))}, ${revision}, ${Number(message.createdAt) || timestamp}, ` +
        `${messageUpdatedAt})`
      );
    }

    const events = Array.isArray(agent.events) ? agent.events : [];
    for (const event of events) {
      if (!event || !event.id) continue;
      db.execSQL(
        `INSERT OR IGNORE INTO events (` +
        `event_id, agent_id, run_id, run_seq, event_type, payload_json, event_json, revision, created_at` +
        `) VALUES (` +
        `${sqliteLiteral(event.id)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(event.execution_id)}, ` +
        `${Number(event.run_seq) || 0}, ${sqliteLiteral(event.type)}, ` +
        `${sqliteLiteral(JSON.stringify(event.data || {}))}, ${sqliteLiteral(JSON.stringify(event))}, ` +
        `${revision}, ${Number(event.created_at) || timestamp})`
      );
    }

    db.execSQL(
      `UPDATE path_claims SET active = 0, revision = ${revision}, updated_at = ${timestamp} ` +
      `WHERE agent_id = ${sqliteLiteral(agent.id)} AND active <> 0`
    );
    if (agent.readOnly !== true && !isTerminalStatus(agent.status)) {
      for (const path of Array.isArray(agent.targetPaths) ? agent.targetPaths : []) {
        const claimId = `${agent.id}:${path}`;
        db.execSQL(
          `INSERT OR REPLACE INTO path_claims (` +
          `claim_id, agent_id, path, claim_mode, active, revision, created_at, updated_at) VALUES (` +
          `${sqliteLiteral(claimId)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(path)}, 'write', 1, ` +
          `${revision}, ${Number(agent.createdAt) || timestamp}, ${timestamp})`
        );
      }
    }
  }
  writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
  writeMeta(db, "revision", revision, timestamp);
  writeMeta(db, "saved_at", Number(snapshot && snapshot.saved_at) || timestamp, timestamp);
}

function writeIncrementalAgentInTransaction(
  db: DynamicDatabase,
  agent: DynamicRecord,
  revision: number,
): void {
  if (!agent || !agent.id) return;
  const timestamp = now();
  const executions: DynamicRecord[] = Array.isArray(agent.executions) ? agent.executions : [];
  const execution = executions.find((item: DynamicRecord) => item && item.id === agent.currentExecutionId) || executions[executions.length - 1];
  assertSnapshotNotStale(db, [{ ...agent, executions: execution ? [execution] : [] }]);
  const agentState = withoutKeys(agent, ["inbox", "outbox", "events", "executions"]);
  db.execSQL(
    `INSERT OR REPLACE INTO agents (` +
    `agent_id, parent_agent_id, status, run_seq, current_run_id, state_json, revision, created_at, updated_at` +
    `) VALUES (` +
    `${sqliteLiteral(agent.id)}, ${sqliteLiteral(agent.parentAgentId)}, ${sqliteLiteral(agent.status)}, ` +
    `${Number(agent.runSeq) || 0}, ${sqliteLiteral(agent.currentExecutionId)}, ` +
    `${sqliteLiteral(JSON.stringify(agentState))}, ${revision}, ${Number(agent.createdAt) || timestamp}, ` +
    `${Number(agent.updatedAt) || timestamp})`
  );

  if (execution && execution.id) {
    const runState = withoutKeys(execution, ["checkpoints"]);
    db.execSQL(
      `INSERT OR REPLACE INTO runs (` +
      `run_id, agent_id, run_seq, attempt, execution_epoch, status, state_json, revision, ` +
      `created_at, started_at, completed_at) VALUES (` +
      `${sqliteLiteral(execution.id)}, ${sqliteLiteral(agent.id)}, ${Number(execution.seq) || 0}, ` +
      `${Number(execution.attempt) || 1}, ${sqliteLiteral(execution.epoch)}, ${sqliteLiteral(execution.status)}, ` +
      `${sqliteLiteral(JSON.stringify(runState))}, ${revision}, ${Number(execution.createdAt) || timestamp}, ` +
      `${Number(execution.startedAt) || 0}, ${Number(execution.completedAt) || 0})`
    );
    writeAttemptProjection(db, execution, revision);
    const checkpointWatermark = Number(queryRows(
      db,
      `SELECT MAX(step) FROM checkpoints WHERE run_id = ${sqliteLiteral(execution.id)}`,
      ["step"]
    )[0]?.[0]) || 0;
    for (const checkpoint of Array.isArray(execution.checkpoints) ? execution.checkpoints : []) {
      const step = Number(checkpoint && checkpoint.step) || 0;
      if (step <= checkpointWatermark) continue;
      const checkpointId = `${execution.id}:${step}`;
      db.execSQL(
        `INSERT OR IGNORE INTO checkpoints (` +
        `checkpoint_id, run_id, agent_id, step, checkpoint_json, revision, created_at) VALUES (` +
        `${sqliteLiteral(checkpointId)}, ${sqliteLiteral(execution.id)}, ${sqliteLiteral(agent.id)}, ${step}, ` +
        `${sqliteLiteral(JSON.stringify(checkpoint || {}))}, ${revision}, ` +
        `${Number(checkpoint && checkpoint.createdAt) || timestamp})`
      );
    }
  }

  const incrementalMessages: DynamicRecord[] = [
    ...(Array.isArray(agent.inbox) ? agent.inbox.map((entry: DynamicRecord) => ({ ...entry, direction: "inbound" })) : []),
    ...(Array.isArray(agent.outbox) ? agent.outbox.map((entry: DynamicRecord) => ({ ...entry, direction: "outbound" })) : []),
  ];
  for (const message of incrementalMessages) {
    if (!message || !message.id) continue;
    const messageProjectionId = message.direction === "outbound"
      ? `${agent.id}:outbound:${message.deliveryKey || message.id}`
      : message.id;
    const messageUpdatedAt = Number(message.acknowledgedAt || message.deliveredAt || message.createdAt) || timestamp;
    db.execSQL(
      `INSERT OR REPLACE INTO messages (` +
      `message_id, agent_id, status, acknowledged, delivery_attempts, state_json, revision, created_at, updated_at` +
      `) VALUES (` +
      `${sqliteLiteral(messageProjectionId)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(message.status)}, ` +
      `${message.acknowledged === true ? 1 : 0}, ${Number(message.deliveryAttempts) || 0}, ` +
      `${sqliteLiteral(JSON.stringify(message))}, ${revision}, ${Number(message.createdAt) || timestamp}, ` +
      `${messageUpdatedAt})`
    );
  }

  for (const event of Array.isArray(agent.events) ? agent.events : []) {
    if (!event || !event.id) continue;
    db.execSQL(
      `INSERT OR IGNORE INTO events (` +
      `event_id, agent_id, run_id, run_seq, event_type, payload_json, event_json, revision, created_at` +
      `) VALUES (` +
      `${sqliteLiteral(event.id)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(event.execution_id)}, ` +
      `${Number(event.run_seq) || 0}, ${sqliteLiteral(event.type)}, ` +
      `${sqliteLiteral(JSON.stringify(event.data || {}))}, ${sqliteLiteral(JSON.stringify(event))}, ` +
      `${revision}, ${Number(event.created_at) || timestamp})`
    );
  }

  db.execSQL(
    `UPDATE path_claims SET active = 0, revision = ${revision}, updated_at = ${timestamp} ` +
    `WHERE agent_id = ${sqliteLiteral(agent.id)} AND active <> 0`
  );
  if (agent.readOnly !== true && !isTerminalStatus(agent.status)) {
    for (const path of Array.isArray(agent.targetPaths) ? agent.targetPaths : []) {
      const claimId = `${agent.id}:${path}`;
      db.execSQL(
        `INSERT OR REPLACE INTO path_claims (` +
        `claim_id, agent_id, path, claim_mode, active, revision, created_at, updated_at) VALUES (` +
        `${sqliteLiteral(claimId)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(path)}, 'write', 1, ` +
        `${revision}, ${Number(agent.createdAt) || timestamp}, ${timestamp})`
      );
    }
  }
}

function parseJsonRow<T extends DynamicRecord = DynamicRecord>(value: string, label: string): T {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as T;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadRelationalSnapshot(db: DynamicDatabase): SnapshotRecord {
  const schemaVersion = Number(queryMeta(db, "schema_version"));
  if (schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported collaboration event store schema: ${schemaVersion || "missing"}`);
  }
  const agents: DynamicRecord[] = [];
  const agentMap = new Map<unknown, DynamicRecord>();
  for (const [json] of queryRows(db, "SELECT state_json FROM agents ORDER BY created_at, agent_id", ["state_json"])) {
    const agent = parseJsonRow(json, "agent projection");
    const hasLegacyOutbox = Object.prototype.hasOwnProperty.call(agent, "outbox");
    const legacyOutbox = Array.isArray(agent.outbox) ? agent.outbox : [];
    agent.inbox = [];
    if (hasLegacyOutbox) agent.outbox = legacyOutbox;
    else delete agent.outbox;
    agent.events = [];
    agent.executions = [];
    agents.push(agent);
    agentMap.set(agent.id, agent);
  }

  const runMap = new Map();
  const runsByAgent = new Map();
  for (const [json] of queryRows(db, "SELECT state_json FROM runs ORDER BY agent_id, run_seq, attempt", ["state_json"])) {
    const execution = parseJsonRow(json, "run projection");
    execution.checkpoints = [];
    if (!runsByAgent.has(execution.agentId)) runsByAgent.set(execution.agentId, []);
    runsByAgent.get(execution.agentId).push(execution);
  }
  for (const [agentId, runs] of runsByAgent) {
    const retained = runs.slice(-MAX_LOADED_EXECUTIONS);
    const agent = agentMap.get(agentId);
    if (!agent) continue;
    agent.executions = retained;
    for (const execution of retained) runMap.set(execution.id, execution);
  }

  for (const [runId, json] of queryRows(
    db,
    "SELECT run_id, checkpoint_json FROM checkpoints ORDER BY run_id, step",
    ["run_id", "checkpoint_json"]
  )) {
    const execution = runMap.get(runId);
    if (execution) execution.checkpoints.push(parseJsonRow(json, "checkpoint"));
  }

  for (const [agentId, json] of queryRows(
    db,
    "SELECT agent_id, state_json FROM messages ORDER BY agent_id, created_at, message_id",
    ["agent_id", "state_json"]
  )) {
    const agent = agentMap.get(agentId);
    if (!agent) continue;
    const message = parseJsonRow(json, "message projection");
    const inbox: DynamicRecord[] = Array.isArray(agent.inbox) ? agent.inbox : [];
    agent.inbox = inbox;
    if (message.direction === "outbound") {
      const outbox: DynamicRecord[] = Array.isArray(agent.outbox) ? agent.outbox : [];
      agent.outbox = outbox;
      if (!outbox.some((entry: DynamicRecord) => entry.deliveryKey === message.deliveryKey && entry.id === message.id)) {
        const { direction: _direction, ...outbound } = message;
        outbox.push(outbound);
      }
    } else {
      const { direction: _direction, ...inbound } = message;
      inbox.push(inbound);
    }
  }

  const eventsByAgent = new Map();
  for (const [agentId, json] of queryRows(
    db,
    "SELECT agent_id, event_json FROM events ORDER BY agent_id, created_at, event_id",
    ["agent_id", "event_json"]
  )) {
    if (!eventsByAgent.has(agentId)) eventsByAgent.set(agentId, []);
    eventsByAgent.get(agentId).push(parseJsonRow(json, "event"));
  }
  for (const [agentId, events] of eventsByAgent) {
    const agent = agentMap.get(agentId);
    if (agent) agent.events = events.slice(-MAX_LOADED_EVENTS);
  }

  return {
    schema_version: STATE_SCHEMA_VERSION,
    saved_at: Number(queryMeta(db, "saved_at")) || 0,
    revision: Number(queryMeta(db, "revision")) || 0,
    agents,
  };
}

function initializeDatabase(db: DynamicDatabase): StoreInitialization {
  return withTransaction(db, () => {
    for (const sql of SCHEMA_SQL) db.execSQL(sql);
    const existingVersion = queryMeta(db, "schema_version");
    if (existingVersion) {
      const version = Number(existingVersion);
      if (version === STATE_SCHEMA_VERSION) {
        const currentRevision = Number(queryMeta(db, "revision")) || 0;
        const recoveryRevision = currentRevision + 1;
        const unknownEffects = markPreparedEffectsUnknown(db, recoveryRevision);
        if (unknownEffects > 0) {
          const timestamp = now();
          writeMeta(db, "revision", recoveryRevision, timestamp);
          writeMeta(db, "saved_at", timestamp, timestamp);
          return { revision: recoveryRevision, migration: "prepared_effects_marked_unknown" };
        }
        return { revision: currentRevision, migration: "" };
      }
      if (version === EVENT_STORE_SCHEMA_V3) {
        const currentRevision = Number(queryMeta(db, "revision")) || 0;
        const revision = currentRevision + 1;
        const unknownEffects = markPreparedEffectsUnknown(db, revision);
        const timestamp = now();
        writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
        writeMeta(db, "revision", revision, timestamp);
        writeMeta(db, "saved_at", timestamp, timestamp);
        return {
          revision,
          migration: unknownEffects > 0
            ? "event_store_v3_to_v4_prepared_effects_marked_unknown"
            : "event_store_v3_to_v4",
        };
      }
      if (version === EVENT_STORE_SCHEMA_V2) {
        const revision = (Number(queryMeta(db, "revision")) || 0) + 1;
        for (const [json] of queryRows(db, "SELECT state_json FROM runs ORDER BY agent_id, run_seq", ["state_json"])) {
          const execution = parseJsonRow(json, "run projection during schema v3 migration");
          writeAttemptProjection(db, execution, revision);
        }
        const unknownEffects = markPreparedEffectsUnknown(db, revision);
        const timestamp = now();
        writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
        writeMeta(db, "revision", revision, timestamp);
        writeMeta(db, "saved_at", timestamp, timestamp);
        return {
          revision,
          migration: unknownEffects > 0
            ? "event_store_v2_to_v4_prepared_effects_marked_unknown"
            : "event_store_v2_to_v4",
        };
      }
      throw new Error(`unsupported collaboration event store schema: ${existingVersion}`);
    }
    const legacy = readLegacySnapshot(db);
    if (legacy) {
      writeSnapshotInTransaction(db, legacy, 1);
      return { revision: 1, migration: "snapshot_v1_to_event_store_v4" };
    }
    const timestamp = now();
    writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
    writeMeta(db, "revision", 0, timestamp);
    writeMeta(db, "saved_at", timestamp, timestamp);
    return { revision: 0, migration: "initialized_event_store_v4" };
  });
}

function createSqliteStore(db: DynamicDatabase, initialized: StoreInitialization): CollaborationStore {
  let revision = initialized.revision;

  function transactionalWrite<T>(action: (committedRevision: number) => T, savedAt?: unknown): T {
    let committedRevision = revision;
    const result = withTransaction(db, () => {
      committedRevision = (Number(queryMeta(db, "revision")) || revision) + 1;
      const value = action(committedRevision);
      const timestamp = now();
      writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
      writeMeta(db, "revision", committedRevision, timestamp);
      writeMeta(db, "saved_at", Number(savedAt) || timestamp, timestamp);
      return value;
    });
    revision = committedRevision;
    return result;
  }

  function loadRequest(requestId: unknown, operation: unknown): RequestRecord | null {
    return readJsonRow<RequestRecord>(
      db,
      `SELECT result_json FROM request_ledger WHERE request_key = ${sqliteLiteral(`${operation}:${requestId}`)}`,
      "request ledger"
    );
  }

  function loadEffect(effectKey: unknown): EffectRecord | null {
    return readJsonRow<EffectRecord>(
      db,
      `SELECT result_json FROM side_effects WHERE effect_key = ${sqliteLiteral(effectKey)}`,
      "side effect"
    );
  }

  return {
    mode: "sqlite",
    reason: "",
    migration: initialized.migration,
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceModel: "event_store",
    get revision() {
      return revision;
    },
    load() {
      const snapshot = loadRelationalSnapshot(db);
      revision = Number(snapshot.revision) || revision;
      return snapshot;
    },
    save(snapshot) {
      transactionalWrite(
        (committedRevision) => writeSnapshotInTransaction(db, snapshot, committedRevision),
        snapshot && snapshot.saved_at
      );
    },
    saveAgent(agent) {
      return this.saveAgents([agent]);
    },
    saveAgents(changedAgents) {
      const incoming = (Array.isArray(changedAgents) ? changedAgents : []).filter((agent) => agent && agent.id);
      if (incoming.length === 0) return;
      transactionalWrite((committedRevision) => {
        for (const agent of incoming) writeIncrementalAgentInTransaction(db, agent, committedRevision);
      });
    },
    deleteAgents(agentIds) {
      const ids = Array.from(new Set(
        (Array.isArray(agentIds) ? agentIds : []).map((id) => String(id || "").trim()).filter(Boolean)
      ));
      if (ids.length === 0) return 0;
      return transactionalWrite(() => {
        const existing = queryColumnInBatches(db, "agents", "agent_id", "agent_id", ids).sort();
        if (existing.length === 0) return 0;
        const existingSet = new Set(existing);
        const runIds = Array.from(new Set(queryColumnInBatches(db, "runs", "run_id", "agent_id", existing)));
        const epochs = Array.from(new Set(queryColumnInBatches(
          db,
          "run_attempts",
          "execution_epoch",
          "agent_id",
          existing
        )));
        deleteInBatches(db, "side_effects", "execution_epoch", epochs);
        for (const table of ["checkpoints", "run_attempts", "events", "runs"]) {
          deleteInBatches(db, table, "run_id", runIds);
        }
        for (const table of ["messages", "events", "path_claims"]) {
          deleteInBatches(db, table, "agent_id", existing);
        }
        for (const [requestKey, json] of queryRows(
          db,
          "SELECT request_key, result_json FROM request_ledger ORDER BY request_key",
          ["request_key", "result_json"]
        )) {
          const request = parseJsonRow(json, "request ledger");
          if (requestResultReferencesAgentIds(request.result, existingSet)) {
            db.execSQL(`DELETE FROM request_ledger WHERE request_key = ${sqliteLiteral(requestKey)}`);
          }
        }
        deleteInBatches(db, "agents", "agent_id", existing);
        return existing.length;
      });
    },
    getMeta(key) {
      return queryMeta(db, String(key || "").trim());
    },
    setMeta(key, value) {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) throw new Error("meta key is required");
      return transactionalWrite(() => {
        writeMeta(db, normalizedKey, String(value ?? ""), now());
        return String(value ?? "");
      });
    },
    getRequest(requestId, operation) {
      return loadRequest(String(requestId || "").trim(), String(operation || "").trim());
    },
    commitRequest(input, changedAgents = []) {
      const record = normalizeRequestRecord(input);
      const existing = loadRequest(record.requestId, record.operation);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint) throw new Error(`request_id conflict: ${record.requestId}`);
        return { deduplicated: true, record: existing };
      }
      const incoming = (Array.isArray(changedAgents) ? changedAgents : []).filter((agent) => agent && agent.id);
      return transactionalWrite((committedRevision) => {
        for (const agent of incoming) writeIncrementalAgentInTransaction(db, agent, committedRevision);
        db.execSQL(
          `INSERT INTO request_ledger (` +
          `request_key, request_id, operation, fingerprint, status, result_json, revision, created_at, updated_at` +
          `) VALUES (` +
          `${sqliteLiteral(record.requestKey)}, ${sqliteLiteral(record.requestId)}, ${sqliteLiteral(record.operation)}, ` +
          `${sqliteLiteral(record.fingerprint)}, ${sqliteLiteral(record.status)}, ${sqliteLiteral(JSON.stringify(record))}, ` +
          `${committedRevision}, ${record.createdAt}, ${record.updatedAt})`
        );
        return { deduplicated: false, record };
      });
    },
    saveRecovery(snapshot, records = []) {
      transactionalWrite((committedRevision) => {
        for (const record of records) writeAttemptRecord(db, cloneSnapshot(record), committedRevision);
        writeSnapshotInTransaction(db, snapshot, committedRevision);
      }, snapshot && snapshot.saved_at);
    },
    recordAttempt(record) {
      return transactionalWrite((committedRevision) => writeAttemptRecord(db, cloneSnapshot(record), committedRevision));
    },
    listAttempts(runId) {
      const where = runId ? ` WHERE run_id = ${sqliteLiteral(runId)}` : "";
      return queryRows(
        db,
        `SELECT attempt_json FROM run_attempts${where} ORDER BY run_id, attempt`,
        ["attempt_json"]
      ).map(([json]) => parseJsonRow(json, "run attempt"));
    },
    prepareEffect(input) {
      const request = normalizeEffectRequest(input);
      const existing = loadEffect(request.effectKey);
      if (existing) {
        if (existing.executionEpoch !== request.executionEpoch || existing.operation !== request.operation ||
            existing.requestHash !== request.requestHash || existing.checkpointStep !== request.checkpointStep) {
          throw new Error(`effect key collision: ${request.effectKey}`);
        }
        if (existing.status === "committed") {
          transactionalWrite((committedRevision) => {
            writeEffectEvent(db, existing, "effect_reused", committedRevision);
          });
          return { disposition: "reuse", effect: existing };
        }
        return { disposition: "blocked", effect: existing };
      }
      return transactionalWrite((committedRevision) => {
        requireEffectOwner(db, request.executionEpoch);
        const timestamp = now();
        const effect = { ...request, status: "prepared", result: null, createdAt: timestamp, updatedAt: timestamp };
        db.execSQL(
          `INSERT INTO side_effects (` +
          `effect_key, execution_epoch, checkpoint_step, operation, request_hash, status, result_json, revision, created_at, updated_at` +
          `) VALUES (` +
          `${sqliteLiteral(effect.effectKey)}, ${sqliteLiteral(effect.executionEpoch)}, ${effect.checkpointStep}, ` +
          `${sqliteLiteral(effect.operation)}, ${sqliteLiteral(effect.requestHash)}, 'prepared', ` +
          `${sqliteLiteral(JSON.stringify(effect))}, ${committedRevision}, ${timestamp}, ${timestamp})`
        );
        writeEffectEvent(db, effect, "effect_prepared", committedRevision);
        return { disposition: "execute", effect };
      });
    },
    resolveEffect(effectKey, status, result) {
      const key = String(effectKey || "").trim();
      if (!["committed", "unknown", "failed"].includes(status)) throw new Error(`invalid effect status: ${status}`);
      const existing = loadEffect(key);
      if (!existing) throw new Error(`effect not found: ${key}`);
      if (existing.status === "committed" && status !== "committed") {
        throw new Error(`committed effect cannot transition to ${status}: ${key}`);
      }
      if (existing.status === "committed") return existing;
      return transactionalWrite((committedRevision) => {
        const effect = { ...existing, status, result: cloneSnapshot(result), updatedAt: now() };
        db.execSQL(
          `UPDATE side_effects SET status = ${sqliteLiteral(status)}, result_json = ${sqliteLiteral(JSON.stringify(effect))}, ` +
          `revision = ${committedRevision}, updated_at = ${effect.updatedAt} WHERE effect_key = ${sqliteLiteral(key)}`
        );
        writeEffectEvent(db, effect, effectEventType(status), committedRevision);
        return effect;
      });
    },
    getEffect(effectKey) {
      return loadEffect(String(effectKey || "").trim());
    },
    listEffects(executionEpoch, statuses = []) {
      const epoch = String(executionEpoch || "").trim();
      const allowed = (Array.isArray(statuses) ? statuses : [])
        .map((status) => String(status || "").trim())
        .filter(Boolean);
      const clauses: string[] = [];
      if (epoch) clauses.push(`execution_epoch = ${sqliteLiteral(epoch)}`);
      if (allowed.length > 0) clauses.push(`status IN (${allowed.map(sqliteLiteral).join(", ")})`);
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      return queryRows(
        db,
        `SELECT result_json FROM side_effects${where} ORDER BY created_at, effect_key`,
        ["result_json"]
      ).map(([json]) => parseJsonRow(json, "side effect"));
    },
    appendTreeContextEvent(input, options = {}) {
      const normalized = normalizeTreeContextEventInput(input);
      const changedAgents = (Array.isArray(options.changedAgents) ? options.changedAgents : [])
        .filter((agent) => agent && agent.id)
        .map((agent) => cloneSnapshot(agent));
      const existing = readTreeContextEvent(
        db,
        normalized.rootRunId,
        normalized.eventId || "",
        normalized.idempotencyKey || ""
      );
      if (existing) {
        assertMatchingTreeContextEvent(existing, normalized);
        return { deduplicated: true, event: existing };
      }
      return transactionalWrite((committedRevision) => {
        const event: TreeContextEvent = {
          eventId: normalized.eventId || createId("tree_context"),
          rootRunId: normalized.rootRunId,
          revision: committedRevision,
          sourceAgentId: normalized.sourceAgentId,
          sourceRunId: normalized.sourceRunId,
          sourceEpoch: normalized.sourceEpoch,
          kind: normalized.kind,
          visibility: normalized.visibility || "tree",
          payload: cloneSnapshot(normalized.payload),
          idempotencyKey: normalized.idempotencyKey || "",
          committedAt: normalized.committedAt || now(),
        };
        db.execSQL(
          `INSERT INTO tree_context_events (` +
          `event_id, root_run_id, revision, source_agent_id, source_run_id, source_epoch, event_kind, visibility, ` +
          `idempotency_key, event_json, committed_at) VALUES (` +
          `${sqliteLiteral(event.eventId)}, ${sqliteLiteral(event.rootRunId)}, ${event.revision}, ` +
          `${sqliteLiteral(event.sourceAgentId)}, ${sqliteLiteral(event.sourceRunId)}, ${sqliteLiteral(event.sourceEpoch)}, ` +
          `${sqliteLiteral(event.kind)}, ${sqliteLiteral(event.visibility)}, ` +
          `${event.idempotencyKey ? sqliteLiteral(event.idempotencyKey) : "NULL"}, ` +
          `${sqliteLiteral(JSON.stringify(event))}, ${event.committedAt})`
        );
        const priorSnapshot = readJsonRow<TreeContextSnapshot>(
          db,
          `SELECT snapshot_json FROM tree_context_snapshots WHERE root_run_id = ${sqliteLiteral(event.rootRunId)}`,
          "tree context snapshot"
        );
        const providedSnapshot = options.snapshot ? normalizeTreeContextSnapshot(options.snapshot) : null;
        writeTreeContextSnapshot(db, treeContextSnapshotForCommit(priorSnapshot, providedSnapshot, event));
        for (const [cursorJson] of queryRows(
          db,
          `SELECT cursor_json FROM agent_context_cursors WHERE root_run_id = ${sqliteLiteral(event.rootRunId)}`,
          ["cursor_json"]
        )) {
          const cursor = parseJsonRow<AgentContextCursor>(cursorJson, "agent context cursor");
          writeAgentContextCursor(db, {
            ...cursor,
            dirtyRevision: Math.max(cursor.dirtyRevision, event.revision),
            updatedAt: event.committedAt,
          });
        }
        if (options.cursor) {
          const cursor = normalizeAgentContextCursor(options.cursor);
          if (cursor.rootRunId !== event.rootRunId) {
            throw new Error("agent context cursor rootRunId does not match event rootRunId");
          }
          writeAgentContextCursor(db, {
            ...cursor,
            dirtyRevision: Math.max(cursor.dirtyRevision, event.revision),
            updatedAt: Math.max(cursor.updatedAt, event.committedAt),
          });
        }
        const stampedCheckpoint = stampTreeContextRevision(changedAgents, normalized, committedRevision);
        applyStampedCheckpoint(changedAgents, normalized.sourceRunId, stampedCheckpoint);
        for (const agent of changedAgents) writeIncrementalAgentInTransaction(db, agent, committedRevision);
        return { deduplicated: false, event, checkpoint: cloneSnapshot(stampedCheckpoint) };
      });
    },
    listTreeContextEvents(rootRunId, afterRevision = 0, limit = MAX_TREE_CONTEXT_EVENT_LIMIT) {
      const root = String(rootRunId || "").trim();
      if (!root) return [];
      const after = Math.max(0, Math.floor(Number(afterRevision) || 0));
      const boundedLimit = Math.max(1, Math.min(MAX_TREE_CONTEXT_EVENT_LIMIT, Math.floor(Number(limit) || MAX_TREE_CONTEXT_EVENT_LIMIT)));
      return queryRows(
        db,
        `SELECT event_json FROM tree_context_events WHERE root_run_id = ${sqliteLiteral(root)} ` +
        `AND revision > ${after} ORDER BY revision, event_id LIMIT ${boundedLimit}`,
        ["event_json"]
      ).map(([json]) => parseJsonRow<TreeContextEvent>(json, "tree context event"));
    },
    getTreeContextSnapshot(rootRunId) {
      const root = String(rootRunId || "").trim();
      if (!root) return null;
      return readJsonRow<TreeContextSnapshot>(
        db,
        `SELECT snapshot_json FROM tree_context_snapshots WHERE root_run_id = ${sqliteLiteral(root)}`,
        "tree context snapshot"
      );
    },
    saveTreeContextSnapshot(value) {
      const snapshot = normalizeTreeContextSnapshot(value);
      return transactionalWrite(() => writeTreeContextSnapshot(db, snapshot));
    },
    getAgentContextCursor(rootRunId, agentId) {
      const root = String(rootRunId || "").trim();
      const agent = String(agentId || "").trim();
      if (!root || !agent) return null;
      return readJsonRow<AgentContextCursor>(
        db,
        `SELECT cursor_json FROM agent_context_cursors WHERE root_run_id = ${sqliteLiteral(root)} ` +
        `AND agent_id = ${sqliteLiteral(agent)}`,
        "agent context cursor"
      );
    },
    saveAgentContextCursor(value) {
      const cursor = normalizeAgentContextCursor(value);
      return transactionalWrite(() => writeAgentContextCursor(db, cursor));
    },
    close() {
      try {
        db.close();
      } catch (_) {}
    },
  };
}

type ApplicationContextBridge = {
  openOrCreateDatabase(name: string, mode: number, factory: unknown): unknown;
};

export function createCollaborationStore(): CollaborationStore {
  let db: DynamicDatabase | null = null;
  try {
    const appContext = Java.getApplicationContext() as ApplicationContextBridge | null;
    if (!appContext || typeof appContext.openOrCreateDatabase !== "function") {
      return memoryStore("application context does not expose openOrCreateDatabase");
    }
    const database = appContext.openOrCreateDatabase(STATE_DB_NAME, 0, null);
    requireDatabaseApi(database);
    db = database;
    const enableWriteAheadLogging = db.enableWriteAheadLogging;
    try {
      if (enableWriteAheadLogging) enableWriteAheadLogging.call(db);
    } catch (_) {}
    return createSqliteStore(db, initializeDatabase(db));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let legacy: SnapshotRecord | null = null;
    if (db) {
      try {
        legacy = readLegacySnapshot(db);
      } catch (_) {}
      try {
        db.close();
      } catch (_) {}
    }
    return memoryStore(
      `SQLite event store unavailable: ${reason}`,
      legacy,
      legacy ? "legacy_snapshot_memory_fallback" : ""
    );
  }
}

export const createSnapshotStore = createCollaborationStore;