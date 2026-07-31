"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function javaProxy(path = "Java") {
  const callable = function () {};
  return new Proxy(callable, {
    get(_target, property) {
      if (property === "toString") return () => path;
      return javaProxy(`${path}.${String(property)}`);
    },
    apply() {
      return javaProxy(`${path}()`);
    },
    construct() {
      return {};
    },
  });
}

global.Java = javaProxy();
global.Java.getApplicationContext = () => ({});

const { createCollaborationManager } = require("../dist/collaboration/manager.js");
const { createAgent, createExecution } = require("../dist/collaboration/model.js");
const { memoryStore } = require("../dist/collaboration/store.js");

function attach(manager, id, relation = {}) {
  const agent = createAgent({ name: id, read_only: true });
  agent.id = id;
  const execution = createExecution(agent, `${id} task`, "", relation);
  execution.id = `${id}_run`;
  execution.agentId = id;
  execution.epoch = `${id}:1:1`;
  execution.rootAgentId = relation.rootAgentId || id;
  execution.rootRunId = relation.rootRunId || execution.id;
  execution.parentRunId = relation.parentRunId || "";
  execution.treeDepth = relation.treeDepth || 0;
  agent.currentExecutionId = execution.id;
  manager.__test.agents.set(agent.id, agent);
  manager.__test.executions.set(execution.id, execution);
  return { agent, execution };
}

function sharedTurn(manager, entry) {
  return manager.__test.sharedContextFor(entry.agent, entry.execution)
    .find((turn) => turn.content.includes("TREE_SHARED_CONTEXT"));
}

function appendFact(store, rootRunId, index) {
  return store.appendTreeContextEvent({
    eventId: `event_${index}`,
    rootRunId,
    sourceAgentId: "producer",
    sourceRunId: "producer_run",
    sourceEpoch: "producer:1:1",
    kind: "fact",
    visibility: "tree",
    payload: `fact_${String(index).padStart(3, "0")}`,
    idempotencyKey: `fact:${index}`,
    committedAt: 1000 + index,
  }).event;
}

test("tree context materialization gives a new consumer a snapshot and existing consumers only increments", () => {
  const store = memoryStore("tree context materialization test");
  const manager = createCollaborationManager({ store });
  try {
    const root = attach(manager, "root");
    const child = attach(manager, "child", {
      parentRunId: root.execution.id,
      rootAgentId: root.agent.id,
      rootRunId: root.execution.id,
      treeDepth: 1,
    });
    store.appendTreeContextEvent({
      eventId: "root_checkpoint",
      rootRunId: root.execution.id,
      sourceAgentId: root.agent.id,
      sourceRunId: root.execution.id,
      sourceEpoch: root.execution.epoch,
      kind: "checkpoint",
      visibility: "tree",
      payload: { step: 1, result: "root checkpoint fact" },
      idempotencyKey: `checkpoint:${root.execution.id}:1`,
    });
    appendFact(store, root.execution.id, 1);

    const first = sharedTurn(manager, child);
    assert.ok(first);
    assert.match(first.content, /root checkpoint fact/);
    assert.match(first.content, /fact_001/);
    assert.equal(sharedTurn(manager, child), undefined);

    appendFact(store, root.execution.id, 2);
    const incremental = sharedTurn(manager, child);
    assert.ok(incremental);
    assert.match(incremental.content, /fact_002/);
    assert.doesNotMatch(incremental.content, /root checkpoint fact|fact_001/);
    assert.equal(sharedTurn(manager, child), undefined);
  } finally {
    manager.shutdown();
  }
});

test("tree context cursor advances one bounded increment at a time without skipping unread events", () => {
  const store = memoryStore("tree context pagination test");
  const manager = createCollaborationManager({ store });
  try {
    const root = attach(manager, "page_root");
    const child = attach(manager, "page_child", {
      parentRunId: root.execution.id,
      rootAgentId: root.agent.id,
      rootRunId: root.execution.id,
      treeDepth: 1,
    });
    store.saveAgentContextCursor({
      rootRunId: root.execution.id,
      agentId: child.agent.id,
      lastAppliedRevision: 0,
      dirtyRevision: 0,
      updatedAt: 1,
    });
    for (let index = 0; index < 85; index += 1) appendFact(store, root.execution.id, index);

    const first = sharedTurn(manager, child);
    assert.ok(first);
    assert.match(first.content, /fact_000/);
    assert.match(first.content, /fact_079/);
    assert.doesNotMatch(first.content, /fact_080/);
    const firstCursor = store.getAgentContextCursor(root.execution.id, child.agent.id);

    const second = sharedTurn(manager, child);
    assert.ok(second);
    assert.match(second.content, /fact_080/);
    assert.match(second.content, /fact_084/);
    assert.doesNotMatch(second.content, /fact_079/);
    const secondCursor = store.getAgentContextCursor(root.execution.id, child.agent.id);
    assert.ok(secondCursor.lastAppliedRevision > firstCursor.lastAppliedRevision);
    assert.equal(secondCursor.lastAppliedRevision, store.getTreeContextSnapshot(root.execution.id).revision);
    assert.equal(sharedTurn(manager, child), undefined);
  } finally {
    manager.shutdown();
  }
});

test("tree context byte limits advance only through the materialized revision prefix", () => {
  const store = memoryStore("tree context byte budget test");
  const manager = createCollaborationManager({ store });
  try {
    const root = attach(manager, "bytes_root");
    const child = attach(manager, "bytes_child", {
      parentRunId: root.execution.id,
      rootAgentId: root.agent.id,
      rootRunId: root.execution.id,
      treeDepth: 1,
    });
    store.saveAgentContextCursor({
      rootRunId: root.execution.id,
      agentId: child.agent.id,
      lastAppliedRevision: 0,
      dirtyRevision: 0,
      updatedAt: 1,
    });
    for (let index = 0; index < 10; index += 1) {
      store.appendTreeContextEvent({
        eventId: `large_event_${index}`,
        rootRunId: root.execution.id,
        sourceAgentId: "producer",
        sourceRunId: "producer_run",
        sourceEpoch: "producer:1:1",
        kind: "fact",
        visibility: "tree",
        payload: `large_${String(index).padStart(2, "0")}:${"x".repeat(3900)}`,
        idempotencyKey: `large:${index}`,
      });
    }

    const first = sharedTurn(manager, child);
    assert.ok(first);
    assert.match(first.content, /large_00/);
    assert.doesNotMatch(first.content, /large_09/);
    const firstCursor = store.getAgentContextCursor(root.execution.id, child.agent.id);
    assert.ok(firstCursor.lastAppliedRevision < store.getTreeContextSnapshot(root.execution.id).revision);

    const second = sharedTurn(manager, child);
    assert.ok(second);
    assert.doesNotMatch(second.content, /large_00/);
    assert.match(second.content, /large_07/);
    const secondCursor = store.getAgentContextCursor(root.execution.id, child.agent.id);
    assert.ok(secondCursor.lastAppliedRevision > firstCursor.lastAppliedRevision);
    assert.equal(secondCursor.lastAppliedRevision, store.getTreeContextSnapshot(root.execution.id).revision);
    assert.equal(sharedTurn(manager, child), undefined);
  } finally {
    manager.shutdown();
  }
});

test("memory tree context commits validate related roots before mutating state", () => {
  const store = memoryStore("tree context atomicity test");
  const input = {
    eventId: "atomic_event",
    rootRunId: "root_a",
    sourceAgentId: "producer",
    sourceRunId: "producer_run",
    sourceEpoch: "producer:1:1",
    kind: "fact",
    visibility: "tree",
    payload: "atomic fact",
    idempotencyKey: "atomic:1",
    committedAt: 10,
  };

  assert.throws(() => store.appendTreeContextEvent(input, {
    snapshot: { rootRunId: "root_b", revision: 0, events: [], truncated: false, updatedAt: 10 },
  }), /snapshot rootRunId does not match event rootRunId/);
  assert.equal(store.revision, 0);
  assert.deepEqual(store.listTreeContextEvents("root_a"), []);
  assert.equal(store.getTreeContextSnapshot("root_a"), null);

  assert.throws(() => store.appendTreeContextEvent(input, {
    cursor: {
      rootRunId: "root_b",
      agentId: "consumer",
      lastAppliedRevision: 0,
      dirtyRevision: 0,
      updatedAt: 10,
    },
  }), /cursor rootRunId does not match event rootRunId/);
  assert.equal(store.revision, 0);
  assert.deepEqual(store.listTreeContextEvents("root_a"), []);

  const committed = store.appendTreeContextEvent(input, {
    snapshot: { rootRunId: "root_a", revision: 0, events: [], truncated: false, updatedAt: 10 },
    cursor: {
      rootRunId: "root_a",
      agentId: "consumer",
      lastAppliedRevision: 0,
      dirtyRevision: 0,
      updatedAt: 10,
    },
  });
  assert.equal(store.getTreeContextSnapshot("root_a").events[0].eventId, committed.event.eventId);
  assert.equal(store.getAgentContextCursor("root_a", "consumer").dirtyRevision, committed.event.revision);
});