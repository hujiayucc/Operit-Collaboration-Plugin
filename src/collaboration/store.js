"use strict";

const { now, sqliteLiteral } = require("./helpers.js");

const STATE_DB_NAME = "operit_collaboration.db";
const LEGACY_SCHEMA_VERSION = 1;
const PREVIOUS_EVENT_STORE_SCHEMA_VERSION = 2;
const STATE_SCHEMA_VERSION = 3;
const MAX_LOADED_EVENTS = 300;
const MAX_LOADED_EXECUTIONS = 30;
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
  "CREATE INDEX IF NOT EXISTS idx_runs_agent_seq ON runs(agent_id, run_seq)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_run_attempt ON run_attempts(run_id, attempt)",
  "CREATE INDEX IF NOT EXISTS idx_messages_agent_created ON messages(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_agent_created ON events(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_checkpoints_run_step ON checkpoints(run_id, step)",
  "CREATE INDEX IF NOT EXISTS idx_path_claims_active_path ON path_claims(active, path)",
  "CREATE INDEX IF NOT EXISTS idx_request_ledger_id ON request_ledger(request_id, operation)",
];

function cloneSnapshot(snapshot) {
  return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
}

function requestResultReferencesAgentIds(value, agentIds, key = "") {
  if (Array.isArray(value)) {
    return value.some((item) => requestResultReferencesAgentIds(item, agentIds, key));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && agentIds.has(value) && [
      "id",
      "agent_id",
      "parent_agent_id",
      "root_agent_id",
    ].includes(key);
  }
  return Object.entries(value).some(([childKey, childValue]) =>
    requestResultReferencesAgentIds(childValue, agentIds, childKey)
  );
}

function normalizeEffectRequest(input) {
  if (!input || typeof input !== "object") throw new Error("effect request must be an object");
  const executionEpoch = String(input.execution_epoch || input.executionEpoch || "").trim();
  const checkpointStep = Math.max(0, Math.floor(Number(input.checkpoint_step ?? input.checkpointStep) || 0));
  const operation = String(input.operation || "").trim();
  const requestHash = String(input.request_hash || input.requestHash || "").trim();
  if (!executionEpoch) throw new Error("effect execution_epoch is required");
  if (!operation) throw new Error("effect operation is required");
  if (!requestHash) throw new Error("effect request_hash is required");
  return {
    effectKey: String(input.effect_key || input.effectKey ||
      `${executionEpoch}:${checkpointStep}:${operation}:${requestHash}`).trim(),
    executionEpoch,
    checkpointStep,
    operation,
    requestHash,
  };
}

function normalizeRequestRecord(input) {
  if (!input || typeof input !== "object") throw new Error("request record must be an object");
  const requestId = String(input.requestId || input.request_id || "").trim();
  const operation = String(input.operation || "").trim();
  const fingerprint = String(input.fingerprint || "");
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
    result: cloneSnapshot(input.result),
    createdAt: Number(input.createdAt) || timestamp,
    updatedAt: timestamp,
  };
}

function memoryStore(reason = "", initialSnapshot = null, migration = "") {
  let current = cloneSnapshot(initialSnapshot);
  let revision = Number(current && current.revision) || 0;
  const attempts = new Map();
  const effects = new Map();
  const requests = new Map();
  const meta = new Map();

  function projectAttempts(snapshot, target = attempts) {
    for (const agent of Array.isArray(snapshot && snapshot.agents) ? snapshot.agents : []) {
      for (const execution of Array.isArray(agent && agent.executions) ? agent.executions : []) {
        if (!execution || !execution.id) continue;
        const record = attemptRecord(execution);
        target.set(record.attemptId, cloneSnapshot(record));
      }
    }
  }

  function ownerForEpoch(executionEpoch) {
    const epoch = String(executionEpoch || "").trim();
    const owner = Array.from(attempts.values()).find((record) => record.executionEpoch === epoch);
    if (!owner) throw new Error(`effect execution epoch not found: ${epoch}`);
    return owner;
  }

  function assertMemorySnapshotNotStale(snapshot) {
    const currentAgents = new Map(
      (Array.isArray(current && current.agents) ? current.agents : [])
        .filter((agent) => agent && agent.id)
        .map((agent) => [agent.id, agent])
    );
    for (const agent of Array.isArray(snapshot && snapshot.agents) ? snapshot.agents : []) {
      const storedAgent = currentAgents.get(agent && agent.id);
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
      const storedRuns = new Map(
        (Array.isArray(storedAgent.executions) ? storedAgent.executions : [])
          .filter((execution) => execution && execution.id)
          .map((execution) => [execution.id, execution])
      );
      for (const execution of Array.isArray(agent.executions) ? agent.executions : []) {
        const storedRun = storedRuns.get(execution && execution.id);
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

  function appendEffectEvent(owner, effect, type, nextRevision, extra = {}) {
    const agent = Array.isArray(current && current.agents)
      ? current.agents.find((item) => item && item.id === owner.agentId)
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
    if (!Array.isArray(agent.events)) agent.events = [];
    agent.events.push({
      id: `effect:${effect.effectKey}:${type}:${nextRevision}`,
      type,
      agent_id: owner.agentId,
      execution_id: owner.runId,
      run_seq: owner.runSeq,
      created_at: createdAt,
      data,
    });
    if (agent.events.length > MAX_LOADED_EVENTS) {
      agent.events.splice(0, agent.events.length - MAX_LOADED_EVENTS);
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
      const removed = (Array.isArray(current && current.agents) ? current.agents : [])
        .filter((agent) => agent && ids.has(agent.id));
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
        .filter((agent) => agent && !ids.has(agent.id));
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
      return meta.get(normalizedKey);
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
        .map(cloneSnapshot);
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
        .map(cloneSnapshot);
    },
    close() {},
  };
}

function requireDatabaseApi(db) {
  for (const method of ["execSQL", "rawQuery", "beginTransaction", "setTransactionSuccessful", "endTransaction"]) {
    if (!db || typeof db[method] !== "function") {
      throw new Error(`SQLite database does not expose ${method}`);
    }
  }
}

function withTransaction(db, action) {
  db.beginTransaction();
  try {
    const result = action();
    db.setTransactionSuccessful();
    return result;
  } finally {
    db.endTransaction();
  }
}

function queryRows(db, sql, columns) {
  let cursor = null;
  try {
    cursor = db.rawQuery(sql, null);
    const rows = [];
    if (!cursor.moveToFirst()) return rows;
    do {
      rows.push(columns.map((_, index) => String(cursor.getString(index) ?? "")));
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

function valueBatches(values) {
  const batches = [];
  for (let index = 0; index < values.length; index += SQLITE_BATCH_SIZE) {
    batches.push(values.slice(index, index + SQLITE_BATCH_SIZE));
  }
  return batches;
}

function queryColumnInBatches(db, table, selectedColumn, filterColumn, values) {
  const rows = [];
  for (const batch of valueBatches(values)) {
    rows.push(...queryRows(
      db,
      `SELECT ${selectedColumn} FROM ${table} WHERE ${filterColumn} IN (${batch.map(sqliteLiteral).join(", ")})`,
      [selectedColumn]
    ).map(([value]) => value));
  }
  return rows;
}

function deleteInBatches(db, table, column, values) {
  for (const batch of valueBatches(values)) {
    db.execSQL(`DELETE FROM ${table} WHERE ${column} IN (${batch.map(sqliteLiteral).join(", ")})`);
  }
}

function readJsonRow(db, sql, label) {
  const rows = queryRows(db, sql, ["json"]);
  return rows.length > 0 ? parseJsonRow(rows[0][0], label) : null;
}

function queryMeta(db, key) {
  const rows = queryRows(
    db,
    `SELECT meta_value FROM collaboration_meta WHERE meta_key = ${sqliteLiteral(key)}`,
    ["meta_value"]
  );
  return rows.length > 0 ? rows[0][0] : "";
}

function writeMeta(db, key, value, timestamp = now()) {
  db.execSQL(
    `INSERT OR REPLACE INTO collaboration_meta (meta_key, meta_value, updated_at) VALUES (` +
    `${sqliteLiteral(key)}, ${sqliteLiteral(value)}, ${timestamp})`
  );
}

function effectEventType(status) {
  if (status === "committed") return "effect_committed";
  if (status === "unknown") return "effect_state_unknown";
  if (status === "failed") return "effect_failed";
  return "effect_prepared";
}

function requireEffectOwner(db, executionEpoch) {
  const rows = queryRows(
    db,
    `SELECT run_id, agent_id, run_seq FROM run_attempts WHERE execution_epoch = ${sqliteLiteral(executionEpoch)}`,
    ["run_id", "agent_id", "run_seq"]
  );
  if (rows.length === 0) throw new Error(`effect execution epoch not found: ${executionEpoch}`);
  return rows[0];
}

function writeEffectEvent(db, effect, type, revision, extra = {}) {
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

function markPreparedEffectsUnknown(db, revision) {
  const rows = queryRows(
    db,
    "SELECT effect_key, result_json FROM side_effects WHERE status = 'prepared' ORDER BY effect_key",
    ["effect_key", "result_json"]
  );
  const timestamp = now();
  for (const [effectKey, json] of rows) {
    const effect = parseJsonRow(json, "prepared side effect");
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

function readLegacySnapshot(db) {
  let rows;
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
  let snapshot;
  try {
    snapshot = JSON.parse(rows[0][1]);
  } catch (error) {
    throw new Error(`legacy collaboration snapshot is not valid JSON: ${error.message}`);
  }
  if (!snapshot || !Array.isArray(snapshot.agents)) {
    throw new Error("legacy collaboration snapshot does not contain an agents array");
  }
  return snapshot;
}

function withoutKeys(value, keys) {
  const output = { ...value };
  for (const key of keys) delete output[key];
  return output;
}

function isTerminalStatus(status) {
  return [
    "completed",
    "failed",
    "interrupted",
    "interrupted_with_late_result",
    "timed_out",
    "orphaned",
  ].includes(String(status || ""));
}

function attemptRecord(execution, overrides = {}) {
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

function writeAttemptRecord(db, record, revision) {
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

function writeAttemptProjection(db, execution, revision, overrides = {}) {
  return writeAttemptRecord(db, attemptRecord(execution, overrides), revision);
}

function assertSnapshotNotStale(db, agents) {
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

function writeSnapshotInTransaction(db, snapshot, revision) {
  const timestamp = now();
  const agents = Array.isArray(snapshot && snapshot.agents) ? snapshot.agents : [];
  assertSnapshotNotStale(db, agents);
  for (const agent of agents) {
    if (!agent || !agent.id) continue;
    const agentState = withoutKeys(agent, ["inbox", "events", "executions"]);
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

    const messages = Array.isArray(agent.inbox) ? agent.inbox : [];
    for (const message of messages) {
      if (!message || !message.id) continue;
      const messageUpdatedAt = Number(message.acknowledgedAt || message.deliveredAt || message.createdAt) || timestamp;
      db.execSQL(
        `INSERT OR REPLACE INTO messages (` +
        `message_id, agent_id, status, acknowledged, delivery_attempts, state_json, revision, created_at, updated_at` +
        `) VALUES (` +
        `${sqliteLiteral(message.id)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(message.status)}, ` +
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

function writeIncrementalAgentInTransaction(db, agent, revision) {
  if (!agent || !agent.id) return;
  const timestamp = now();
  const executions = Array.isArray(agent.executions) ? agent.executions : [];
  const execution = executions.find((item) => item && item.id === agent.currentExecutionId) || executions[executions.length - 1];
  assertSnapshotNotStale(db, [{ ...agent, executions: execution ? [execution] : [] }]);
  const agentState = withoutKeys(agent, ["inbox", "events", "executions"]);
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

  for (const message of Array.isArray(agent.inbox) ? agent.inbox : []) {
    if (!message || !message.id) continue;
    const messageUpdatedAt = Number(message.acknowledgedAt || message.deliveredAt || message.createdAt) || timestamp;
    db.execSQL(
      `INSERT OR REPLACE INTO messages (` +
      `message_id, agent_id, status, acknowledged, delivery_attempts, state_json, revision, created_at, updated_at` +
      `) VALUES (` +
      `${sqliteLiteral(message.id)}, ${sqliteLiteral(agent.id)}, ${sqliteLiteral(message.status)}, ` +
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

function parseJsonRow(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`);
  }
}

function loadRelationalSnapshot(db) {
  const schemaVersion = Number(queryMeta(db, "schema_version"));
  if (schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported collaboration event store schema: ${schemaVersion || "missing"}`);
  }
  const agents = [];
  const agentMap = new Map();
  for (const [json] of queryRows(db, "SELECT state_json FROM agents ORDER BY created_at, agent_id", ["state_json"])) {
    const agent = parseJsonRow(json, "agent projection");
    agent.inbox = [];
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
    if (agent) agent.inbox.push(parseJsonRow(json, "message projection"));
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

function initializeDatabase(db) {
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
      if (version === PREVIOUS_EVENT_STORE_SCHEMA_VERSION) {
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
            ? "event_store_v2_to_v3_prepared_effects_marked_unknown"
            : "event_store_v2_to_v3",
        };
      }
      throw new Error(`unsupported collaboration event store schema: ${existingVersion}`);
    }
    const legacy = readLegacySnapshot(db);
    if (legacy) {
      writeSnapshotInTransaction(db, legacy, 1);
      return { revision: 1, migration: "snapshot_v1_to_event_store_v3" };
    }
    const timestamp = now();
    writeMeta(db, "schema_version", STATE_SCHEMA_VERSION, timestamp);
    writeMeta(db, "revision", 0, timestamp);
    writeMeta(db, "saved_at", timestamp, timestamp);
    return { revision: 0, migration: "initialized_event_store_v3" };
  });
}

function createSqliteStore(db, initialized) {
  let revision = initialized.revision;

  function transactionalWrite(action, savedAt) {
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

  function loadRequest(requestId, operation) {
    return readJsonRow(
      db,
      `SELECT result_json FROM request_ledger WHERE request_key = ${sqliteLiteral(`${operation}:${requestId}`)}`,
      "request ledger"
    );
  }

  function loadEffect(effectKey) {
    return readJsonRow(
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
      const clauses = [];
      if (epoch) clauses.push(`execution_epoch = ${sqliteLiteral(epoch)}`);
      if (allowed.length > 0) clauses.push(`status IN (${allowed.map(sqliteLiteral).join(", ")})`);
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      return queryRows(
        db,
        `SELECT result_json FROM side_effects${where} ORDER BY created_at, effect_key`,
        ["result_json"]
      ).map(([json]) => parseJsonRow(json, "side effect"));
    },
    close() {
      try {
        db.close();
      } catch (_) {}
    },
  };
}

function createCollaborationStore() {
  let db = null;
  try {
    const appContext = Java.getApplicationContext();
    if (!appContext || typeof appContext.openOrCreateDatabase !== "function") {
      return memoryStore("application context does not expose openOrCreateDatabase");
    }
    db = appContext.openOrCreateDatabase(STATE_DB_NAME, 0, null);
    requireDatabaseApi(db);
    try {
      db.enableWriteAheadLogging();
    } catch (_) {}
    return createSqliteStore(db, initializeDatabase(db));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let legacy = null;
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

const createSnapshotStore = createCollaborationStore;

module.exports = {
  LEGACY_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  createCollaborationStore,
  createSnapshotStore,
  memoryStore,
};