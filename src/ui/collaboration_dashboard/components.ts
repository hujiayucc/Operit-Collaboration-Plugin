import { shortId, statusColor } from "./model.js";

type UiNode = unknown;
type UiFactory = (...args: unknown[]) => UiNode;
type UiContext = {
  UI: Record<string, UiFactory>;
};
type ValueState = {
  value: unknown;
  set: (value: unknown) => void;
};
type AgentView = {
  id: string;
  name?: unknown;
  status?: unknown;
  priority?: unknown;
  run_seq?: unknown;
  read_only?: unknown;
  pending_messages?: unknown;
  execution?: Record<string, unknown>;
};
type DashboardLabels = Record<string, unknown>;

type PanelOptions = {
  containerColor?: string;
  padding?: unknown;
  spacing?: number;
};

const SHAPE_SMALL = Object.freeze({ type: "rounded", cornerRadius: 6 });
const SHAPE_MEDIUM = Object.freeze({ type: "rounded", cornerRadius: 8 });
const SHAPE_LARGE = Object.freeze({ type: "rounded", cornerRadius: 8 });
const SHAPE_PILL = Object.freeze({ type: "pill" });
const CARD_BORDER = Object.freeze({ width: 1, color: "outlineVariant" });

function compact(nodes: UiNode[]): UiNode[] {
  return nodes.filter(Boolean);
}

export function sectionTitle(ctx: UiContext, text: unknown): UiNode {
  return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
    ctx.UI.Surface({ width: 4, height: 18, containerColor: "primary", shape: SHAPE_PILL }, []),
    ctx.UI.Text({ text, style: "titleMedium", fontWeight: "semiBold", weight: 1 }),
  ]);
}

export function errorCard(ctx: UiContext, message: unknown): UiNode {
  if (!String(message || "").trim()) return null;
  return ctx.UI.Card({
    fillMaxWidth: true,
    containerColor: "errorContainer",
    shape: SHAPE_MEDIUM,
    border: { width: 1, color: "error" },
  }, [
    ctx.UI.Row({ padding: 14, verticalAlignment: "center" }, [
      ctx.UI.Icon({ name: "error", tint: "onErrorContainer", size: 20 }),
      ctx.UI.Spacer({ width: 10 }),
      ctx.UI.Text({ text: String(message), color: "onErrorContainer", weight: 1, style: "bodyMedium" }),
    ]),
  ]);
}

export function noticeCard(ctx: UiContext, message: unknown, color: string = "secondaryContainer"): UiNode {
  if (!String(message || "").trim()) return null;
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: color, shape: SHAPE_MEDIUM }, [
    ctx.UI.Text({ text: String(message), padding: 14, style: "bodyMedium", softWrap: true }),
  ]);
}

export function loadingRow(ctx: UiContext, text: unknown): UiNode {
  return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_MEDIUM }, [
    ctx.UI.Row({
      padding: { horizontal: 14, vertical: 12 },
      verticalAlignment: "center",
      horizontalArrangement: "center",
      fillMaxWidth: true,
    }, [
      ctx.UI.CircularProgressIndicator({ width: 18, height: 18, strokeWidth: 2 }),
      ctx.UI.Spacer({ width: 10 }),
      ctx.UI.Text({ text, style: "bodyMedium", color: "onSurfaceVariant" }),
    ]),
  ]);
}

export function statCard(ctx: UiContext, label: unknown, value: unknown, color: string = "surfaceVariant"): UiNode {
  return ctx.UI.Card({
    weight: 1,
    containerColor: color,
    shape: SHAPE_MEDIUM,
    border: CARD_BORDER,
  }, [
    ctx.UI.Column({ padding: { horizontal: 12, vertical: 10 }, spacing: 1 }, [
      ctx.UI.Text({ text: String(value), style: "titleLarge", fontWeight: "bold" }),
      ctx.UI.Text({ text: label, style: "labelMedium", color: "onSurfaceVariant", maxLines: 1, overflow: "ellipsis" }),
    ]),
  ]);
}

export function keyValue(ctx: UiContext, label: unknown, value: unknown): UiNode {
  if (value === undefined || value === null || String(value) === "") return null;
  return ctx.UI.Row({
    fillMaxWidth: true,
    verticalAlignment: "start",
    padding: { vertical: 4 },
    spacing: 10,
  }, [
    ctx.UI.Text({ text: `${label}:`, width: 112, style: "labelMedium", fontWeight: "semiBold", color: "onSurfaceVariant" }),
    ctx.UI.Text({ text: String(value), weight: 1, style: "bodySmall", softWrap: true }),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localizedOption(options: unknown, value: unknown, fallback: unknown): unknown {
  const record = isRecord(options) ? options : null;
  const key = String(value || "");
  return record && record[key] || fallback || key;
}

export function statusBadge(ctx: UiContext, label: unknown, status: unknown): UiNode {
  return ctx.UI.Surface({ containerColor: statusColor(status), shape: SHAPE_PILL }, [
    ctx.UI.Text({
      text: label,
      style: "labelMedium",
      fontWeight: "semiBold",
      padding: { horizontal: 10, vertical: 5 },
      maxLines: 1,
      overflow: "ellipsis",
    }),
  ]);
}

export function agentCard(
  ctx: UiContext,
  agent: AgentView,
  text: DashboardLabels,
  onOpen: (agentId: string) => void,
): UiNode {
  const execution = agent.execution || {};
  const status = localizedOption(text.statusOptions, agent.status, text.unknown);
  const priority = localizedOption(text.priorityOptions, agent.priority || "normal", agent.priority || "normal");
  const active = ["queued", "running", "summarizing", "cancelling"].includes(String(agent.status || ""));
  return ctx.UI.Card({
    fillMaxWidth: true,
    containerColor: "surface",
    shape: SHAPE_LARGE,
    border: CARD_BORDER,
    elevation: active ? 2 : 0,
  }, [
    ctx.UI.Row({ fillMaxWidth: true }, [
      ctx.UI.Surface({ width: 5, height: active ? 148 : 132, containerColor: statusColor(agent.status), shape: SHAPE_PILL }, []),
      ctx.UI.Column({ padding: 14, spacing: 9, weight: 1 }, compact([
        ctx.UI.Text({
          text: agent.name || shortId(agent.id),
          style: "titleMedium",
          fontWeight: "semiBold",
          maxLines: 1,
          overflow: "ellipsis",
        }),
        ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
          statusBadge(ctx, status, agent.status),
          ctx.UI.Spacer({ weight: 1 }),
          ctx.UI.Text({ text: shortId(agent.id, 10), style: "labelSmall", color: "onSurfaceVariant" }),
        ]),
        ctx.UI.Text({ text: execution.task_excerpt || "-", style: "bodyMedium", maxLines: 2, overflow: "ellipsis" }),
        ctx.UI.Text({
          text: `${text.run} ${agent.run_seq || 0} · ${agent.read_only ? text.readOnly : text.writable} · ${priority}`,
          style: "bodySmall",
          color: "onSurfaceVariant",
        }),
        ctx.UI.Text({
          text: `${text.currentTool}=${execution.current_tool || "-"} · ${text.toolCalls}=${execution.tool_count || 0} · ${text.pendingMessages}=${agent.pending_messages || 0}`,
          style: "bodySmall",
          color: "onSurfaceVariant",
          maxLines: 1,
          overflow: "ellipsis",
        }),
        active ? ctx.UI.LinearProgressIndicator({ fillMaxWidth: true }) : null,
        ctx.UI.Button({
          text: text.details,
          fillMaxWidth: true,
          shape: SHAPE_SMALL,
          contentPadding: { horizontal: 12, vertical: 7 },
          onClick: () => onOpen(agent.id),
        }),
      ])),
    ]),
  ]);
}

export function textField(ctx: UiContext, label: unknown, state: ValueState, options?: Record<string, unknown>): UiNode {
  return ctx.UI.TextField({
    label,
    value: state.value,
    onValueChange: state.set,
    fillMaxWidth: true,
    ...(options || {}),
  });
}

export function panel(ctx: UiContext, children: UiNode[], options: PanelOptions = {}): UiNode {
  return ctx.UI.Surface({
    fillMaxWidth: true,
    containerColor: options.containerColor || "surface",
    shape: SHAPE_LARGE,
  }, [
    ctx.UI.Column({ padding: options.padding || 14, spacing: options.spacing || 10 }, compact(children)),
  ]);
}

export function pageHeader(
  ctx: UiContext,
  title: { back: unknown; label: unknown },
  onBack?: (() => void) | null,
  trailing?: UiNode,
): UiNode {
  return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surface", shape: SHAPE_LARGE }, [
    ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: { horizontal: 8, vertical: 6 }, spacing: 8 }, compact([
      onBack ? ctx.UI.Button({ text: title.back, shape: SHAPE_SMALL, onClick: onBack }) : null,
      ctx.UI.Text({ text: title.label, style: "titleLarge", fontWeight: "bold", weight: 1, maxLines: 1, overflow: "ellipsis" }),
      trailing || null,
    ])),
  ]);
}

export function emptyState(ctx: UiContext, text: unknown): UiNode {
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_LARGE, border: CARD_BORDER }, [
    ctx.UI.Column({ fillMaxWidth: true, padding: { horizontal: 18, vertical: 24 }, spacing: 8 }, [
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center" }, [
        ctx.UI.Icon({ name: "accountTree", tint: "onSurfaceVariant", size: 28 }),
      ]),
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center" }, [
        ctx.UI.Text({ text, style: "bodyMedium", color: "onSurfaceVariant" }),
      ]),
    ]),
  ]);
}

export {};