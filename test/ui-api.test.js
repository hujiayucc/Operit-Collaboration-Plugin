"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const calls = [];
global.ToolPkg = {
  ipc: {
    async call(channel, payload, options) {
      calls.push({ channel, payload, options });
      return { success: true, channel, payload };
    },
  },
};

const api = require("../dist/ui/collaboration_dashboard/api.js");

test("dashboard API targets main runtime and keeps structured arrays", async () => {
  calls.length = 0;
  await api.spawnAgent({ task: "write", target_paths: ["/repo/src"], read_only: false });
  assert.deepEqual(calls[0], {
    channel: "collaboration.spawn_agent",
    payload: { task: "write", target_paths: ["/repo/src"], read_only: false },
    options: undefined,
  });
});

test("dashboard API maps UI-only detail, tree and history management channels", async () => {
  calls.length = 0;
  await api.inspectAgent("agent_1");
  await api.listTree({ agent_id: "agent_1" });
  await api.watchTreeEvents({ root_run_id: "root_1", after_revision: 0 });
  await api.deleteAgent("agent_1");
  await api.clearHistory();
  assert.equal(calls[0].channel, "collaboration.inspect_agent");
  assert.equal(calls[1].channel, "collaboration.list_tree");
  assert.equal(calls[2].channel, "collaboration.watch_tree_events");
  assert.deepEqual(calls[2].payload, { root_run_id: "root_1", after_revision: 0 });
  assert.deepEqual(calls[3].payload, { agent_id: "agent_1" });
  assert.equal(calls[3].channel, "collaboration.delete_agent");
  assert.deepEqual(calls[4].payload, {});
  assert.equal(calls[4].channel, "collaboration.clear_history");
});

test("dashboard API preserves localizable codes and structured failure details", async () => {
  const original = global.ToolPkg.ipc.call;
  try {
    global.ToolPkg.ipc.call = async () => null;
    await assert.rejects(
      () => api.listAgents({}),
      (error) => error.name === "DashboardIpcError" &&
        error.code === "ipc_invalid_response" &&
        error.details.channel === "collaboration.list_agents"
    );

    global.ToolPkg.ipc.call = async () => ({
      success: false,
      error: { code: "policy_denied", message: "denied", details: { policy: "strict" } },
    });
    await assert.rejects(
      () => api.listAgents({}),
      (error) => error.name === "DashboardIpcError" &&
        error.code === "policy_denied" &&
        error.message === "denied" &&
        error.details.policy === "strict"
    );

    global.ToolPkg.ipc.call = async () => ({ success: false, error: "plain denial" });
    await assert.rejects(
      () => api.listAgents({}),
      (error) => error.code === "operation_failed" && error.message === "plain denial"
    );
  } finally {
    global.ToolPkg.ipc.call = original;
  }
});