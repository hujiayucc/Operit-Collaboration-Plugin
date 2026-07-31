"use strict";

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

function createAndroidDb() {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  let transactionSuccessful = false;
  let failurePredicate = () => false;
  let inListLimit = Infinity;

  function enforceInListLimit(sql) {
    for (const match of String(sql).matchAll(/\bIN\s*\(([^)]*)\)/gi)) {
      const count = match[1].trim() ? match[1].split(",").length : 0;
      if (count > inListLimit) throw new Error(`SQLite IN list exceeds test limit: ${count}`);
    }
  }

  function rowsFor(sql) {
    enforceInListLimit(sql);
    return database.prepare(String(sql)).all().map((row) => Object.values(row));
  }

  return {
    execSQL(sql) {
      const text = String(sql);
      enforceInListLimit(text);
      if (failurePredicate(text)) throw new Error(`injected SQLite failure: ${text}`);
      database.exec(text);
    },
    rawQuery(sql) {
      const rows = rowsFor(sql);
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
    close() {
      closed = true;
    },
    query(sql) {
      return rowsFor(sql);
    },
    scalar(sql) {
      const rows = rowsFor(sql);
      return rows.length > 0 ? rows[0][0] : undefined;
    },
    setFailure(predicate) {
      failurePredicate = predicate || (() => false);
    },
    setInListLimit(limit) {
      inListLimit = Number.isFinite(limit) ? limit : Infinity;
    },
    isClosed() {
      return closed;
    },
  };
}

function sampleSnapshot() {
  const agentId = "agent_1";
  const runId = "execution_1";
  return {
    schema_version: 1,
    saved_at: 1234,
    agents: [
      {
        id: agentId,
        name: "writer",
        parentAgentId: "",
        parentChatId: "chat_1",
        status: "running",
        runSeq: 1,
        readOnly: false,
        targetPaths: ["/workspace/file.txt"],
        workspacePath: "/workspace",
        workspaceEnv: "android",
        timeoutMs: 30000,
        maxToolCalls: 4,
        priority: "normal",
        inbox: [
          {
            id: "message_1",
            content: "check user's file",
            status: "queued",
            createdAt: 100,
            deliveredAt: 0,
            deliveryAttempts: 0,
            acknowledged: false,
            acknowledgedAt: 0,
          },
        ],
        history: [],
        events: [
          {
            id: "event_1",
            type: "run_started",
            agent_id: agentId,
            execution_id: runId,
            run_seq: 1,
            created_at: 110,
            data: { epoch: `${agentId}:1:1` },
          },
        ],
        executions: [
          {
            id: runId,
            agentId,
            seq: 1,
            attempt: 1,
            epoch: `${agentId}:1:1`,
            parentRunId: "",
            parentExecutionEpoch: "",
            rootAgentId: agentId,
            rootRunId: runId,
            treeDepth: 0,
            task: "check user's file",
            context: "",
            status: "running",
            physicalStatus: "running",
            cancelRequested: false,
            serviceKey: "",
            stepCount: 1,
            toolCount: 0,
            currentTool: "",
            checkpoints: [{ step: 1, result: "working", createdAt: 115 }],
            result: "",
            lateResult: "",
            error: "",
            summaryError: "",
            createdAt: 100,
            startedAt: 105,
            completedAt: 0,
            timeoutMs: 30000,
            maxToolCalls: 4,
          },
        ],
        currentExecutionId: runId,
        lastResult: "",
        lastError: "",
        createdAt: 100,
        updatedAt: 115,
      },
    ],
  };
}

function batchSnapshot(count) {
  const agents = [];
  for (let index = 0; index < count; index += 1) {
    const agent = JSON.parse(JSON.stringify(sampleSnapshot().agents[0]));
    const agentId = `batch_agent_${index}`;
    const runId = `batch_run_${index}`;
    const epoch = `${agentId}:1:1`;
    agent.id = agentId;
    agent.parentChatId = `batch_chat_${index}`;
    agent.targetPaths = [`/workspace/batch_${index}.txt`];
    agent.inbox[0].id = `batch_message_${index}`;
    agent.events[0].id = `batch_event_${index}`;
    agent.events[0].agent_id = agentId;
    agent.events[0].execution_id = runId;
    agent.events[0].data.epoch = epoch;
    agent.executions[0].id = runId;
    agent.executions[0].agentId = agentId;
    agent.executions[0].epoch = epoch;
    agent.executions[0].rootAgentId = agentId;
    agent.executions[0].rootRunId = runId;
    agent.currentExecutionId = runId;
    agents.push(agent);
  }
  return { schema_version: 1, saved_at: 1234, agents };
}

let activeDb = createAndroidDb();
global.Java = {
  getApplicationContext() {
    return { openOrCreateDatabase: () => activeDb };
  },
};

const {
  STATE_SCHEMA_VERSION,
  createCollaborationStore,
  memoryStore,
} = require("../dist/collaboration/store.js");

test("event store creates schema v4 and round-trips relational projections", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  assert.equal(store.mode, "sqlite");
  assert.equal(store.persistenceModel, "event_store");
  assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(store.revision, 0);

  const snapshot = sampleSnapshot();
  store.save(snapshot);
  assert.equal(store.revision, 1);
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'schema_version'"), "4");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agents"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM runs"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM run_attempts"), 1);
  assert.equal(activeDb.scalar("SELECT execution_epoch FROM run_attempts"), "agent_1:1:1");
  const runProjection = JSON.parse(activeDb.scalar("SELECT state_json FROM runs WHERE run_id = 'execution_1'"));
  assert.equal(runProjection.rootAgentId, "agent_1");
  assert.equal(runProjection.rootRunId, "execution_1");
  assert.equal(runProjection.treeDepth, 0);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM messages"), 1);
  assert.equal(JSON.parse(activeDb.scalar("SELECT state_json FROM messages")).direction, "inbound");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM checkpoints"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM path_claims WHERE active = 1"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM side_effects"), 0);

  const loaded = store.load();
  assert.equal(loaded.schema_version, 4);
  assert.equal(loaded.saved_at, snapshot.saved_at);
  assert.equal(loaded.revision, 1);
  assert.deepEqual(loaded.agents, snapshot.agents);
  store.close();
  assert.equal(activeDb.isClosed(), true);
});

test("global settings metadata persists in the event store", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const value = JSON.stringify({
    max_concurrent_agents: 3,
    max_active_runs_per_root: 2,
    max_tool_calls: 18,
    max_model_retries: 5,
    conversation_context_mode: "on",
  });
  store.setMeta("collaboration_settings_v1", value);
  assert.equal(store.getMeta("collaboration_settings_v1"), value);
  store.close();
});

test("events and checkpoints are append-only while projections and revision advance", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const first = sampleSnapshot();
  store.save(first);

  const second = sampleSnapshot();
  second.agents[0].status = "completed";
  second.agents[0].updatedAt = 200;
  second.agents[0].events[0].type = "must_not_replace_existing_event";
  second.agents[0].events.push({
    id: "event_2",
    type: "run_terminal",
    agent_id: "agent_1",
    execution_id: "execution_1",
    run_seq: 1,
    created_at: 200,
    data: { status: "completed" },
  });
  second.agents[0].executions[0].checkpoints[0].result = "must not replace existing checkpoint";
  second.agents[0].executions[0].checkpoints.push({ step: 2, result: "done", createdAt: 190 });
  store.save(second);

  assert.equal(store.revision, 2);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events"), 2);
  assert.equal(activeDb.scalar("SELECT event_type FROM events WHERE event_id = 'event_1'"), "run_started");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM checkpoints"), 2);
  assert.match(activeDb.scalar("SELECT checkpoint_json FROM checkpoints WHERE checkpoint_id = 'execution_1:1'"), /working/);
  assert.equal(activeDb.scalar("SELECT status FROM agents WHERE agent_id = 'agent_1'"), "completed");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM path_claims WHERE active = 1"), 0);
});

test("legacy snapshot migrates atomically without deleting the v1 source table", () => {
  activeDb = createAndroidDb();
  const legacy = sampleSnapshot();
  activeDb.execSQL(
    "CREATE TABLE collaboration_snapshot (" +
    "snapshot_id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, " +
    "snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  const escaped = JSON.stringify(legacy).replace(/'/g, "''");
  activeDb.execSQL(
    `INSERT INTO collaboration_snapshot VALUES (1, 1, '${escaped}', 1234)`
  );

  const store = createCollaborationStore();
  assert.equal(store.mode, "sqlite");
  assert.equal(store.migration, "snapshot_v1_to_event_store_v4");
  assert.equal(store.revision, 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM collaboration_snapshot"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agents"), 1);
  assert.deepEqual(store.load().agents, legacy.agents);
});

test("failed migration preserves legacy data and degrades with the same Store API", () => {
  activeDb = createAndroidDb();
  const legacy = sampleSnapshot();
  activeDb.execSQL(
    "CREATE TABLE collaboration_snapshot (" +
    "snapshot_id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, " +
    "snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  const escaped = JSON.stringify(legacy).replace(/'/g, "''");
  activeDb.execSQL(`INSERT INTO collaboration_snapshot VALUES (1, 1, '${escaped}', 1234)`);
  activeDb.setFailure((sql) => sql.startsWith("INSERT OR REPLACE INTO agents"));

  const store = createCollaborationStore();
  assert.equal(store.mode, "memory");
  assert.equal(store.persistenceModel, "event_store");
  assert.equal(store.migration, "legacy_snapshot_memory_fallback");
  assert.match(store.reason, /injected SQLite failure/);
  assert.deepEqual(store.load(), legacy);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM collaboration_snapshot"), 1);
  assert.equal(
    activeDb.scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_meta'"),
    0
  );
});

test("failed save rolls back projections, append-only rows, and revision", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const first = sampleSnapshot();
  store.save(first);
  activeDb.setFailure((sql) => sql.startsWith("INSERT OR REPLACE INTO messages"));

  const changed = sampleSnapshot();
  changed.agents[0].name = "must roll back";
  changed.agents[0].events.push({
    id: "event_rollback",
    type: "must_roll_back",
    agent_id: "agent_1",
    execution_id: "execution_1",
    run_seq: 1,
    created_at: 300,
    data: {},
  });
  assert.throws(() => store.save(changed), /injected SQLite failure/);
  activeDb.setFailure(null);

  assert.equal(store.revision, 1);
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'revision'"), "1");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events"), 1);
  assert.equal(store.load().agents[0].name, "writer");
});

test("failed incremental save rolls back the selected projection and revision", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const changed = sampleSnapshot().agents[0];
  changed.name = "must roll back incrementally";
  changed.events.push({
    id: "event_incremental_rollback",
    type: "must_roll_back",
    agent_id: "agent_1",
    execution_id: "execution_1",
    run_seq: 1,
    created_at: 300,
    data: {},
  });
  activeDb.setFailure((sql) => sql.includes("event_incremental_rollback"));
  assert.throws(() => store.saveAgent(changed), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, 1);
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'revision'"), "1");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_id = 'event_incremental_rollback'"), 0);
  assert.equal(store.load().agents[0].name, "writer");
});

test("incremental save keeps late events with earlier timestamps and ignores duplicate IDs", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());

  const changed = sampleSnapshot().agents[0];
  changed.events.push({
    id: "event_late",
    type: "late_event",
    agent_id: "agent_1",
    execution_id: "execution_1",
    run_seq: 1,
    created_at: 90,
    data: { late: true },
  });
  store.saveAgent(changed);
  store.saveAgent(changed);

  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_id = 'event_late'"), 1);
  assert.equal(activeDb.scalar("SELECT created_at FROM events WHERE event_id = 'event_late'"), 90);
});


test("incremental save updates only selected agents and appends new rows once", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const initial = sampleSnapshot();
  const unrelated = sampleSnapshot().agents[0];
  unrelated.id = "agent_unrelated";
  unrelated.name = "unrelated";
  unrelated.executions[0].id = "execution_unrelated";
  unrelated.executions[0].agentId = unrelated.id;
  unrelated.executions[0].epoch = `${unrelated.id}:1:1`;
  unrelated.executions[0].rootAgentId = unrelated.id;
  unrelated.executions[0].rootRunId = unrelated.executions[0].id;
  unrelated.currentExecutionId = unrelated.executions[0].id;
  unrelated.events[0].id = "event_unrelated";
  unrelated.events[0].agent_id = unrelated.id;
  unrelated.events[0].execution_id = unrelated.executions[0].id;
  unrelated.events[0].data.epoch = unrelated.executions[0].epoch;
  unrelated.inbox = [];
  initial.agents.push(unrelated);
  store.save(initial);

  const unrelatedRevision = activeDb.scalar("SELECT revision FROM agents WHERE agent_id = 'agent_unrelated'");
  const changed = sampleSnapshot().agents[0];
  changed.status = "completed";
  changed.updatedAt = 200;
  changed.executions[0].status = "completed";
  changed.executions[0].physicalStatus = "terminal";
  changed.executions[0].completedAt = 200;
  changed.executions[0].checkpoints.push({ step: 2, result: "done", createdAt: 190 });
  changed.events.push({
    id: "event_incremental",
    type: "run_terminal",
    agent_id: "agent_1",
    execution_id: "execution_1",
    run_seq: 1,
    created_at: 200,
    data: { status: "completed" },
  });
  store.saveAgent(changed);
  const revisionAfterFirst = store.revision;

  assert.equal(activeDb.scalar("SELECT status FROM agents WHERE agent_id = 'agent_1'"), "completed");
  assert.equal(activeDb.scalar("SELECT revision FROM agents WHERE agent_id = 'agent_unrelated'"), unrelatedRevision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_id = 'event_incremental'"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM checkpoints WHERE checkpoint_id = 'execution_1:2'"), 1);

  store.saveAgent(changed);
  assert.equal(store.revision, revisionAfterFirst + 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_id = 'event_incremental'"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM checkpoints WHERE checkpoint_id = 'execution_1:2'"), 1);
});

test("incremental save cost does not scale with unrelated history", () => {
  activeDb = createAndroidDb();
  let statementCount = 0;
  const originalExec = activeDb.execSQL;
  activeDb.execSQL = (sql) => {
    statementCount += 1;
    return originalExec(sql);
  };
  const store = createCollaborationStore();
  const large = sampleSnapshot();
  for (let index = 0; index < 300; index += 1) {
    const value = JSON.parse(JSON.stringify(large.agents[0]));
    value.id = `history_agent_${index}`;
    value.name = value.id;
    value.inbox = [];
    value.events = [];
    value.executions[0].id = `history_execution_${index}`;
    value.executions[0].agentId = value.id;
    value.executions[0].epoch = `${value.id}:1:1`;
    value.executions[0].rootAgentId = value.id;
    value.executions[0].rootRunId = value.executions[0].id;
    value.currentExecutionId = value.executions[0].id;
    large.agents.push(value);
  }
  store.save(large);
  const changed = large.agents[0];
  changed.toolCount = 2;
  changed.updatedAt = 300;
  statementCount = 0;
  store.saveAgent(changed);
  assert.ok(statementCount < 20, `incremental save used ${statementCount} SQL writes`);
});

test("request ledger commits business state atomically and rejects conflicting retries", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const changed = sampleSnapshot().agents[0];
  changed.name = "ledger committed agent";
  changed.updatedAt = 300;
  const request = {
    requestId: "send-ledger-1",
    operation: "send_message",
    fingerprint: JSON.stringify({ agent_id: "agent_1", message: "once" }),
    result: { agent_id: "agent_1", message_id: "message_ledger_1" },
  };
  const committed = store.commitRequest(request, [changed]);
  assert.equal(committed.deduplicated, false);
  assert.equal(store.getRequest("send-ledger-1", "send_message").result.message_id, "message_ledger_1");
  assert.equal(JSON.parse(activeDb.scalar("SELECT state_json FROM agents WHERE agent_id = 'agent_1'")).name, "ledger committed agent");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM request_ledger"), 1);
  const revision = store.revision;
  const retried = store.commitRequest(request, [changed]);
  assert.equal(retried.deduplicated, true);
  assert.equal(store.revision, revision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM request_ledger"), 1);
  assert.throws(() => store.commitRequest({ ...request, fingerprint: "different" }, [changed]), /request_id conflict/);
  const reopened = createCollaborationStore();
  assert.equal(reopened.getRequest("send-ledger-1", "send_message").result.message_id, "message_ledger_1");
  reopened.close();
});

test("request ledger and business projections roll back together on failure", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const changed = sampleSnapshot().agents[0];
  changed.name = "must roll back with ledger";
  changed.updatedAt = 300;
  activeDb.setFailure((sql) => sql.startsWith("INSERT INTO request_ledger"));
  assert.throws(() => store.commitRequest({
    requestId: "rollback-ledger-1",
    operation: "followup_task",
    fingerprint: "followup-fingerprint",
    result: { agent_id: "agent_1", run_id: "execution_2" },
  }, [changed]), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, 1);
  assert.equal(store.getRequest("rollback-ledger-1", "followup_task"), null);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM request_ledger"), 0);
  assert.equal(JSON.parse(activeDb.scalar("SELECT state_json FROM agents WHERE agent_id = 'agent_1'")).name, "writer");
});

test("side-effect ledger reuses committed results and blocks prepared or unknown effects", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const request = {
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 2,
    operation: "write_file",
    request_hash: "hash_1",
  };
  const prepared = store.prepareEffect(request);
  assert.equal(prepared.disposition, "execute");
  assert.equal(prepared.effect.status, "prepared");
  assert.equal(store.prepareEffect(request).disposition, "blocked");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'effect_prepared'"), 1);

  const committed = store.resolveEffect(prepared.effect.effectKey, "committed", { hash: "after" });
  assert.equal(committed.status, "committed");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'effect_committed'"), 1);
  const reused = store.prepareEffect(request);
  assert.equal(reused.disposition, "reuse");
  assert.deepEqual(reused.effect.result, { hash: "after" });
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'effect_reused'"), 1);
  assert.throws(() => store.resolveEffect(prepared.effect.effectKey, "unknown", null), /cannot transition/);

  const unknownRequest = { ...request, request_hash: "hash_2" };
  const unknown = store.prepareEffect(unknownRequest);
  store.resolveEffect(unknown.effect.effectKey, "unknown", { reason: "runtime restarted" });
  assert.equal(store.prepareEffect(unknownRequest).disposition, "blocked");
});

test("side-effect ledger rejects effects without an owning execution epoch", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  assert.throws(() => store.prepareEffect({
    execution_epoch: "missing:1:1",
    checkpoint_step: 0,
    operation: "write_file",
    request_hash: "hash_missing",
  }), /execution epoch not found/);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM side_effects"), 0);
  assert.equal(store.revision, 0);
});

test("schema v2 migrates atomically to v4 with attempt and tree context projections", () => {
  activeDb = createAndroidDb();
  const first = createCollaborationStore();
  first.save(sampleSnapshot());
  activeDb.execSQL("DROP TABLE run_attempts");
  activeDb.execSQL("UPDATE collaboration_meta SET meta_value = '2' WHERE meta_key = 'schema_version'");

  const migrated = createCollaborationStore();
  assert.equal(migrated.mode, "sqlite");
  assert.equal(migrated.migration, "event_store_v2_to_v4");
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'schema_version'"), "4");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM run_attempts"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_events"), 0);
  assert.equal(activeDb.scalar("SELECT execution_epoch FROM run_attempts"), "agent_1:1:1");
});

test("schema v3 migrates atomically to v4 with empty tree context projections", () => {
  activeDb = createAndroidDb();
  const first = createCollaborationStore();
  first.save(sampleSnapshot());
  activeDb.execSQL("DROP TABLE tree_context_events");
  activeDb.execSQL("DROP TABLE tree_context_snapshots");
  activeDb.execSQL("DROP TABLE agent_context_cursors");
  activeDb.execSQL("UPDATE collaboration_meta SET meta_value = '3' WHERE meta_key = 'schema_version'");

  const migrated = createCollaborationStore();
  assert.equal(migrated.mode, "sqlite");
  assert.equal(migrated.migration, "event_store_v3_to_v4");
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'schema_version'"), "4");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_events"), 0);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_snapshots"), 0);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agent_context_cursors"), 0);
  assert.equal(migrated.load().agents.length, 1);
});

test("schema v2 migration marks prepared effects unknown in the same transaction", () => {
  activeDb = createAndroidDb();
  const first = createCollaborationStore();
  first.save(sampleSnapshot());
  const prepared = first.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "write_file",
    request_hash: "hash_v2_restart",
  });
  activeDb.execSQL("DROP TABLE run_attempts");
  activeDb.execSQL("UPDATE collaboration_meta SET meta_value = '2' WHERE meta_key = 'schema_version'");

  const migrated = createCollaborationStore();
  assert.equal(migrated.migration, "event_store_v2_to_v4_prepared_effects_marked_unknown");
  assert.equal(migrated.getEffect(prepared.effect.effectKey).status, "unknown");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'effect_state_unknown'"), 1);
});

test("recovery snapshot and old-attempt audit commit atomically", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const recovered = sampleSnapshot();
  const run = recovered.agents[0].executions[0];
  run.attempt = 2;
  run.epoch = "agent_1:1:2";
  run.status = "queued";
  run.physicalStatus = "queued";
  run.startedAt = 0;
  const priorRecord = {
    attemptId: "execution_1:1",
    runId: "execution_1",
    agentId: "agent_1",
    runSeq: 1,
    attempt: 1,
    executionEpoch: "agent_1:1:1",
    status: "orphaned",
    recoveryReason: "restart",
    contextReplayed: false,
    createdAt: 100,
    startedAt: 105,
    completedAt: 200,
  };
  activeDb.setFailure((sql) => sql.startsWith("INSERT OR REPLACE INTO runs") && sql.includes("agent_1:1:2"));
  assert.throws(() => store.saveRecovery(recovered, [priorRecord]), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, 1);
  assert.equal(activeDb.scalar("SELECT attempt FROM runs WHERE run_id = 'execution_1'"), 1);
  assert.equal(activeDb.scalar("SELECT status FROM run_attempts WHERE execution_epoch = 'agent_1:1:1'"), "running");
});

test("stale attempts and non-terminal rewrites cannot overwrite a newer or terminal run", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const first = sampleSnapshot();
  store.save(first);
  const second = sampleSnapshot();
  second.agents[0].status = "completed";
  second.agents[0].executions[0].status = "completed";
  second.agents[0].executions[0].physicalStatus = "terminal";
  second.agents[0].executions[0].completedAt = 200;
  store.save(second);
  assert.throws(() => store.save(first), /stored terminal status/);

  const recovered = sampleSnapshot();
  recovered.agents[0].executions[0].attempt = 2;
  recovered.agents[0].executions[0].epoch = "agent_1:1:2";
  recovered.agents[0].status = "queued";
  recovered.agents[0].executions[0].status = "queued";
  assert.throws(() => store.save(recovered), /stored terminal status/);
  assert.equal(store.revision, 2);
  assert.equal(activeDb.scalar("SELECT status FROM runs WHERE run_id = 'execution_1'"), "completed");
});

test("opening schema v4 marks prepared effects unknown without re-executing them", () => {
  activeDb = createAndroidDb();
  const first = createCollaborationStore();
  first.save(sampleSnapshot());
  const prepared = first.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "edit_file",
    request_hash: "hash_restart",
  });
  assert.equal(prepared.effect.status, "prepared");

  const reopened = createCollaborationStore();
  assert.equal(reopened.migration, "prepared_effects_marked_unknown");
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM events WHERE event_type = 'effect_state_unknown'"), 1);
  const effect = reopened.getEffect(prepared.effect.effectKey);
  assert.equal(effect.status, "unknown");
  assert.equal(reopened.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "edit_file",
    request_hash: "hash_restart",
  }).disposition, "blocked");
});

test("event store deletes Agent-owned projections and ledgers atomically", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const snapshot = sampleSnapshot();
  snapshot.agents[0].status = "completed";
  snapshot.agents[0].executions[0].status = "completed";
  snapshot.agents[0].executions[0].physicalStatus = "terminal";
  snapshot.agents[0].executions[0].completedAt = 200;
  store.save(snapshot);
  store.commitRequest({
    requestId: "delete_projection_request",
    operation: "spawn_agent",
    fingerprint: "fingerprint",
    result: { agent: { id: "agent_1" } },
  });
  store.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "write_file",
    request_hash: "delete_projection_effect",
  });

  assert.equal(store.deleteAgents(["agent_1"]), 1);
  for (const table of ["agents", "runs", "run_attempts", "messages", "events", "checkpoints", "path_claims", "side_effects", "request_ledger"]) {
    assert.equal(activeDb.scalar(`SELECT COUNT(*) FROM ${table}`), 0, `${table} must be cleared`);
  }
  assert.equal(store.load().agents.length, 0);
});


test("event store batches large Agent deletion cascades in one transaction", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const snapshot = batchSnapshot(501);
  store.save(snapshot);
  activeDb.setInListLimit(500);

  const requestedIds = snapshot.agents.map((agent) => agent.id);
  requestedIds.push("batch_agent_0", "", "missing_agent");
  assert.equal(store.deleteAgents(requestedIds), 501);
  for (const table of ["agents", "runs", "run_attempts", "messages", "events", "checkpoints", "path_claims"]) {
    assert.equal(activeDb.scalar(`SELECT COUNT(*) FROM ${table}`), 0, `${table} must be cleared`);
  }
});


test("event store rolls back batched Agent deletion when a later batch fails", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const snapshot = batchSnapshot(501);
  store.save(snapshot);
  let agentDeleteBatch = 0;
  activeDb.setFailure((sql) => {
    if (!sql.startsWith("DELETE FROM agents WHERE agent_id IN")) return false;
    agentDeleteBatch += 1;
    return agentDeleteBatch === 2;
  });

  assert.throws(
    () => store.deleteAgents(snapshot.agents.map((agent) => agent.id)),
    /injected SQLite failure/
  );
  activeDb.setFailure(null);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agents"), 501);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM runs"), 501);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM run_attempts"), 501);
});


test("event store rolls back Agent deletion when a cascade step fails", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.save(sampleSnapshot());
  const revision = store.revision;
  activeDb.setFailure((sql) => sql.startsWith("DELETE FROM runs"));
  assert.throws(() => store.deleteAgents(["agent_1"]), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, revision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agents"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM runs"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM run_attempts"), 1);
});


test("memory event store clones state and follows attempt and effect semantics", () => {
  const store = memoryStore("SQLite unavailable");
  const snapshot = sampleSnapshot();
  store.save(snapshot);
  snapshot.agents[0].name = "external mutation";
  assert.equal(store.mode, "memory");
  assert.equal(store.schemaVersion, 4);
  assert.equal(store.persistenceModel, "event_store");
  assert.equal(store.revision, 1);
  assert.equal(store.load().agents[0].name, "writer");
  assert.equal(store.listAttempts("execution_1").length, 1);

  const prepared = store.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "write_file",
    request_hash: "memory_hash",
  });
  assert.equal(prepared.disposition, "execute");
  store.resolveEffect(prepared.effect.effectKey, "committed", { ok: true });
  assert.equal(store.prepareEffect({
    execution_epoch: "agent_1:1:1",
    checkpoint_step: 1,
    operation: "write_file",
    request_hash: "memory_hash",
  }).disposition, "reuse");
  const eventTypes = store.load().agents[0].events.map((event) => event.type);
  assert.equal(eventTypes.includes("effect_prepared"), true);
  assert.equal(eventTypes.includes("effect_committed"), true);
  assert.equal(eventTypes.includes("effect_reused"), true);
  assert.throws(() => store.prepareEffect({
    execution_epoch: "missing:1:1",
    checkpoint_step: 0,
    operation: "write_file",
    request_hash: "missing_memory_hash",
  }), /execution epoch not found/);
  assert.equal(store.deleteAgents(["agent_1"]), 1);
  assert.equal(store.load().agents.length, 0);
  assert.equal(store.listAttempts("execution_1").length, 0);
  assert.equal(store.getEffect(prepared.effect.effectKey), null);
});

test("tree context events are revisioned, idempotent, materialized and cursor-backed", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  assert.equal(store.schemaVersion, 4);
  assert.equal(activeDb.scalar("SELECT meta_value FROM collaboration_meta WHERE meta_key = 'schema_version'"), "4");
  const first = store.appendTreeContextEvent({
    eventId: "tree_event_1",
    rootRunId: "root_run_1",
    sourceAgentId: "agent_parent",
    sourceRunId: "parent_run",
    sourceEpoch: "agent_parent:1:1",
    kind: "checkpoint",
    visibility: "tree",
    payload: { step: 1, result: "parent fact" },
    idempotencyKey: "checkpoint:parent_run:1",
    committedAt: 100,
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.event.revision, 1);
  const duplicate = store.appendTreeContextEvent({
    eventId: "tree_event_retry",
    rootRunId: "root_run_1",
    sourceAgentId: "agent_parent",
    sourceRunId: "parent_run",
    sourceEpoch: "agent_parent:1:1",
    kind: "checkpoint",
    visibility: "tree",
    payload: { step: 1, result: "parent fact" },
    idempotencyKey: "checkpoint:parent_run:1",
    committedAt: 200,
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.event.eventId, "tree_event_1");
  assert.equal(store.revision, 1);
  assert.throws(() => store.appendTreeContextEvent({
    rootRunId: "root_run_1",
    sourceAgentId: "agent_parent",
    sourceRunId: "parent_run",
    sourceEpoch: "agent_parent:1:1",
    kind: "checkpoint",
    visibility: "tree",
    payload: { step: 1, result: "conflict" },
    idempotencyKey: "checkpoint:parent_run:1",
  }), /idempotency collision/);

  store.saveAgentContextCursor({
    rootRunId: "root_run_1",
    agentId: "agent_sibling",
    lastAppliedRevision: 0,
    dirtyRevision: 0,
    updatedAt: 110,
  });
  const second = store.appendTreeContextEvent({
    eventId: "tree_event_2",
    rootRunId: "root_run_1",
    sourceAgentId: "agent_child",
    sourceRunId: "child_run",
    sourceEpoch: "agent_child:1:1",
    kind: "decision",
    visibility: "tree",
    payload: { text: "child decision" },
    idempotencyKey: "decision:child_run:1",
    committedAt: 120,
  });
  assert.equal(second.event.revision, 3);
  assert.deepEqual(store.listTreeContextEvents("root_run_1", first.event.revision).map((event) => event.eventId), ["tree_event_2"]);
  assert.equal(store.listTreeContextEvents("other_root", 0).length, 0);
  assert.equal(store.getTreeContextSnapshot("root_run_1").revision, second.event.revision);
  assert.deepEqual(store.getTreeContextSnapshot("root_run_1").events.map((event) => event.eventId), ["tree_event_1", "tree_event_2"]);
  assert.equal(store.getAgentContextCursor("root_run_1", "agent_sibling").dirtyRevision, second.event.revision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_events"), 2);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_snapshots"), 1);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM agent_context_cursors"), 1);

  const reopened = createCollaborationStore();
  assert.equal(reopened.getTreeContextSnapshot("root_run_1").revision, second.event.revision);
  assert.equal(reopened.getAgentContextCursor("root_run_1", "agent_sibling").dirtyRevision, second.event.revision);
  reopened.close();
});

test("tree context and Agent checkpoint projections commit atomically", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  const snapshot = sampleSnapshot();
  store.save(snapshot);
  const changed = structuredClone(snapshot.agents[0]);
  changed.executions[0].checkpoints.push({
    step: 2,
    result: "atomic checkpoint",
    diagnostics: {},
    evidence: null,
    createdAt: 300,
  });
  changed.executions[0].stepCount = 2;
  const committed = store.appendTreeContextEvent({
    eventId: "atomic_checkpoint_event",
    rootRunId: changed.executions[0].rootRunId || changed.executions[0].id,
    sourceAgentId: changed.id,
    sourceRunId: changed.executions[0].id,
    sourceEpoch: changed.executions[0].epoch,
    kind: "checkpoint",
    payload: { step: 2, result: "atomic checkpoint" },
    idempotencyKey: `checkpoint:${changed.executions[0].id}:2`,
    committedAt: 300,
  }, { changedAgents: [changed] });
  assert.equal(committed.checkpoint.treeContextRevision, committed.event.revision);
  assert.equal(JSON.parse(activeDb.scalar("SELECT checkpoint_json FROM checkpoints WHERE step = 2")).treeContextRevision, committed.event.revision);
  assert.equal(store.load().agents[0].executions[0].checkpoints.at(-1).treeContextRevision, committed.event.revision);

  const rollback = structuredClone(changed);
  rollback.name = "must roll back with tree context";
  rollback.executions[0].checkpoints.push({
    step: 3,
    result: "rollback checkpoint",
    diagnostics: {},
    evidence: null,
    createdAt: 400,
  });
  const revision = store.revision;
  activeDb.setFailure((sql) => sql.includes("atomic_rollback_event"));
  assert.throws(() => store.appendTreeContextEvent({
    eventId: "atomic_rollback_event",
    rootRunId: rollback.executions[0].rootRunId || rollback.executions[0].id,
    sourceAgentId: rollback.id,
    sourceRunId: rollback.executions[0].id,
    sourceEpoch: rollback.executions[0].epoch,
    kind: "checkpoint",
    payload: { step: 3, result: "rollback checkpoint" },
    idempotencyKey: `checkpoint:${rollback.executions[0].id}:3`,
    committedAt: 400,
  }, { changedAgents: [rollback] }), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, revision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM checkpoints WHERE step = 3"), 0);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_events WHERE event_id = 'atomic_rollback_event'"), 0);
  assert.equal(JSON.parse(activeDb.scalar("SELECT state_json FROM agents WHERE agent_id = 'agent_1'")).name, "writer");
});

test("tree context event transaction rolls back event, snapshot, cursor and revision together", () => {
  activeDb = createAndroidDb();
  const store = createCollaborationStore();
  store.saveAgentContextCursor({
    rootRunId: "rollback_root",
    agentId: "rollback_agent",
    lastAppliedRevision: 0,
    dirtyRevision: 0,
    updatedAt: 100,
  });
  const revision = store.revision;
  activeDb.setFailure((sql) => sql.startsWith("INSERT OR REPLACE INTO tree_context_snapshots"));
  assert.throws(() => store.appendTreeContextEvent({
    eventId: "rollback_tree_event",
    rootRunId: "rollback_root",
    sourceAgentId: "source_agent",
    sourceRunId: "source_run",
    sourceEpoch: "source_agent:1:1",
    kind: "checkpoint",
    payload: { result: "must roll back" },
    idempotencyKey: "checkpoint:source_run:1",
  }), /injected SQLite failure/);
  activeDb.setFailure(null);
  assert.equal(store.revision, revision);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_events"), 0);
  assert.equal(activeDb.scalar("SELECT COUNT(*) FROM tree_context_snapshots"), 0);
  assert.equal(store.getAgentContextCursor("rollback_root", "rollback_agent").dirtyRevision, 0);
});

test("memory event store mirrors tree context revision, snapshot and cursor semantics", () => {
  const store = memoryStore("SQLite unavailable");
  const first = store.appendTreeContextEvent({
    eventId: "memory_tree_event",
    rootRunId: "memory_root",
    sourceAgentId: "memory_agent",
    sourceRunId: "memory_run",
    sourceEpoch: "memory_agent:1:1",
    kind: "fact",
    payload: { fact: "persisted in memory" },
    idempotencyKey: "fact:memory:1",
  });
  store.saveAgentContextCursor({
    rootRunId: "memory_root",
    agentId: "memory_consumer",
    lastAppliedRevision: first.event.revision,
    dirtyRevision: first.event.revision,
    updatedAt: 200,
  });
  assert.equal(store.listTreeContextEvents("memory_root", 0).length, 1);
  assert.equal(store.getTreeContextSnapshot("memory_root").events[0].payload.fact, "persisted in memory");
  assert.equal(store.getAgentContextCursor("memory_root", "memory_consumer").lastAppliedRevision, first.event.revision);
  const duplicate = store.appendTreeContextEvent({
    rootRunId: "memory_root",
    sourceAgentId: "memory_agent",
    sourceRunId: "memory_run",
    sourceEpoch: "memory_agent:1:1",
    kind: "fact",
    payload: { fact: "persisted in memory" },
    idempotencyKey: "fact:memory:1",
  });
  assert.equal(duplicate.deduplicated, true);
});

test("event store reports why SQLite is unavailable", () => {
  global.Java.getApplicationContext = () => ({});
  const store = createCollaborationStore();
  assert.equal(store.mode, "memory");
  assert.match(store.reason, /openOrCreateDatabase/);
  global.Java.getApplicationContext = () => ({ openOrCreateDatabase: () => activeDb });
});