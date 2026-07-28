"use strict";

const { CHANNELS, IPC_OPTIONS } = require("../../protocol.js");

function runtime() {
  if (typeof ToolPkg === "undefined" || !ToolPkg || !ToolPkg.ipc ||
      typeof ToolPkg.ipc.call !== "function") {
    throw new Error("ToolPkg IPC is unavailable");
  }
  return ToolPkg;
}

function createIpcError(code, message, details) {
  const error = new Error(String(message || ""));
  error.name = "DashboardIpcError";
  error.code = String(code || "operation_failed");
  if (details !== undefined) error.details = details;
  return error;
}

function failedResponseError(result) {
  const errorObject = result && result.error && typeof result.error === "object" ? result.error : null;
  const code = String(result && result.code || errorObject && errorObject.code || "operation_failed");
  const message = typeof result.error === "string"
    ? result.error
    : String(errorObject && errorObject.message || result.message || "");
  const details = result.details !== undefined
    ? result.details
    : (errorObject && errorObject.details !== undefined ? errorObject.details : undefined);
  return createIpcError(code, message, details);
}

async function callMain(channel, payload) {
  const result = await runtime().ipc.call(channel, payload || {}, IPC_OPTIONS);
  if (!result || typeof result !== "object") {
    throw createIpcError("ipc_invalid_response", "", { channel, response: result ?? null });
  }
  if (result.success === false) throw failedResponseError(result);
  return result;
}

const listAgents = (payload) => callMain(CHANNELS.LIST_AGENTS, payload);
const inspectAgent = (agentId) => callMain(CHANNELS.INSPECT_AGENT, { agent_id: agentId });
const listTree = (payload) => callMain(CHANNELS.LIST_TREE, payload);
const spawnAgent = (payload) => callMain(CHANNELS.SPAWN_AGENT, payload);
const sendMessage = (payload) => callMain(CHANNELS.SEND_MESSAGE, payload);
const followupTask = (payload) => callMain(CHANNELS.FOLLOWUP_TASK, payload);
const waitAgent = (agentId, timeoutMs = 5000) => callMain(CHANNELS.WAIT_AGENT, {
  agent_ids: [agentId],
  timeout_ms: timeoutMs,
});
const interruptAgent = (payload) => callMain(CHANNELS.INTERRUPT_AGENT, payload);
const deleteAgent = (agentId) => callMain(CHANNELS.DELETE_AGENT, { agent_id: agentId });
const clearHistory = () => callMain(CHANNELS.CLEAR_HISTORY, {});

module.exports = {
  callMain,
  clearHistory,
  createIpcError,
  deleteAgent,
  followupTask,
  inspectAgent,
  interruptAgent,
  listAgents,
  listTree,
  sendMessage,
  spawnAgent,
  waitAgent,
};