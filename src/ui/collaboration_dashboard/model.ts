export type AgentRecord = {
  id: string;
  [key: string]: unknown;
};

export type DashboardActions = {
  message: boolean;
  wait: boolean;
  followup: boolean;
  interrupt: boolean;
};

type SummaryInput = {
  active?: unknown;
  queued?: unknown;
  total?: unknown;
  status_counts?: unknown;
};

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "summarizing"]);

export function isTerminal(status: unknown): boolean {
  return TERMINAL_STATUSES.has(String(status || ""));
}

export function allowedActions(status: unknown): DashboardActions {
  const value = String(status || "");
  return {
    message: ACTIVE_STATUSES.has(value),
    wait: ACTIVE_STATUSES.has(value) || value === "cancelling",
    followup: isTerminal(value),
    interrupt: ACTIVE_STATUSES.has(value),
  };
}

export function mergeAgents<T extends AgentRecord>(current: T[] | unknown, incoming: T[] | unknown): T[] {
  const map = new Map<string, T>();
  for (const agent of Array.isArray(current) ? current as T[] : []) map.set(agent.id, agent);
  for (const agent of Array.isArray(incoming) ? incoming as T[] : []) map.set(agent.id, agent);
  return Array.from(map.values());
}

export function shortId(value: unknown, size: number = 12): string {
  const text = String(value || "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

export function statusColor(status: unknown): string {
  if (status === "failed" || status === "orphaned") return "errorContainer";
  if (status === "running") return "primaryContainer";
  if (status === "queued" || status === "cancelling") return "secondaryContainer";
  if (status === "timed_out" || status === "interrupted" || status === "interrupted_with_late_result") {
    return "tertiaryContainer";
  }
  return "surfaceVariant";
}

export function countSummary(result: SummaryInput | null | undefined): {
  active: number;
  queued: number;
  total: number;
  counts: Record<string, unknown>;
} {
  const counts = result && result.status_counts && typeof result.status_counts === "object"
    ? result.status_counts as Record<string, unknown>
    : {};
  return {
    active: Number(result && result.active) || 0,
    queued: Number(result && result.queued) || 0,
    total: Number(result && result.total) || 0,
    counts,
  };
}