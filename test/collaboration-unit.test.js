"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

const {
  buildStepEvidence,
  actionGateForAgent,
  collectStream,
} = require("../src/collaboration/engine.js");
const { createCollaborationManager } = require("../src/collaboration/manager.js");
const { createAgent, createExecution, emitEvent, normalizeTimeout } = require("../src/collaboration/model.js");
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

test("summary streams inherit the Run network-idle timeout", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "collaboration", "engine.js"), "utf8");
  assert.doesNotMatch(source, /SUMMARY_TIMEOUT_MS/);
  assert.match(source, /summarize[\s\S]*collectStream\([\s\S]*stream,[\s\S]*execution\.timeoutMs,[\s\S]*result summary stream idle/);
});

test("stream timeout measures network idle gaps instead of total generation time", async () => {
  const chunks = ["alpha", "beta", "gamma", "delta"];
  const stream = {
    async callSuspend(method, collector) {
      assert.equal(method, "collect");
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        collector.emit(chunk);
      }
    },
  };
  const startedAt = Date.now();
  assert.equal(await collectStream(stream, 25, "stream idle"), chunks.join(""));
  assert.ok(Date.now() - startedAt >= 50, "total generation should exceed one idle timeout window");
});


test("stream timeout rejects when no new output arrives within the idle window", async () => {
  const stream = {
    async callSuspend(_method, collector) {
      collector.emit("first");
      await new Promise((resolve) => setTimeout(resolve, 60));
      collector.emit("late");
    },
  };
  await assert.rejects(() => collectStream(stream, 20, "stream network idle"), /stream network idle/);
});


test("timeout normalization accepts only integer host-call bounds", () => {
  assert.equal(normalizeTimeout(undefined), 900000);
  assert.equal(normalizeTimeout(undefined, 45000), 45000);
  assert.equal(normalizeTimeout(30000), 30000);
  assert.equal(normalizeTimeout(3600000), 3600000);
  for (const value of [29999, 3600001, 30000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeTimeout(value), /timeout_ms must be an integer between 30000 and 3600000/);
  }
});

test("scheduler applies one aging rank every two minutes with a two-rank cap", () => {
  const originalNow = Date.now;
  const timestamp = 1_000_000;
  Date.now = () => timestamp;
  const manager = createCollaborationManager();
  try {
    const rank = (priority, ageMs) => manager.__test.queueRank({
      priority,
      enqueuedAt: timestamp - ageMs,
    });
    assert.equal(rank("low", 119999), 2);
    assert.equal(rank("low", 120000), 1);
    assert.equal(rank("low", 239999), 1);
    assert.equal(rank("low", 240000), 0);
    assert.equal(rank("low", 600000), 0);
    assert.equal(rank("normal", 120000), 0);
    assert.equal(rank("high", 240000), -2);
  } finally {
    manager.shutdown();
    Date.now = originalNow;
  }
});


test("model retry classification excludes deterministic balance and authentication failures", () => {
  const manager = createCollaborationManager();
  try {
    for (const message of [
      "insufficient balance; please recharge",
      "HTTP status 402 payment required",
      "401 unauthorized invalid API key",
      "invalid parameter: model",
      "maximum context length exceeded",
      "content policy rejection",
    ]) {
      assert.equal(manager.__test.classifyModelError(new Error(message)).retryable, false, message);
    }
    for (const message of [
      "network connection reset",
      "request timed out",
      "HTTP 429 too many requests Retry-After: 2",
      "status 503 service unavailable",
      "stream interrupted by upstream",
    ]) {
      assert.equal(manager.__test.classifyModelError(new Error(message)).retryable, true, message);
    }
    assert.equal(manager.__test.classifyModelError(new Error("HTTP 429 Retry-After: 2")).retryAfterMs, 2000);
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      assert.equal(manager.__test.modelRetryDelayMs(1), 1000);
      assert.equal(manager.__test.modelRetryDelayMs(2), 2000);
      assert.equal(manager.__test.modelRetryDelayMs(5), 16000);
      assert.equal(manager.__test.modelRetryDelayMs(12), 16000);
    } finally {
      Math.random = originalRandom;
    }
  } finally {
    manager.shutdown();
  }
});


test("model retry verification gate exposes only read and search tools after an uncertain tool outcome", () => {
  const agent = createAgent({ read_only: false, target_paths: ["/repo/output.md"], workspace_path: "/repo" });
  const execution = createExecution(agent, "update output", "");
  execution.retryVerificationPending = true;
  execution.modelRetryToolOutcomeUnknown = true;
  const gate = actionGateForAgent(agent, execution);
  assert.equal(gate.kind, "model_retry_verification");
  assert.deepEqual(gate.allowedTools.sort(), [
    "find_files",
    "grep_code",
    "grep_context",
    "list_files",
    "read_file",
    "read_file_part",
    "sleep",
  ]);
  assert.equal(gate.allowedTools.includes("edit_file"), false);
});


test("structured tool receipts bind METADATA evidence to invoked source tools", () => {
  const metadata = JSON.stringify({
    name: "source_only",
    tools: [{ name: "alpha", parameters: [{ name: "value", required: false }] }],
  }, null, 2);
  const raw = `<tool_ab name="read_file_part"></tool_ab><tool_result_ab>/* METADATA\n${metadata}\n*/</tool_result_ab>`;
  const evidence = buildStepEvidence(raw, ["read_file_part"]);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.authoritative_metadata[0].package, "source_only");
  assert.equal(evidence.authoritative_metadata[0].source_tool, "read_file_part");
  assert.deepEqual(evidence.authoritative_metadata[0].tools[0].optional, ["value"]);
  assert.deepEqual(buildStepEvidence(raw, ["grep_code"]).authoritative_metadata, []);
});

test("structured tool receipts do not cross-match different qualified packages", () => {
  const raw = '<tool_ab name="package_b:edit_file"><tool_result_ab>{"success":true}</tool_result_ab></tool_ab>';
  assert.deepEqual(buildStepEvidence(raw, ["package_a:edit_file"]).mutation_receipts, []);
  assert.equal(buildStepEvidence(raw, ["edit_file"]).mutation_receipts[0].status, "succeeded");
  assert.equal(buildStepEvidence(raw, ["package_b:edit_file"]).mutation_receipts[0].status, "succeeded");
});

test("emitted events snapshot their top-level data", () => {
  const agent = createAgent({ read_only: true });
  const execution = createExecution(agent, "inspect event data", "");
  const data = { status: "queued" };
  const event = emitEvent(agent, execution, "test_event", data);
  data.status = "completed";
  assert.equal(event.data.status, "queued");
});

test("structured METADATA evidence outranks current-checkpoint text while legacy checkpoints remain compatible", () => {
  const agent = createAgent({
    read_only: false,
    target_paths: ["/repo/output.md"],
    workspace_path: "/repo",
  });
  const execution = createExecution(agent, "Read authoritative METADATA from /repo/source_only.js, then create /repo/output.md", "");
  execution.checkpoints.push({
    step: 1,
    result: "AUTHORITATIVE_METADATA_CONTRACT package=source_only",
    diagnostics: { tool_names: ["read_file"] },
    evidence: { version: 1, authoritative_metadata: [], mutation_receipts: [] },
  });
  assert.equal(actionGateForAgent(agent, execution).kind, "metadata_before_creation");
  delete execution.checkpoints[0].evidence;
  assert.equal(actionGateForAgent(agent, execution), null);
});

test("pending mutation gate recognizes the device checkpoint wording and text-file scope", () => {
  const agent = createAgent({
    read_only: false,
    target_paths: ["/repo/gate.txt"],
    workspace_path: "/repo",
  });
  const execution = createExecution(agent, "Read /repo/gate.txt, replace state=before with state=after, then verify", "");
  execution.checkpoints.push({
    step: 1,
    result: "已完成第 1 次工具调用：回读目标文件成功，确认内容为 state=before。尚未执行将其精确替换为 state=after 的编辑，也未进行最终回读验证。\n\n当前进度：progress。下一检查点应仅调用 edit_file 完成精确替换；目前无阻塞。",
    diagnostics: { tool_names: ["read_file"] },
    evidence: { version: 1, authoritative_metadata: [], mutation_receipts: [] },
  });
  const gate = actionGateForAgent(agent, execution);
  assert.equal(gate.kind, "pending_mutation");
  assert.deepEqual(gate.allowedTools, ["edit_file"]);
  assert.equal(gate.mutationCheckpointIndex, 0);
  execution.checkpoints.push({
    step: 2,
    result: "已完成编辑：state=before 已成功替换为 state=after，仍需最终回读验证。",
    diagnostics: { tool_names: ["edit_file"] },
    evidence: {
      version: 1,
      authoritative_metadata: [],
      mutation_receipts: [{ tool: "edit_file", status: "succeeded" }],
    },
  });
  assert.equal(actionGateForAgent(agent, execution), null);
  execution.checkpoints.push({
    step: 3,
    result: "已完成第 2 次工具调用：已将目标文件中的 state=before 精确替换为 state=after，且仅变更一行。尚未执行第 3 次 read_file 最终回读验证。",
    diagnostics: { tool_names: [] },
    evidence: { version: 1, authoritative_metadata: [], mutation_receipts: [] },
  });
  assert.equal(actionGateForAgent(agent, execution), null);
  execution.checkpoints.push({
    step: 4,
    result: "当前：已按顺序完成 read_file、edit_file，并将文件从 state=before 精确替换为 state=after；仍需在下一检查点仅调用最终 read_file，确认内容后完成。",
    diagnostics: { tool_names: [] },
    evidence: { version: 1, authoritative_metadata: [], mutation_receipts: [] },
  });
  assert.equal(actionGateForAgent(agent, execution), null);
});

test("pending mutation gate binds pending edits and completion state to one report clause", () => {
  function gateFor(report) {
    const agent = createAgent({
      read_only: false,
      target_paths: ["/repo/gate.txt"],
      workspace_path: "/repo",
    });
    const execution = createExecution(agent, "Inspect and update /repo/gate.txt", "");
    execution.checkpoints.push({
      step: 1,
      result: report,
      diagnostics: { tool_names: [] },
      evidence: { version: 1, authoritative_metadata: [], mutation_receipts: [] },
    });
    return actionGateForAgent(agent, execution);
  }

  assert.equal(gateFor(
    "The exact mismatch is in /repo/gate.txt. Next required action is edit_file."
  ).kind, "pending_mutation");
  assert.equal(gateFor(
    "The exact edit for state=before completed; remaining action is read_file verification."
  ), null);
  assert.equal(gateFor(
    "已完成第一处精确修改；第二处 state=old 的精确修改仍需执行。"
  ).kind, "pending_mutation");
  assert.equal(gateFor(
    "已完成精确修改，仍需 read_file 验证 state=after。"
  ), null);
});


test("structured edit receipts classify nested and sibling host result envelopes", () => {
  const nested = (result) => buildStepEvidence(
    `<tool_ab name="edit_file"><tool_result_ab>${result}</tool_result_ab></tool_ab>`,
    ["edit_file"]
  ).mutation_receipts[0].status;
  const sibling = (result) => buildStepEvidence(
    `<tool_ab name="edit_file"></tool_ab><tool_result_ab>${result}</tool_result_ab>`,
    ["edit_file"]
  ).mutation_receipts[0].status;
  assert.equal(nested('{"success":true}'), "succeeded");
  assert.equal(sibling("[android] Successfully applied AI code to file: /repo/output.md"), "succeeded");
  assert.equal(sibling("Error: Could not apply patch. Reason: Found multiple perfect matches for an OLD block"), "failed");
  assert.equal(sibling("host returned an unclassified response"), "unknown");
  assert.equal(buildStepEvidence('<tool_ab name="edit_file"></tool_ab>', ["edit_file"]).mutation_receipts[0].status, "unknown");
});

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

test("ignores control examples inside tool blocks while accepting a final outer envelope", () => {
  const embedded = [
    "<tool_ab name=\"create_file\"><tool_result_ab>",
    "template body",
    'COLLABORATION_CONTROL: {"version":1,"execution_epoch":"<current>","action":"progress|finish|fail","message_acks":[],"error":""}',
    "</tool_result_ab></tool_ab>",
  ].join("\n");
  const withoutOuter = parseControlEnvelope(embedded);
  assert.equal(withoutOuter.present, false);
  assert.equal(withoutOuter.valid, false);
  assert.equal(stripControlEnvelopes(embedded), embedded);

  const outer = {
    version: 1,
    execution_epoch: "agent_1:1:1",
    action: "progress",
    message_acks: [],
    error: "",
  };
  const withOuter = `${embedded}\nCOLLABORATION_CONTROL: ${JSON.stringify(outer)}`;
  const parsed = parseControlEnvelope(withOuter);
  assert.equal(parsed.present, true);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.control.action, "progress");
  assert.equal(parsed.stripped, embedded);
  assert.equal(stripControlEnvelopes(withOuter), embedded);
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

test("recovery persistence failure does not leave retried runs stuck as unscheduled queued work", () => {
  const recovering = createAgent({ name: "recovering", read_only: true });
  recovering.id = "recovery_failure_agent";
  const recoveringRun = createExecution(recovering, "recover safely", "");
  recoveringRun.id = "recovery_failure_run";
  recoveringRun.agentId = recovering.id;
  recoveringRun.epoch = `${recovering.id}:1:1`;
  recoveringRun.rootAgentId = recovering.id;
  recoveringRun.rootRunId = recoveringRun.id;
  recovering.currentExecutionId = recoveringRun.id;
  recoveringRun.status = "running";
  recoveringRun.physicalStatus = "running";
  recovering.status = "running";

  const queued = createAgent({ name: "already queued", read_only: true });
  queued.id = "existing_queue_agent";
  const queuedRun = createExecution(queued, "remain scheduled", "");
  queuedRun.id = "existing_queue_run";
  queuedRun.agentId = queued.id;
  queuedRun.epoch = `${queued.id}:1:1`;
  queuedRun.rootAgentId = queued.id;
  queuedRun.rootRunId = queuedRun.id;
  queued.currentExecutionId = queuedRun.id;

  const store = {
    mode: "sqlite",
    persistenceModel: "event_store",
    schemaVersion: 3,
    revision: 1,
    migration: "",
    reason: "",
    load() { return { schemaVersion: 3, agents: [recovering, queued] }; },
    getMeta() { return ""; },
    listEffects() { return []; },
    saveRecovery() { throw new Error("injected recovery persistence failure"); },
    saveAgents() {},
    close() {},
  };

  const manager = createCollaborationManager({ store });
  const listed = manager.list({ agent_ids: [recovering.id, queued.id], include_results: true });
  const blocked = listed.agents.find((agent) => agent.id === recovering.id);
  assert.equal(blocked.status, "orphaned");
  assert.equal(blocked.execution.recovery_reason, "recovery_state_persistence_failed");
  assert.match(blocked.error, /automatic retry is blocked.*injected recovery persistence failure/i);
  assert.deepEqual(manager.__test.queue.map((entry) => entry.executionId), [queuedRun.id]);
  manager.shutdown();
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

test("manager rejects unsupported workspace environments", () => {
  const manager = createCollaborationManager();
  assert.throws(
    () => manager.spawn({ task: "invalid environment", workspace_env: "windows", read_only: true }),
    /workspace_env must be android or linux/
  );
  const started = manager.spawn({ task: "valid environment", workspace_env: "Android", read_only: true });
  assert.equal(started.agent.workspace_env, "android");
  manager.__test.agents.get(started.agent.id).status = "completed";
  const stored = manager.__test.agents.get(started.agent.id);
  const originalPaths = [...stored.targetPaths];
  assert.throws(
    () => manager.followup({
      agent_id: started.agent.id,
      task: "invalid follow-up",
      workspace_env: "windows",
      target_paths: ["/tmp/should-not-stick"],
      read_only: false,
    }),
    /workspace_env must be android or linux/
  );
  assert.deepEqual(stored.targetPaths, originalPaths);
  assert.equal(stored.workspaceEnv, "android");
  assert.equal(stored.readOnly, true);
  manager.shutdown();
});

test("manager rejects out-of-range timeouts without mutating follow-up state", () => {
  const manager = createCollaborationManager();
  for (const timeout_ms of [29999, 3600001, 30000.5]) {
    assert.throws(
      () => manager.spawn({ task: "invalid timeout", timeout_ms, read_only: true }),
      /timeout_ms must be an integer between 30000 and 3600000/
    );
  }
  const started = manager.spawn({ task: "valid timeout", timeout_ms: 45000, read_only: true });
  const stored = manager.__test.agents.get(started.agent.id);
  stored.status = "completed";
  assert.throws(
    () => manager.followup({ agent_id: started.agent.id, task: "invalid timeout follow-up", timeout_ms: 29999 }),
    /timeout_ms must be an integer between 30000 and 3600000/
  );
  assert.equal(stored.timeoutMs, 45000);
  assert.equal(stored.runSeq, 1);
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

test("manager counts historical direct child runs against the parent limit", () => {
  const manager = createCollaborationManager();
  const root = createAgent({ name: "root", read_only: true });
  root.id = "direct_child_root";
  const rootExecution = createExecution(root, "parent task", "");
  rootExecution.id = "direct_child_root_run";
  rootExecution.agentId = root.id;
  rootExecution.rootAgentId = root.id;
  rootExecution.rootRunId = rootExecution.id;
  root.currentExecutionId = rootExecution.id;
  manager.__test.agents.set(root.id, root);
  manager.__test.executions.set(rootExecution.id, rootExecution);

  for (let index = 0; index < 12; index += 1) {
    const child = createAgent({
      name: `child-${index}`,
      parent_agent_id: root.id,
      read_only: true,
    });
    child.id = `direct_child_${index}`;
    const childRun = createExecution(child, `child task ${index}`, "", {
      parentRunId: rootExecution.id,
      parentExecutionEpoch: rootExecution.epoch,
      rootAgentId: root.id,
      rootRunId: rootExecution.id,
      treeDepth: 1,
    });
    childRun.id = `direct_child_run_${index}`;
    childRun.agentId = child.id;
    childRun.status = "completed";
    childRun.physicalStatus = "terminal";
    const followupRun = createExecution(child, `follow-up task ${index}`, "");
    followupRun.id = `direct_child_followup_${index}`;
    followupRun.agentId = child.id;
    followupRun.status = "completed";
    followupRun.physicalStatus = "terminal";
    child.currentExecutionId = followupRun.id;
    child.status = "completed";
    manager.__test.agents.set(child.id, child);
    manager.__test.executions.set(childRun.id, childRun);
    manager.__test.executions.set(followupRun.id, followupRun);
  }

  assert.throws(
    () => manager.spawn({ task: "thirteenth child", parent_agent_id: root.id, read_only: true }),
    /parent run direct child limit exceeded \(12\)/
  );
  manager.shutdown();
});


test("manager deletes only terminal leaf history and preserves active work ancestry", async () => {
  const manager = createCollaborationManager();

  function attachAgent(id, status, relation = {}) {
    const agent = createAgent({ name: id, parent_agent_id: relation.parentAgentId || "", read_only: true });
    agent.id = id;
    const execution = createExecution(agent, `${id} task`, "", relation);
    execution.id = `${id}_run`;
    execution.agentId = id;
    execution.rootAgentId = relation.rootAgentId || id;
    execution.rootRunId = relation.rootRunId || execution.id;
    execution.status = status;
    execution.physicalStatus = isTerminalStatusForTest(status) ? "terminal" : status;
    agent.currentExecutionId = execution.id;
    agent.status = status;
    manager.__test.agents.set(id, agent);
    manager.__test.executions.set(execution.id, execution);
    return { agent, execution };
  }

  function isTerminalStatusForTest(status) {
    return ["completed", "failed", "interrupted", "interrupted_with_late_result", "timed_out", "orphaned"].includes(status);
  }

  const oldLeaf = attachAgent("old_leaf", "running");
  const mixedLeaf = attachAgent("mixed_leaf", "running");
  const mixedRunning = attachAgent("mixed_running", "running");
  const parent = attachAgent("active_parent", "completed");
  attachAgent("active_child", "running", {
    parentAgentId: parent.agent.id,
    parentRunId: parent.execution.id,
    parentExecutionEpoch: parent.execution.epoch,
    rootAgentId: parent.agent.id,
    rootRunId: parent.execution.id,
    treeDepth: 1,
  });
  const historyParent = attachAgent("history_parent", "completed");
  attachAgent("history_child", "completed", {
    parentAgentId: historyParent.agent.id,
    parentRunId: historyParent.execution.id,
    parentExecutionEpoch: historyParent.execution.epoch,
    rootAgentId: historyParent.agent.id,
    rootRunId: historyParent.execution.id,
    treeDepth: 1,
  });

  assert.throws(() => manager.deleteAgent({ agent_id: "active_child" }), /only terminal agents/);
  assert.throws(() => manager.deleteAgent({ agent_id: "active_parent" }), /belongs to active work/);
  assert.throws(() => manager.deleteAgent({ agent_id: "history_parent" }), /child history/);

  const completedWait = manager.wait({ agent_ids: [oldLeaf.agent.id], timeout_ms: 1000 });
  oldLeaf.agent.status = "completed";
  oldLeaf.execution.status = "completed";
  oldLeaf.execution.physicalStatus = "terminal";
  assert.equal(manager.deleteAgent({ agent_id: oldLeaf.agent.id }).deleted, 1);
  const completedResult = await completedWait;
  assert.equal(completedResult.timed_out, undefined);
  assert.deepEqual(completedResult.agents.map((agent) => agent.id), [oldLeaf.agent.id]);
  assert.equal(manager.__test.agents.has("old_leaf"), false);

  const mixedWait = manager.wait({
    agent_ids: [mixedLeaf.agent.id, mixedRunning.agent.id],
    timeout_ms: 1000,
  });
  mixedLeaf.agent.status = "completed";
  mixedLeaf.execution.status = "completed";
  mixedLeaf.execution.physicalStatus = "terminal";
  assert.equal(manager.deleteAgent({ agent_id: mixedLeaf.agent.id }).deleted, 1);
  const mixedResult = await mixedWait;
  assert.equal(mixedResult.timed_out, true);
  assert.deepEqual(
    mixedResult.agents.map((agent) => agent.id),
    [mixedLeaf.agent.id, mixedRunning.agent.id]
  );

  mixedRunning.agent.status = "completed";
  mixedRunning.execution.status = "completed";
  mixedRunning.execution.physicalStatus = "terminal";
  assert.equal(manager.deleteAgent({ agent_id: mixedRunning.agent.id }).deleted, 1);

  const cleared = manager.clearHistory();
  assert.deepEqual(new Set(cleared.deleted_agent_ids), new Set(["history_parent", "history_child"]));
  assert.equal(manager.__test.agents.has("active_parent"), true);
  assert.equal(manager.__test.agents.has("active_child"), true);
  manager.shutdown();
});


test("global scheduler settings control concurrency, tool budgets and conversation context", () => {
  const manager = createCollaborationManager({
    getConversationContext(chatId) {
      assert.equal(chatId, "chat_context_test");
      return [
        { kind: "SYSTEM", content: "private system prompt" },
        { kind: "USER", content: "user requirement" },
        { kind: "TOOL_RESULT", content: "private tool trace" },
        { kind: "ASSISTANT", content: "assistant plan" },
      ];
    },
  });
  const initial = manager.getSettings().settings;
  assert.deepEqual(initial.max_concurrent_agents_range, [1, 16]);
  assert.deepEqual(initial.max_active_runs_per_root_range, [1, 8]);
  assert.deepEqual(initial.max_tool_calls_range, [1, 64]);
  assert.deepEqual(initial.max_model_retries_range, [0, 12]);
  assert.equal(initial.max_active_runs_per_root, 3);
  assert.equal(initial.max_concurrent_agents, 6);
  assert.equal(initial.max_tool_calls, 16);
  assert.equal(initial.max_model_retries, 5);
  assert.equal(initial.conversation_context_mode, "auto");
  const maximum = manager.updateSettings({
    max_concurrent_agents: 16,
    max_active_runs_per_root: 8,
    max_tool_calls: 64,
    max_model_retries: 12,
    conversation_context_mode: "auto",
  });
  assert.equal(maximum.settings.max_concurrent_agents, 16);
  assert.equal(maximum.settings.max_active_runs_per_root, 8);
  assert.equal(maximum.settings.max_tool_calls, 64);
  assert.equal(maximum.settings.max_model_retries, 12);
  const updated = manager.updateSettings({
    max_concurrent_agents: 2,
    max_active_runs_per_root: 1,
    max_tool_calls: 9,
    max_model_retries: 0,
    conversation_context_mode: "auto",
  });
  assert.equal(updated.settings.max_concurrent_agents, 2);
  assert.equal(updated.settings.max_active_runs_per_root, 1);
  assert.equal(updated.settings.max_tool_calls, 9);
  assert.equal(updated.settings.max_model_retries, 0);
  assert.equal(updated.settings.conversation_context_mode, "auto");
  const omitted = manager.spawn({
    task: "auto excludes context when AI declines",
    read_only: true,
    parent_chat_id: "chat_context_test",
  });
  assert.equal(manager.__test.latestExecution(manager.__test.agents.get(omitted.agent.id)).conversationContext.length, 0);
  const included = manager.spawn({
    task: "auto includes context when AI selects it",
    read_only: true,
    parent_chat_id: "chat_context_test",
    include_conversation_context: true,
    max_tool_calls: 40,
  });
  const includedExecution = manager.__test.latestExecution(manager.__test.agents.get(included.agent.id));
  assert.equal(included.agent.max_tool_calls, 9);
  assert.deepEqual(includedExecution.conversationContext, [
    { kind: "USER", content: "user requirement" },
    { kind: "ASSISTANT", content: "assistant plan" },
  ]);
  manager.updateSettings({ max_concurrent_agents: 2, max_active_runs_per_root: 1, max_tool_calls: 9, conversation_context_mode: "off" });
  const forcedOff = manager.spawn({
    task: "off overrides AI",
    read_only: true,
    parent_chat_id: "chat_context_test",
    include_conversation_context: true,
  });
  assert.equal(manager.__test.latestExecution(manager.__test.agents.get(forcedOff.agent.id)).conversationContext.length, 0);
  manager.updateSettings({ max_concurrent_agents: 2, max_active_runs_per_root: 1, max_tool_calls: 9, conversation_context_mode: "on" });
  const forcedOn = manager.spawn({ task: "on overrides AI", read_only: true, parent_chat_id: "chat_context_test" });
  assert.equal(manager.__test.latestExecution(manager.__test.agents.get(forcedOn.agent.id)).conversationContext.length, 2);
  assert.equal(manager.list({}).limits.global_active_runs, 2);
  assert.equal(manager.list({}).limits.active_runs_per_root, 1);
  assert.equal(manager.list({}).limits.max_tool_calls, 9);
  assert.equal(manager.list({}).limits.max_model_retries, 0);
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 0, max_tool_calls: 9, conversation_context_mode: "auto" }),
    /max_concurrent_agents/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 17, max_active_runs_per_root: 3, max_tool_calls: 16, conversation_context_mode: "auto" }),
    /max_concurrent_agents/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 16, max_active_runs_per_root: 9, max_tool_calls: 16, conversation_context_mode: "auto" }),
    /max_active_runs_per_root/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 16, max_active_runs_per_root: 8, max_tool_calls: 65, conversation_context_mode: "auto" }),
    /max_tool_calls/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 16, max_active_runs_per_root: 8, max_tool_calls: 64, max_model_retries: 13, conversation_context_mode: "auto" }),
    /max_model_retries/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 2, max_active_runs_per_root: 3, max_tool_calls: 9, conversation_context_mode: "auto" }),
    /max_active_runs_per_root/
  );
  assert.throws(
    () => manager.updateSettings({ max_concurrent_agents: 2, max_active_runs_per_root: 1, max_tool_calls: 9, conversation_context_mode: "sometimes" }),
    /conversation_context_mode/
  );
  manager.shutdown();
});

test("legacy settings keep the default per-root limit and explicit values are restored", () => {
  const createStore = (settingsValue) => ({
    mode: "memory",
    persistenceModel: "event_store",
    schemaVersion: 3,
    revision: 0,
    migration: "",
    reason: "",
    load() { return { agents: [] }; },
    getMeta() { return settingsValue; },
    setMeta() {},
    listEffects() { return []; },
    saveAgents() {},
    saveRecovery() {},
    close() {},
  });
  const legacy = createCollaborationManager({ store: createStore(JSON.stringify({
    max_concurrent_agents: 2,
    max_tool_calls: 8,
    conversation_context_mode: "auto",
  })) });
  assert.equal(legacy.getSettings().settings.max_active_runs_per_root, 2);
  legacy.shutdown();

  const configured = createCollaborationManager({ store: createStore(JSON.stringify({
    max_concurrent_agents: 6,
    max_active_runs_per_root: 4,
    max_tool_calls: 8,
    conversation_context_mode: "auto",
  })) });
  assert.equal(configured.getSettings().settings.max_active_runs_per_root, 4);
  configured.shutdown();
});


test("manager exposes dashboard summaries, detail and precise task trees", () => {
  const manager = createCollaborationManager();
  const rootAgent = createAgent({
    name: "root",
    read_only: true,
    priority: "high",
    timeout_ms: 45000,
    max_tool_calls: 5,
  });
  rootAgent.id = "dashboard_root";
  const rootTask = `Inspect the dashboard project and preserve every task-tree character: ${"detail ".repeat(48)}`;
  const rootExecution = createExecution(rootAgent, rootTask, "private context");
  rootExecution.id = "dashboard_root_run";
  rootExecution.agentId = rootAgent.id;
  rootExecution.rootAgentId = rootAgent.id;
  rootExecution.rootRunId = rootExecution.id;
  rootExecution.status = "completed";
  rootExecution.physicalStatus = "terminal";
  rootAgent.currentExecutionId = rootExecution.id;
  rootAgent.status = "completed";
  manager.__test.agents.set(rootAgent.id, rootAgent);
  manager.__test.executions.set(rootExecution.id, rootExecution);

  const childAgent = createAgent({ name: "child", parent_agent_id: rootAgent.id, read_only: true });
  childAgent.id = "dashboard_child";
  const childExecution = createExecution(childAgent, "Inspect child module", "", {
    parentRunId: rootExecution.id,
    parentExecutionEpoch: rootExecution.epoch,
    rootAgentId: rootAgent.id,
    rootRunId: rootExecution.id,
    treeDepth: 1,
  });
  childExecution.id = "dashboard_child_run";
  childExecution.agentId = childAgent.id;
  childExecution.rootRunId = rootExecution.id;
  childExecution.status = "queued";
  childAgent.currentExecutionId = childExecution.id;
  manager.__test.agents.set(childAgent.id, childAgent);
  manager.__test.executions.set(childExecution.id, childExecution);

  const listed = manager.list({ agent_ids: [rootAgent.id] });
  assert.equal(listed.limits.global_active_runs, 6);
  assert.equal(listed.limits.active_runs_per_root, 3);
  assert.equal(listed.limits.max_tool_calls, 16);
  assert.equal(listed.status_counts.completed, 1);
  assert.equal(listed.agents[0].priority, "high");
  assert.equal(listed.agents[0].timeout_ms, 45000);
  assert.equal(listed.agents[0].max_tool_calls, 5);
  assert.match(listed.agents[0].execution.task_excerpt, /dashboard project/);
  assert.equal(JSON.stringify(listed).includes("private context"), false);

  const inspected = manager.inspect({ agent_id: rootAgent.id });
  assert.equal(inspected.agent.id, rootAgent.id);
  const tree = manager.listTree({ agent_id: childAgent.id });
  assert.equal(tree.root_run_id, rootExecution.id);
  assert.deepEqual(tree.nodes.map((node) => node.agent_id), [rootAgent.id, childAgent.id]);
  assert.equal(tree.nodes[0].task, rootTask);
  assert.equal(tree.nodes[0].task_excerpt, rootTask.slice(0, 240));
  assert.ok(tree.nodes[0].task.length > tree.nodes[0].task_excerpt.length);
  assert.equal(tree.nodes[1].tree_depth, 1);
  assert.throws(() => manager.listTree({ root_run_id: "missing" }), /not found/);
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
  assert.throws(() => manager.list({ limit: 0.5 }), /integer between 1 and 100/);
  assert.throws(() => manager.list({ limit: 101 }), /integer between 1 and 100/);
  for (const invalidCursor of [
    "-1:agent",
    "1.5:agent",
    "1e3:agent",
    "0x10:agent",
    "01:agent",
    "9007199254740992:agent",
    "123:",
  ]) {
    assert.throws(() => manager.list({ cursor: invalidCursor }), /cursor is invalid/);
  }
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

  const colonAgent = createAgent({ name: "colon cursor", read_only: true });
  colonAgent.id = "history:agent:colon";
  colonAgent.createdAt = 2000;
  colonAgent.updatedAt = colonAgent.createdAt;
  const colonExecution = createExecution(colonAgent, "colon cursor task", "");
  colonExecution.id = "history_execution_colon";
  colonExecution.agentId = colonAgent.id;
  colonExecution.epoch = `${colonAgent.id}:1:1`;
  colonExecution.rootAgentId = colonAgent.id;
  colonExecution.rootRunId = colonExecution.id;
  colonExecution.status = "completed";
  colonExecution.physicalStatus = "terminal";
  colonExecution.completedAt = colonAgent.createdAt;
  colonAgent.currentExecutionId = colonExecution.id;
  colonAgent.status = "completed";
  manager.__test.agents.set(colonAgent.id, colonAgent);
  manager.__test.executions.set(colonExecution.id, colonExecution);
  const colonPage = manager.list({ limit: 1, cursor: "1999:prior:agent" });
  assert.equal(colonPage.agents[0].id, colonAgent.id);

  const selected = manager.list({
    agent_ids: expectedIds.slice(0, 125),
    limit: 1,
    cursor: "invalid cursor is ignored for exact ids",
  });
  assert.equal(selected.agents.length, 125);
  assert.equal(selected.has_more, false);
  manager.shutdown();
});