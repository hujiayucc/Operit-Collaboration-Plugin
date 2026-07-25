"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const calls = [];
global.ToolPkg = {
  ipc: {
    async call(channel, payload, options) {
      calls.push({ channel, payload, options });
      return { ok: true, channel, payload };
    },
  },
};

const collaboration = require("../src/packages/collaboration.js");

function parsed(value) {
  return JSON.parse(value);
}

test("spawn_agent parses target paths and forwards the parent chat id", async () => {
  const result = parsed(await collaboration.spawn_agent({
    task: "implement feature",
    request_id: "spawn-request-1",
    target_paths_json: '["/repo/src"]',
    workspace_path: "/repo",
    __operit_package_chat_id: "chat_1",
  }));
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).channel, "collaboration.spawn_agent");
  assert.deepEqual(calls.at(-1).payload.target_paths, ["/repo/src"]);
  assert.equal(calls.at(-1).payload.request_id, "spawn-request-1");
  assert.equal(calls.at(-1).payload.parent_chat_id, "chat_1");
  assert.deepEqual(calls.at(-1).options, { targetRuntime: "main" });
});

test("wait_agent rejects malformed JSON without making an IPC call", async () => {
  const before = calls.length;
  const result = parsed(await collaboration.wait_agent({ agent_ids_json: "not-json" }));
  assert.equal(result.success, false);
  assert.match(result.error, /valid JSON/);
  assert.equal(calls.length, before);
});

test("followup_task leaves omitted target paths undefined for inheritance", async () => {
  await collaboration.followup_task({ agent_id: "agent_1", task: "continue" });
  const payload = calls.at(-1).payload;
  assert.equal(calls.at(-1).channel, "collaboration.followup_task");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "target_paths"), false);
});

test("forwards pagination and request ids for all write tools", async () => {
  await collaboration.list_agents({ limit: 25, cursor: "123:agent_1" });
  assert.equal(calls.at(-1).payload.limit, 25);
  assert.equal(calls.at(-1).payload.cursor, "123:agent_1");

  await collaboration.send_message({
    agent_id: "agent_1",
    message: "once",
    request_id: "send-1",
  });
  assert.equal(calls.at(-1).payload.request_id, "send-1");

  await collaboration.followup_task({
    agent_id: "agent_1",
    task: "continue once",
    request_id: "followup-1",
  });
  assert.equal(calls.at(-1).payload.request_id, "followup-1");

  await collaboration.interrupt_agent({ agent_id: "agent_1", request_id: "interrupt-1" });
  assert.equal(calls.at(-1).payload.request_id, "interrupt-1");
});