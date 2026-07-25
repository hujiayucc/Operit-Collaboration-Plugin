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

const { createCollaborationManager } = require("../src/collaboration/manager.js");
const { createAgent, createExecution } = require("../src/collaboration/model.js");
const {
  SUPPRESSED_PROMPT_ECHO_RESULT,
  isPathWithin,
  normalizePath,
  parseControlEnvelope,
  parseMessageAcks,
  pathsOverlap,
  safePublicResult,
  stripControlEnvelopes,
  stripMessageAcks,
  stripTransportControls,
} = require("../src/collaboration/helpers.js");

test("normalizes absolute paths and rejects root escapes", () => {
  assert.equal(normalizePath("/repo/src/../test/"), "/repo/test");
  assert.equal(normalizePath("C:\\repo\\src\\..\\test"), "C:/repo/test");
  assert.throws(() => normalizePath("relative/file.js"), /must be absolute/);
  assert.throws(() => normalizePath("/../escape"), /escapes its root/);
});

test("root paths overlap every descendant without prefix false positives", () => {
  assert.equal(pathsOverlap("/", "/repo/file.js"), true);
  assert.equal(pathsOverlap("C:/", "c:/repo/file.js"), true);
  assert.equal(pathsOverlap("/repo/src", "/repo/src-a"), false);
  assert.equal(isPathWithin("/repo/src/file.js", "/repo"), true);
  assert.equal(isPathWithin("/other/file.js", "/repo"), false);
});

test("parses and strips message acknowledgements", () => {
  const raw = "done\nCOLLABORATION_MESSAGE_ACKS: [\"message_1\",\"message_2\"]";
  assert.deepEqual(parseMessageAcks(raw), ["message_1", "message_2"]);
  assert.equal(stripMessageAcks(raw), "done");
});

test("accepts only a valid final structured control envelope and strips transport controls", () => {
  const stale = {
    version: 1,
    execution_epoch: "agent_1:1:1",
    action: "progress",
    message_acks: [],
    error: "",
  };
  const final = {
    version: 1,
    execution_epoch: "agent_1:1:1",
    action: "finish",
    message_acks: ["message_1", "message_1"],
    error: "",
  };
  const raw = [
    "completed safely",
    `COLLABORATION_CONTROL: ${JSON.stringify(stale)}`,
    "text after stale envelope",
    `COLLABORATION_CONTROL: ${JSON.stringify(final)}`,
  ].join("\n");
  const parsed = parseControlEnvelope(raw);
  assert.equal(parsed.present, true);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.control.action, "finish");
  assert.deepEqual(parsed.control.messageAcks, ["message_1"]);
  assert.match(parsed.stripped, /completed safely/);
  assert.equal(stripControlEnvelopes(raw), "completed safely");
  assert.equal(safePublicResult(raw), "completed safely");
});

test("rejects malformed or semantically invalid control without exposing its tail", () => {
  const malformed = "safe result\nCOLLABORATION_CONTROL: {not json";
  const parsedMalformed = parseControlEnvelope(malformed);
  assert.equal(parsedMalformed.present, true);
  assert.equal(parsedMalformed.valid, false);
  assert.match(parsedMalformed.error, /invalid control JSON/);
  assert.equal(parsedMalformed.stripped, "safe result");
  assert.equal(stripTransportControls(malformed), "safe result");

  const missingError = parseControlEnvelope(
    "safe\nCOLLABORATION_CONTROL: " + JSON.stringify({
      version: 1,
      execution_epoch: "agent_1:1:1",
      action: "fail",
      message_acks: [],
      error: "",
    })
  );
  assert.equal(missingError.valid, false);
  assert.match(missingError.error, /requires error/);
});

test("suppresses internal prompt markers in public results", () => {
  assert.equal(
    safePublicResult("COLLABORATION_AGENT_CONSTRAINTS:\nsecret"),
    SUPPRESSED_PROMPT_ECHO_RESULT
  );
  assert.equal(safePublicResult("normal result"), "normal result");
});

test("manager rejects write targets outside the workspace", () => {
  const manager = createCollaborationManager();
  assert.throws(
    () => manager.spawn({
      task: "write outside",
      workspace_path: "/repo",
      target_paths: ["/other/file.js"],
    }),
    /outside workspace/
  );
  manager.shutdown();
});

test("manager rejects missing parents and invalid wait selections", async () => {
  const manager = createCollaborationManager();
  assert.throws(
    () => manager.spawn({ task: "child", parent_agent_id: "agent_missing" }),
    /agent not found/
  );
  assert.throws(() => manager.wait({ agent_ids: [] }), /non-empty array/);
  manager.shutdown();
});

test("list pagination remains stable across hundreds of historical agents", () => {
  const manager = createCollaborationManager();
  const expectedIds = [];
  for (let index = 0; index < 500; index += 1) {
    const agent = createAgent({ name: `history-${index}`, read_only: true });
    agent.id = `history_agent_${String(index).padStart(4, "0")}`;
    agent.createdAt = 1000 + Math.floor(index / 5);
    agent.updatedAt = agent.createdAt;
    const execution = createExecution(agent, `history task ${index}`, "");
    execution.id = `history_execution_${String(index).padStart(4, "0")}`;
    execution.agentId = agent.id;
    execution.epoch = `${agent.id}:1:1`;
    execution.rootAgentId = agent.id;
    execution.rootRunId = execution.id;
    execution.status = "completed";
    execution.physicalStatus = "terminal";
    execution.completedAt = agent.createdAt;
    agent.currentExecutionId = execution.id;
    agent.status = "completed";
    manager.__test.agents.set(agent.id, agent);
    manager.__test.executions.set(execution.id, execution);
    expectedIds.push(agent.id);
  }

  const first = manager.list({});
  assert.equal(first.total, 500);
  assert.equal(first.agents.length, 20);
  assert.equal(first.has_more, true);
  assert.throws(() => manager.list({ limit: 0.5 }), /positive integer/);
  const visited = [];
  let cursor = "";
  do {
    const page = manager.list({ limit: 37, cursor });
    visited.push(...page.agents.map((agent) => agent.id));
    if (!page.has_more) break;
    cursor = page.next_cursor;
    assert.ok(cursor);
  } while (true);
  assert.deepEqual(visited, expectedIds);
  assert.equal(new Set(visited).size, 500);

  const selected = manager.list({
    agent_ids: expectedIds.slice(0, 125),
    limit: 1,
    cursor: "invalid cursor is ignored for exact ids",
  });
  assert.equal(selected.agents.length, 125);
  assert.equal(selected.has_more, false);
  manager.shutdown();
});