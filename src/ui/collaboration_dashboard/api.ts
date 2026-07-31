import { CHANNELS } from "../../protocol.js";

type JsonRecord = Record<string, unknown>;
export type DashboardIpcError = Error & {
  code: string;
  details?: unknown;
};

type IpcResult = JsonRecord & {
  success?: boolean;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  details?: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object";
}

function runtime(): ToolPkg.Registry {
  if (typeof ToolPkg === "undefined" || !ToolPkg || !ToolPkg.ipc ||
      typeof ToolPkg.ipc.call !== "function") {
    throw new Error("ToolPkg IPC is unavailable");
  }
  return ToolPkg;
}

export function createIpcError(code: unknown, message: unknown, details?: unknown): DashboardIpcError {
  const error = new Error(String(message || "")) as DashboardIpcError;
  error.name = "DashboardIpcError";
  error.code = String(code || "operation_failed");
  if (details !== undefined) error.details = details;
  return error;
}

function failedResponseError(result: IpcResult): DashboardIpcError {
  const errorObject = isRecord(result.error) ? result.error : null;
  const code = String(result.code || errorObject && errorObject.code || "operation_failed");
  const message = typeof result.error === "string"
    ? result.error
    : String(errorObject && errorObject.message || result.message || "");
  const details = result.details !== undefined
    ? result.details
    : (errorObject && errorObject.details !== undefined ? errorObject.details : undefined);
  return createIpcError(code, message, details);
}

export async function callMain(channel: string, payload?: unknown): Promise<IpcResult> {
  const result = await runtime().ipc.call<unknown, unknown>(channel, payload || {});
  if (!isRecord(result)) {
    throw createIpcError("ipc_invalid_response", "", { channel, response: result ?? null });
  }
  const response = result as IpcResult;
  if (response.success === false) throw failedResponseError(response);
  return response;
}

export const listAgents = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.LIST_AGENTS, payload);
export const inspectAgent = (agentId: unknown): Promise<IpcResult> => callMain(CHANNELS.INSPECT_AGENT, { agent_id: agentId });
export const listTree = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.LIST_TREE, payload);
export const watchTreeEvents = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.WATCH_TREE_EVENTS, payload);
export const spawnAgent = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.SPAWN_AGENT, payload);
export const sendMessage = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.SEND_MESSAGE, payload);
export const followupTask = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.FOLLOWUP_TASK, payload);
export const waitAgent = (agentId: unknown, timeoutMs: number = 5000): Promise<IpcResult> => callMain(CHANNELS.WAIT_AGENT, {
  agent_ids: [agentId],
  timeout_ms: timeoutMs,
});
export const interruptAgent = (payload?: unknown): Promise<IpcResult> => callMain(CHANNELS.INTERRUPT_AGENT, payload);
export const deleteAgent = (agentId: unknown): Promise<IpcResult> => callMain(CHANNELS.DELETE_AGENT, { agent_id: agentId });
export const clearHistory = (): Promise<IpcResult> => callMain(CHANNELS.CLEAR_HISTORY, {});