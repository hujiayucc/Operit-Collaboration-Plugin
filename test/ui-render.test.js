"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const entryPath = path.resolve(__dirname, "../dist/ui/collaboration_dashboard/index.ui.js");
const entryModule = require(entryPath);
const Screen = entryModule.default || entryModule.Screen;

function nodeFactory(type) {
  return (props, children) => ({ type, props: props || {}, children: children || [] });
}

function flattenNodes(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenNodes(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (typeof value.type === "string") output.push(value);
  flattenNodes(value.children, output);
  flattenNodes(value.props && value.props.content, output);
  return output;
}

function createContext(locale = "zh-CN") {
  const state = new Map();
  const UI = new Proxy({}, {
    get(_target, name) {
      return nodeFactory(String(name));
    },
  });
  return {
    UI,
    useState(key, initialValue) {
      if (!state.has(key)) state.set(key, initialValue);
      return [state.get(key), (value) => state.set(key, value)];
    },
    getEnv() { return locale; },
    showToast() {},
    __state: state,
  };
}

test("Compose DSL entry is self-contained and has no runtime relative require", () => {
  const source = fs.readFileSync(entryPath, "utf8");
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.match(source, /function Screen\s*\(/);
  assert.equal(entryModule.default, Screen);
  assert.equal(entryModule.Screen, Screen);
});

test("empty Agent state centers its icon and label", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true, active: 0, queued: 0, total: 0, has_more: false, agents: [] }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.agents", []);
    ctx.__state.set("dashboard.summary", { active: 0, queued: 0, total: 0, counts: {} });
    const nodes = flattenNodes(Screen(ctx));
    const emptyText = nodes.find((node) => node.type === "Text" && node.props.text === "No agents");
    assert.ok(emptyText, "empty state label must render");
    const centeredRows = nodes.filter((node) => node.type === "Row" && node.props.horizontalArrangement === "center");
    assert.ok(centeredRows.length >= 2, "empty state must center icon and label in explicit full-width rows");
    assert.ok(centeredRows.every((node) => node.props.fillMaxWidth === true));
    assert.ok(centeredRows.some((node) => flattenNodes(node.children).some((child) => child.type === "Icon" && child.props.name === "accountTree")));
    assert.ok(centeredRows.some((node) => flattenNodes(node.children).some((child) => child.type === "Text" && child.props.text === "No agents")));
  } finally {
    global.ToolPkg = original;
  }
});


test("dashboard visual hierarchy uses native surfaces, badges and progress without WebView", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.agents", [{
      id: "agent_visual",
      name: "Visual holder",
      status: "running",
      run_seq: 2,
      read_only: true,
      priority: "normal",
      execution: { task_excerpt: "Hold the dashboard open", tool_count: 1 },
    }]);
    ctx.__state.set("dashboard.summary", { active: 1, queued: 0, total: 1, counts: { running: 1 } });

    const nodes = flattenNodes(Screen(ctx));
    const dashboardHeader = nodes.find((node) => node.type === "Surface" && node.props.containerColor === "primaryContainer");
    assert.ok(dashboardHeader, "dashboard must render a distinct native header surface");
    assert.ok(nodes.some((node) => node.type === "LinearProgressIndicator"), "active Agent must render progress feedback");
    assert.ok(nodes.some((node) => node.type === "Surface" && node.props.shape && node.props.shape.type === "pill"),
      "statuses and segmented controls must use compact pill surfaces");
    assert.equal(nodes.some((node) => node.type === "WebView"), false, "dashboard must remain native Compose DSL");
  } finally {
    global.ToolPkg = original;
  }
});


test("destructive confirmation uses an error-emphasis panel", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "confirm");
    ctx.__state.set("dashboard.confirmAction", {
      kind: "deleteAgent",
      payload: { agent_id: "agent_delete" },
      warning: "Permanent deletion",
      returnView: "detail",
    });
    const nodes = flattenNodes(Screen(ctx));
    assert.ok(nodes.some((node) => node.type === "Card" && node.props.containerColor === "errorContainer"));
    assert.ok(nodes.some((node) => node.type === "Icon" && node.props.name === "error"));
  } finally {
    global.ToolPkg = original;
  }
});


test("status filter renders all options as buttons and refreshes on selection", async () => {
  const calls = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options });
        return {
          success: true,
          active: 0,
          queued: 0,
          total: 0,
          has_more: false,
          agents: [],
        };
      },
    },
  };

  const ctx = createContext("en-US");
  let tree = Screen(ctx);
  const optionButtons = flattenNodes(tree).filter(
    (node) => node.type === "Button" && [
      "✓ All statuses",
      "Queued",
      "Running",
      "Summarizing",
      "Cancelling",
      "Completed",
      "Failed",
      "Interrupted",
      "Interrupted (late result)",
      "Timed out",
      "Orphaned",
    ].includes(node.props.text)
  );
  assert.equal(optionButtons.length, 11, "all status options must be directly visible");
  const timedOutButton = optionButtons.find((node) => node.props.text === "Timed out");
  const orphanedButton = optionButtons.find((node) => node.props.text === "Orphaned");
  const timedOutRow = flattenNodes(tree).find(
    (node) => node.type === "Row" && node.children.includes(timedOutButton)
  );
  assert.ok(timedOutRow && timedOutRow.children.includes(orphanedButton), "Timed out and Orphaned must share a row");
  const clearHistory = flattenNodes(tree).find(
    (node) => node.type === "Button" && node.props.text === "Clear history"
  );
  assert.equal(clearHistory.props.fillMaxWidth, true, "Clear history must occupy its own row");
  assert.equal(clearHistory.props.weight, undefined);
  const runningOption = optionButtons.find((node) => node.props.text === "Running");
  await runningOption.props.onClick();

  assert.equal(ctx.__state.get("dashboard.statusFilter"), "running");
  assert.equal(calls.at(-1).channel, "collaboration.list_agents");
  assert.equal(calls.at(-1).payload.status, "running");

  tree = Screen(ctx);
  assert.ok(flattenNodes(tree).some(
    (node) => node.type === "Button" && node.props.text === "✓ Running"
  ), "selected status button must be marked");
  global.ToolPkg = original;
});

test("stale list responses cannot overwrite a newer status filter", async () => {
  const calls = [];
  const pending = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      call(channel, payload) {
        calls.push({ channel, payload });
        if (channel === "collaboration.get_settings") {
          return Promise.resolve({
            success: true,
            settings: { max_concurrent_agents: 6, max_tool_calls: 16, conversation_context_mode: "auto" },
          });
        }
        if (channel !== "collaboration.list_agents") return Promise.resolve({ success: true });
        if (!payload.status) {
          return new Promise((resolve) => pending.push(resolve));
        }
        return Promise.resolve({
          success: true,
          active: 2,
          queued: 0,
          total: 2,
          status_counts: { running: 2 },
          has_more: false,
          agents: [
            { id: "running-1", status: "running" },
            { id: "running-2", status: "running" },
          ],
        });
      },
    },
  };

  try {
    const ctx = createContext("en-US");
    const initialTree = Screen(ctx);
    const initialLoad = initialTree.props.onLoad();
    const runningOption = flattenNodes(Screen(ctx)).find(
      (node) => node.type === "Button" && node.props.text === "Running"
    );
    await runningOption.props.onClick();

    assert.equal(calls.filter((call) => call.channel === "collaboration.list_agents").length, 2);
    pending.shift()({
      success: true,
      active: 1,
      queued: 0,
      total: 1,
      status_counts: { running: 1 },
      has_more: false,
      agents: [{ id: "stale-all", status: "running" }],
    });
    await initialLoad;

    assert.deepEqual(ctx.__state.get("dashboard.agents").map((agent) => agent.id), ["running-1", "running-2"]);
    assert.equal(ctx.__state.get("dashboard.summary").counts.running, 2);
    assert.equal(ctx.__state.get("dashboard.statusFilter"), "running");
  } finally {
    global.ToolPkg = original;
  }
});

test("stale load-more responses cannot merge into a replacement status filter", async () => {
  const pending = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      call(channel, payload) {
        if (channel === "collaboration.get_settings") {
          return Promise.resolve({
            success: true,
            settings: { max_concurrent_agents: 6, max_tool_calls: 16, conversation_context_mode: "auto" },
          });
        }
        if (channel !== "collaboration.list_agents") return Promise.resolve({ success: true });
        if (payload.status === "running" && !payload.cursor) {
          return Promise.resolve({
            success: true,
            active: 2,
            queued: 0,
            total: 2,
            status_counts: { running: 2 },
            has_more: true,
            next_cursor: "running-cursor",
            agents: [{ id: "running-1", status: "running" }],
          });
        }
        if (payload.status === "running" && payload.cursor === "running-cursor") {
          return new Promise((resolve) => pending.push(resolve));
        }
        if (payload.status === "completed") {
          return Promise.resolve({
            success: true,
            active: 0,
            queued: 0,
            total: 1,
            status_counts: { completed: 1 },
            has_more: false,
            agents: [{ id: "completed-1", status: "completed" }],
          });
        }
        return Promise.resolve({ success: true, active: 0, queued: 0, total: 0, has_more: false, agents: [] });
      },
    },
  };

  try {
    const ctx = createContext("en-US");
    const runningOption = flattenNodes(Screen(ctx)).find(
      (node) => node.type === "Button" && node.props.text === "Running"
    );
    await runningOption.props.onClick();
    const loadMore = flattenNodes(Screen(ctx)).find(
      (node) => node.type === "Button" && node.props.text === "Load more"
    );
    const staleLoadMore = loadMore.props.onClick();
    const completedOption = flattenNodes(Screen(ctx)).find(
      (node) => node.type === "Button" && node.props.text === "Completed"
    );
    await completedOption.props.onClick();

    pending.shift()({
      success: true,
      active: 2,
      queued: 0,
      total: 2,
      status_counts: { running: 2 },
      has_more: false,
      agents: [{ id: "running-2", status: "running" }],
    });
    await staleLoadMore;

    assert.deepEqual(ctx.__state.get("dashboard.agents").map((agent) => agent.id), ["completed-1"]);
    assert.deepEqual(ctx.__state.get("dashboard.summary").counts, { completed: 1 });
    assert.equal(ctx.__state.get("dashboard.cursor"), "");
    assert.equal(ctx.__state.get("dashboard.hasMore"), false);
  } finally {
    global.ToolPkg = original;
  }
});

test("history cleanup and detail deletion require confirmation before destructive IPC", async () => {
  const calls = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      async call(channel, payload) {
        calls.push({ channel, payload });
        if (channel === "collaboration.clear_history") return { success: true, deleted: 3 };
        if (channel === "collaboration.delete_agent") return { success: true, deleted: 1 };
        return { success: true, active: 0, queued: 0, total: 0, has_more: false, agents: [] };
      },
    },
  };

  try {
    const listCtx = createContext("en-US");
    let tree = Screen(listCtx);
    const clearButton = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Clear history"
    );
    assert.ok(clearButton);
    assert.equal(clearButton.props.containerColor, "error");
    assert.equal(clearButton.props.contentColor, "onError");
    clearButton.props.onClick();
    assert.equal(listCtx.__state.get("dashboard.view"), "confirm");
    assert.equal(calls.some((call) => call.channel === "collaboration.clear_history"), false);
    tree = Screen(listCtx);
    const confirmClear = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    );
    await confirmClear.props.onClick();
    assert.equal(calls.filter((call) => call.channel === "collaboration.clear_history").length, 1);
    assert.equal(listCtx.__state.get("dashboard.view"), "list");

    const detailCtx = createContext("en-US");
    detailCtx.__state.set("dashboard.view", "detail");
    detailCtx.__state.set("dashboard.selectedAgent", {
      id: "agent_delete",
      name: "Delete me",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
    });
    tree = Screen(detailCtx);
    const topRow = flattenNodes(tree).find(
      (node) => node.type === "Row" && flattenNodes(node.children).some(
        (child) => child.type === "Button" && child.props.text === "Back"
      )
    );
    const topButtons = flattenNodes(topRow).filter((node) => node.type === "Button");
    assert.deepEqual(topButtons.map((node) => node.props.text), ["Back", "Delete"]);
    topButtons[1].props.onClick();
    assert.equal(detailCtx.__state.get("dashboard.view"), "confirm");
    assert.equal(calls.some((call) => call.channel === "collaboration.delete_agent"), false);
    tree = Screen(detailCtx);
    const confirmDelete = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    );
    await confirmDelete.props.onClick();
    const deleteCall = calls.find((call) => call.channel === "collaboration.delete_agent");
    assert.deepEqual(deleteCall.payload, { agent_id: "agent_delete" });
    assert.equal(detailCtx.__state.get("dashboard.selectedAgent"), null);
    assert.equal(detailCtx.__state.get("dashboard.view"), "list");
  } finally {
    global.ToolPkg = original;
  }
});


test("task tree text toggles between the current excerpt and the complete task without adding icons", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    const excerpt = "Inspect the task tree and keep the current two-line excerpt.";
    const complete = `${excerpt} ${"Complete task detail. ".repeat(24)}`;
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_tree_toggle",
      name: "Tree toggle",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
    });
    ctx.__state.set("dashboard.treeNodes", [{
      agent_id: "agent_tree_toggle",
      execution_id: "execution_tree_toggle",
      name: "Tree toggle",
      status: "completed",
      run_seq: 1,
      tree_depth: 0,
      task: complete,
      task_excerpt: excerpt,
    }]);

    let nodes = flattenNodes(Screen(ctx));
    let task = nodes.find((node) => node.type === "Text" && node.props.text === excerpt);
    assert.ok(task);
    assert.equal(task.props.maxLines, 2);
    assert.equal(task.props.overflow, "ellipsis");
    assert.equal(Object.prototype.hasOwnProperty.call(task.props, "onClick"), false);
    let taskRow = nodes.find((node) => node.type === "Row" && typeof node.props.onClick === "function" &&
      flattenNodes(node.children).some((child) => child.type === "Text" && child.props.text === excerpt));
    assert.ok(taskRow);
    const iconsBefore = nodes.filter((node) => node.type === "Icon").map((node) => node.props.name);

    taskRow.props.onClick();
    nodes = flattenNodes(Screen(ctx));
    task = nodes.find((node) => node.type === "Text" && node.props.text === complete);
    assert.ok(task);
    assert.equal(Object.prototype.hasOwnProperty.call(task.props, "maxLines"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(task.props, "overflow"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(task.props, "onClick"), false);
    assert.deepEqual(nodes.filter((node) => node.type === "Icon").map((node) => node.props.name), iconsBefore);

    taskRow = nodes.find((node) => node.type === "Row" && typeof node.props.onClick === "function" &&
      flattenNodes(node.children).some((child) => child.type === "Text" && child.props.text === complete));
    assert.ok(taskRow);
    taskRow.props.onClick();
    nodes = flattenNodes(Screen(ctx));
    task = nodes.find((node) => node.type === "Text" && node.props.text === excerpt);
    assert.equal(task.props.maxLines, 2);
    assert.equal(task.props.overflow, "ellipsis");
  } finally {
    global.ToolPkg = original;
  }
});

test("active Agent detail disables deletion", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  const ctx = createContext("en-US");
  ctx.__state.set("dashboard.view", "detail");
  ctx.__state.set("dashboard.selectedAgent", {
    id: "agent_running",
    name: "Running",
    status: "running",
    run_seq: 1,
    read_only: true,
    priority: "normal",
    target_paths: [],
    execution: {},
  });
  const deleteButton = flattenNodes(Screen(ctx)).find(
    (node) => node.type === "Button" && node.props.text === "Delete"
  );
  assert.equal(deleteButton.props.enabled, false);
  global.ToolPkg = original;
});


test("Chinese dashboard localizes agent status, priority and metric labels", () => {
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: { async call() { return { success: true }; } },
  };

  const ctx = createContext("zh-CN");
  ctx.__state.set("dashboard.agents", [{
    id: "agent_localized",
    name: "本地化测试",
    status: "completed",
    run_seq: 2,
    read_only: true,
    priority: "normal",
    pending_messages: 3,
    execution: { task_excerpt: "检查界面文案", current_tool: "read_file", tool_count: 4 },
  }]);
  ctx.__state.set("dashboard.summary", { active: 0, queued: 0, total: 1, counts: { completed: 1 } });

  const texts = flattenNodes(Screen(ctx))
    .filter((node) => node.type === "Text")
    .map((node) => node.props.text);
  assert.ok(texts.includes("已完成"));
  assert.ok(texts.includes("运行 2 · 只读 · 普通"));
  assert.ok(texts.includes("当前工具=read_file · 工具调用次数=4 · 待处理消息=3"));
  assert.equal(texts.some((value) => typeof value === "string" && /^(completed|Run |tool=)/.test(value)), false);
  global.ToolPkg = original;
});

test("Chinese dashboard detail localizes labels, enum values and permission summary", () => {
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: { async call() { return { success: true }; } },
  };

  const ctx = createContext("zh-CN");
  ctx.__state.set("dashboard.view", "detail");
  ctx.__state.set("dashboard.selectedAgent", {
    id: "agent_detail",
    name: "详情测试",
    status: "completed",
    run_seq: 1,
    read_only: true,
    priority: "high",
    workspace_path: "/workspace",
    workspace_env: "android",
    target_paths: [],
    pending_messages: 1,
    delivered_messages: 2,
    acknowledged_messages: 1,
    execution: {
      current_tool: "read_file",
      tool_count: 5,
      checkpoint_turns: 2,
      control_status: "accepted",
      control_source: "agent_response",
    },
  });

  const texts = flattenNodes(Screen(ctx))
    .filter((node) => node.type === "Text")
    .map((node) => node.props.text);
  for (const label of ["Agent 标识:", "状态:", "运行:", "优先级:", "当前工具:", "工具调用次数:", "检查点轮次:", "控制协议:", "消息:"]) {
    assert.ok(texts.includes(label), `missing localized label: ${label}`);
  }
  assert.ok(texts.includes("高"));
  assert.ok(texts.includes("已接受 / Agent 响应"));
  assert.ok(texts.includes("排队=1, 已送达=2, 已确认=1"));
  assert.ok(texts.some((value) => typeof value === "string" && value.includes("只读: 是") && value.includes("工作区绝对路径: /workspace")));

  ctx.__state.get("dashboard.selectedAgent").execution.control_source = "continuation_repair";
  const repairedTexts = flattenNodes(Screen(ctx))
    .filter((node) => node.type === "Text")
    .map((node) => node.props.text);
  assert.ok(repairedTexts.includes("已接受 / 自动续作修复"));
  global.ToolPkg = original;
});

test("structured task results render readable fields instead of raw JSON", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("zh-CN");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_result_json",
      name: "结果测试",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
      result: JSON.stringify({
        success: true,
        message: "已完成写入",
        data: { path: "/workspace/output.txt", count: 3 },
        files: ["a.js", "b.js"],
      }),
      recent_events: [],
    });

    const nodes = flattenNodes(Screen(ctx));
    const texts = nodes.filter((node) => node.type === "Text").map((node) => node.props.text);
    const buttons = nodes.filter((node) => node.type === "Button").map((node) => node.props.text);
    assert.equal(buttons.includes("显示结果"), false);
    assert.equal(buttons.includes("隐藏结果"), false);
    assert.ok(texts.includes("执行成功"));
    assert.ok(texts.includes("成功:"));
    assert.ok(texts.includes("是"));
    assert.ok(texts.includes("消息:"));
    assert.ok(texts.includes("已完成写入"));
    assert.ok(texts.includes("数据 · 路径:"));
    assert.ok(texts.includes("/workspace/output.txt"));
    assert.ok(texts.includes("文件:"));
    assert.ok(texts.includes("a.js · b.js"));
    assert.equal(texts.some((value) => typeof value === "string" && value.includes('"success"')), false);
    assert.ok(nodes.some((node) => node.type === "Card" && node.props.containerColor === "primaryContainer"));
  } finally {
    global.ToolPkg = original;
  }
});


test("JSON code blocks are parsed while plain text results remain readable text", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const jsonCtx = createContext("en-US");
    jsonCtx.__state.set("dashboard.view", "detail");
    jsonCtx.__state.set("dashboard.selectedAgent", {
      id: "agent_fenced_json",
      name: "Fenced result",
      status: "failed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
      result: '```json\n{"success":false,"error":"permission denied","code":403}\n```',
      recent_events: [],
    });
    let nodes = flattenNodes(Screen(jsonCtx));
    let texts = nodes.filter((node) => node.type === "Text").map((node) => node.props.text);
    assert.ok(texts.includes("Execution failed"));
    assert.ok(texts.includes("permission denied"));
    assert.equal(texts.some((value) => typeof value === "string" && value.includes('"error"')), false);
    assert.ok(nodes.some((node) => node.type === "Card" && node.props.containerColor === "errorContainer"));

    const textCtx = createContext("en-US");
    textCtx.__state.set("dashboard.view", "detail");
    textCtx.__state.set("dashboard.selectedAgent", {
      id: "agent_plain_result",
      name: "Plain result",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
      result: "Changed the dashboard and verified all tests.",
      recent_events: [],
    });
    nodes = flattenNodes(Screen(textCtx));
    texts = nodes.filter((node) => node.type === "Text").map((node) => node.props.text);
    assert.ok(texts.includes("Changed the dashboard and verified all tests."));
    assert.equal(texts.includes("Structured result"), false);
  } finally {
    global.ToolPkg = original;
  }
});


test("Markdown task results render native headings, lists, quotes, links and code blocks", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_markdown_result",
      name: "Markdown result",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
      result: [
        "# Release result",
        "",
        "Summary with **bold text** and [details](https://example.test/report).",
        "",
        "- First change",
        "1. Verification step",
        "",
        "> All checks passed.",
        "",
        "---",
        "",
        "```js",
        "const ready = true;",
        "```",
      ].join("\n"),
      recent_events: [],
    });

    let nodes = flattenNodes(Screen(ctx));
    const previewText = [
      "Release result",
      "Summary with bold text and details (https://example.test/report).",
      "• First change",
      "1. Verification step",
      "> All checks passed.",
      "const ready = true;",
    ].join("\n");
    let preview = nodes.find((node) => node.type === "Text" && node.props.text === previewText);
    assert.ok(preview);
    assert.equal(preview.props.maxLines, 3);
    assert.equal(preview.props.overflow, "ellipsis");
    let resultRow = nodes.find((node) => node.type === "Row" && typeof node.props.onClick === "function" &&
      flattenNodes(node.children).some((child) => child.type === "Text" && child.props.text === previewText));
    assert.ok(resultRow);

    resultRow.props.onClick();
    nodes = flattenNodes(Screen(ctx));
    const texts = nodes.filter((node) => node.type === "Text").map((node) => node.props.text);
    const heading = nodes.find((node) => node.type === "Text" && node.props.text === "Release result");
    assert.ok(heading);
    assert.equal(heading.props.style, "titleLarge");
    assert.equal(heading.props.fontWeight, "bold");
    assert.ok(texts.includes("Summary with bold text and details (https://example.test/report)."));
    assert.ok(texts.includes("•"));
    assert.ok(texts.includes("First change"));
    assert.ok(texts.includes("1."));
    assert.ok(texts.includes("Verification step"));
    assert.ok(texts.includes("All checks passed."));
    assert.ok(texts.includes("js"));
    assert.ok(texts.includes("const ready = true;"));
    assert.ok(nodes.some((node) => node.type === "Surface" && node.props.height === 1));
    assert.equal(nodes.some((node) => node.type === "WebView"), false);
    assert.equal(texts.some((value) => typeof value === "string" && value.includes("**")), false);

    resultRow = nodes.find((node) => node.type === "Row" && typeof node.props.onClick === "function" &&
      flattenNodes(node.children).some((child) => child.type === "Text" && child.props.text === "Release result"));
    assert.ok(resultRow);
    resultRow.props.onClick();
    nodes = flattenNodes(Screen(ctx));
    preview = nodes.find((node) => node.type === "Text" && node.props.text === previewText);
    assert.equal(preview.props.maxLines, 3);
    assert.equal(preview.props.overflow, "ellipsis");
  } finally {
    global.ToolPkg = original;
  }
});


test("recent events render localized readable cards instead of raw JSON", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("zh-CN");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_events",
      name: "事件测试",
      status: "completed",
      run_seq: 2,
      read_only: true,
      priority: "normal",
      target_paths: [],
      result: "完成",
      execution: {},
      recent_events: [
        {
          id: "event_tool",
          type: "tool_started",
          run_seq: 2,
          created_at: 1785067200000,
          data: { tool_name: "read_file" },
        },
        {
          id: "event_terminal",
          type: "run_terminal",
          run_seq: 2,
          created_at: 1785067210000,
          data: { status: "completed", error: "", diagnostics: { safe: true } },
        },
      ],
    });

    const nodes = flattenNodes(Screen(ctx));
    const texts = nodes.filter((node) => node.type === "Text").map((node) => node.props.text);
    assert.ok(texts.includes("工具调用已开始"));
    assert.ok(texts.includes("工具: read_file"));
    assert.ok(texts.includes("运行已结束"));
    assert.ok(texts.includes("状态: 已完成"));
    assert.ok(texts.includes("详细数据: 1"));
    assert.equal(texts.some((value) => typeof value === "string" && value.includes('"tool_name"')), false);
    assert.equal(texts.some((value) => typeof value === "string" && value.includes('"diagnostics"')), false);
    assert.ok(nodes.some((node) => node.type === "Card" && node.props.border));
  } finally {
    global.ToolPkg = original;
  }
});


test("unknown recent event types fall back to readable labels", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_unknown_event",
      name: "Unknown event",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
      recent_events: [{ type: "custom_future_event", run_seq: 1, created_at: 1, data: { future_value: 4 } }],
    });
    const texts = flattenNodes(Screen(ctx)).filter((node) => node.type === "Text").map((node) => node.props.text);
    assert.ok(texts.includes("Custom Future Event"));
    assert.ok(texts.includes("Additional data: 1"));
  } finally {
    global.ToolPkg = original;
  }
});


test("English dashboard localizes continuation repair control source", () => {
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: { async call() { return { success: true }; } },
  };

  const ctx = createContext("en-US");
  ctx.__state.set("dashboard.view", "detail");
  ctx.__state.set("dashboard.selectedAgent", {
    id: "agent_repair",
    name: "Repair test",
    status: "completed",
    run_seq: 1,
    read_only: true,
    priority: "normal",
    target_paths: [],
    execution: {
      control_status: "accepted",
      control_source: "continuation_repair",
    },
  });

  const texts = flattenNodes(Screen(ctx))
    .filter((node) => node.type === "Text")
    .map((node) => node.props.text);
  assert.ok(texts.includes("Accepted / Continuation repair"));
  global.ToolPkg = original;
});

test("English dashboard localizes action-gate repair control source", () => {
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: { async call() { return { success: true }; } },
  };

  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_action_gate_repair",
      name: "Action gate repair test",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {
        control_status: "repaired",
        control_source: "action_gate_repair",
      },
    });

    const texts = flattenNodes(Screen(ctx))
      .filter((node) => node.type === "Text")
      .map((node) => node.props.text);
    assert.ok(texts.includes("Repaired / Action-gate repair"));
  } finally {
    global.ToolPkg = original;
  }
});

test("English dashboard shows action-gate state, counters, and lifecycle events", () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "detail");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_gate_observability",
      name: "Gate observability",
      status: "running",
      run_seq: 1,
      read_only: false,
      priority: "normal",
      target_paths: ["/workspace/output.txt"],
      execution: {
        current_action_gate: { kind: "pending_mutation", allowed_tools: ["edit_file"] },
        action_gate_activation_count: 2,
        action_gate_block_count: 1,
      },
      recent_events: [
        { type: "action_gate_activated", run_seq: 1, created_at: 1, data: { kind: "pending_mutation" } },
        { type: "action_gate_blocked", run_seq: 1, created_at: 2, data: { kind: "pending_mutation", tools: ["read_file"] } },
        { type: "action_gate_released", run_seq: 1, created_at: 3, data: { kind: "pending_mutation" } },
      ],
    });
    const texts = flattenNodes(Screen(ctx)).filter((node) => node.type === "Text").map((node) => node.props.text);
    assert.ok(texts.includes("Current action gate:"));
    assert.ok(texts.includes("pending_mutation / edit_file"));
    assert.ok(texts.includes("Action-gate activations:"));
    assert.ok(texts.includes("2"));
    assert.ok(texts.includes("Action-gate blocks:"));
    assert.ok(texts.includes("Action gate activated"));
    assert.ok(texts.includes("Action gate blocked tools"));
    assert.ok(texts.includes("Action gate released"));
  } finally {
    global.ToolPkg = original;
  }
});

test("global settings control updates scheduler settings from the dashboard home", async () => {
  const calls = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options });
        if (channel === "collaboration.get_settings") {
          return {
            success: true,
            settings: { max_concurrent_agents: 6, max_active_runs_per_root: 3, max_tool_calls: 16, max_model_retries: 5, conversation_context_mode: "auto" },
          };
        }
        if (channel === "collaboration.update_settings") {
          return { success: true, settings: payload };
        }
        return { success: true, active: 0, queued: 0, total: 0, has_more: false, agents: [] };
      },
    },
  };

  const ctx = createContext("en-US");
  let tree = Screen(ctx);
  const inputs = flattenNodes(tree).filter(
    (node) => node.type === "TextField" && [
      "Global maximum concurrent Agents",
      "Per-root task-tree concurrency",
      "Global tool calls",
      "AI call retries",
    ].includes(node.props.label)
  );
  assert.equal(inputs.length, 4, "global settings inputs must be on the dashboard home");
  inputs.find((input) => input.props.label === "Global maximum concurrent Agents").props.onValueChange("0");
  inputs.find((input) => input.props.label === "Per-root task-tree concurrency").props.onValueChange("0");
  inputs.find((input) => input.props.label === "Global tool calls").props.onValueChange("0");
  inputs.find((input) => input.props.label === "AI call retries").props.onValueChange("-1");
  tree = Screen(ctx);
  const contextButtons = flattenNodes(tree).filter(
    (node) => node.type === "Button" && ["Off", "On", "✓ Auto"].includes(node.props.text)
  );
  assert.equal(contextButtons.length, 3, "conversation context must expose three global modes");
  contextButtons.find((node) => node.props.text === "On").props.onClick();

  tree = Screen(ctx);
  const save = flattenNodes(tree).find(
    (node) => node.type === "Button" && node.props.text === "Save global settings"
  );
  assert.ok(save);
  await save.props.onClick();

  const update = calls.find((call) => call.channel === "collaboration.update_settings");
  assert.deepEqual(update.payload, {
    max_concurrent_agents: 0,
    max_active_runs_per_root: 0,
    max_tool_calls: 0,
    max_model_retries: -1,
    conversation_context_mode: "on",
  });
  global.ToolPkg = original;
});

test("create form creates one Agent and uses global settings implicitly", async () => {
  const calls = [];
  const original = global.ToolPkg;
  let resolveWatch;
  const watchResult = new Promise((resolve) => {
    resolveWatch = resolve;
  });
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options });
        if (channel === "collaboration.spawn_agent") {
          return { success: true, agent: { id: "agent_created" } };
        }
        if (channel === "collaboration.list_agents") {
          return {
            success: true,
            active: 1,
            queued: 0,
            total: 1,
            has_more: false,
            agents: [{ id: "agent_created", name: "Reviewer", status: "running" }],
          };
        }
        if (channel === "collaboration.inspect_agent") {
          return {
            success: true,
            agent: {
              id: "agent_created",
              name: "Reviewer",
              status: "running",
              run_seq: 1,
              read_only: true,
              priority: "normal",
              target_paths: [],
              execution: {},
            },
          };
        }
        if (channel === "collaboration.list_tree") {
          return { success: true, root_run_id: "root_created", nodes: [] };
        }
        if (channel === "collaboration.watch_tree_events") return watchResult;
        return { success: true };
      },
    },
  };

  const ctx = createContext("en-US");
  ctx.__state.set("dashboard.view", "create");
  ctx.__state.set("dashboard.create.name", "Reviewer");
  ctx.__state.set("dashboard.create.task", "Review the implementation");

  let tree = Screen(ctx);
  assert.equal(flattenNodes(tree).some(
    (node) => node.type === "TextField" && [
      "Global maximum concurrent Agents",
      "Per-root task-tree concurrency",
      "Global tool calls",
      "AI call retries",
    ].includes(node.props.label)
  ), false, "global settings must not be duplicated on the create form");

  tree = Screen(ctx);
  const submit = flattenNodes(tree).find(
    (node) => node.type === "Button" && node.props.text === "Submit"
  );
  assert.ok(submit, "create form must expose Submit");
  const submitPromise = submit.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  const spawnCalls = calls.filter((call) => call.channel === "collaboration.spawn_agent");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].payload.name, "Reviewer");
  assert.equal(spawnCalls[0].payload.max_tool_calls, undefined);
  assert.equal(typeof spawnCalls[0].payload.request_id, "string");
  assert.ok(calls.some((call) => call.channel === "collaboration.list_agents"));
  assert.equal(ctx.__state.get("dashboard.view"), "detail");
  assert.equal(ctx.__state.get("dashboard.mutationLoading"), false);
  resolveWatch({ success: true });
  await submitPromise;
  global.ToolPkg = original;
});

test("follow-up submit keeps the Compose action alive through detail refresh", async () => {
  const original = global.ToolPkg;
  const calls = [];
  let resolveFollowup;
  let actionSettled = false;
  const followupResult = new Promise((resolve) => {
    resolveFollowup = resolve;
  });
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options, actionSettled });
        if (channel === "collaboration.followup_task") return followupResult;
        if (channel === "collaboration.list_agents") {
          return {
            success: true,
            active: 1,
            queued: 0,
            total: 1,
            has_more: false,
            agents: [{ id: "agent_follow", name: "Follow", status: "running" }],
          };
        }
        if (channel === "collaboration.inspect_agent") {
          return {
            success: true,
            agent: {
              id: "agent_follow",
              name: "Follow",
              status: "running",
              run_seq: 2,
              read_only: true,
              priority: "normal",
              target_paths: [],
              execution: {},
            },
          };
        }
        if (channel === "collaboration.list_tree") {
          return { success: true, root_run_id: "root_follow", nodes: [] };
        }
        if (channel === "collaboration.watch_tree_events") {
          return {
            success: true,
            revision: 0,
            next_revision: 0,
            events: [],
            shutdown: true,
          };
        }
        return { success: true };
      },
    },
  };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.view", "followup");
    ctx.__state.set("dashboard.follow.task", "Continue the verified work");
    ctx.__state.set("dashboard.follow.mode", "readonly");
    ctx.__state.set("dashboard.selectedAgent", {
      id: "agent_follow",
      name: "Follow",
      status: "completed",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
    });

    const tree = Screen(ctx);
    const submit = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Submit"
    );
    assert.ok(submit, "follow-up form must expose Submit");
    const actionPromise = submit.props.onClick();
    assert.equal(typeof actionPromise?.then, "function", "follow-up handler must return its full action Promise");
    actionPromise.finally(() => { actionSettled = true; });
    assert.deepEqual(calls.map((call) => call.channel), ["collaboration.followup_task"]);

    resolveFollowup({ success: true, agent: { id: "agent_follow" } });
    await actionPromise;

    assert.deepEqual(calls.map((call) => call.channel), [
      "collaboration.followup_task",
      "collaboration.list_agents",
      "collaboration.inspect_agent",
      "collaboration.list_tree",
      "collaboration.watch_tree_events",
    ]);
    assert.ok(calls.every((call) => call.actionSettled === false),
      "all post-follow-up refresh calls must run before the Compose action session settles");
    assert.equal(ctx.__state.get("dashboard.error"), "");
    assert.equal(ctx.__state.get("dashboard.view"), "detail");
  } finally {
    global.ToolPkg = original;
  }
});

test("dashboard onLoad automatically loads Agents on every page mount", async () => {
  const calls = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options });
        if (channel === "collaboration.get_settings") {
          return {
            success: true,
            settings: { max_concurrent_agents: 6, max_tool_calls: 16, conversation_context_mode: "auto" },
          };
        }
        return {
          success: true,
          active: 1,
          queued: 0,
          total: 1,
          has_more: false,
          agents: [{ id: "agent_auto", name: "Auto", status: "running" }],
        };
      },
    },
  };
  const ctx = createContext();
  let tree = Screen(ctx);
  await tree.props.onLoad();
  tree = Screen(ctx);
  await tree.props.onLoad();
  assert.equal(calls.filter((call) => call.channel === "collaboration.list_agents").length, 2,
    "each page mount must reload the Agent list");
  const firstList = calls.find((call) => call.channel === "collaboration.list_agents");
  assert.equal(firstList.options, undefined);
  assert.equal(ctx.__state.get("dashboard.agents")[0].id, "agent_auto");
  global.ToolPkg = original;
});

test("detail action keeps one IPC closure through initial load, watch and snapshot refresh", async () => {
  const original = global.ToolPkg;
  let resolveInitialInspect;
  let resolveFirstWatch;
  let resolveSecondWatch;
  let inspectCalls = 0;
  let watchCalls = 0;
  const initialInspect = new Promise((resolve) => {
    resolveInitialInspect = resolve;
  });
  const firstWatch = new Promise((resolve) => {
    resolveFirstWatch = resolve;
  });
  const secondWatch = new Promise((resolve) => {
    resolveSecondWatch = resolve;
  });
  const originatingCalls = [];
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        originatingCalls.push({ channel, payload, options });
        if (channel === "collaboration.inspect_agent") {
          inspectCalls += 1;
          if (inspectCalls === 1) return initialInspect;
          return {
            success: true,
            agent: {
              id: "agent_watch",
              name: "Watch",
              status: "running",
              run_seq: 1,
              read_only: true,
              priority: "normal",
              target_paths: [],
              execution: {},
            },
          };
        }
        if (channel === "collaboration.list_tree") {
          return { success: true, root_run_id: "root_watch", nodes: [] };
        }
        if (channel === "collaboration.watch_tree_events") {
          watchCalls += 1;
          return watchCalls === 1 ? firstWatch : secondWatch;
        }
        return { success: true };
      },
    },
  };
  try {
    const ctx = createContext("en-US");
    ctx.__state.set("dashboard.agents", [{
      id: "agent_watch",
      name: "Watch",
      status: "running",
      run_seq: 1,
      read_only: true,
      priority: "normal",
      target_paths: [],
      execution: {},
    }]);
    let tree = Screen(ctx);
    const details = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Details"
    );
    const openPromise = details.props.onClick();
    assert.deepEqual(
      originatingCalls.map((call) => call.channel),
      ["collaboration.inspect_agent"],
      "detail action must capture and invoke the originating IPC before its first await"
    );

    const replacementCalls = [];
    global.ToolPkg = {
      ipc: {
        async call(channel) {
          replacementCalls.push(channel);
          throw new Error(`ToolPkg.ipc channel is not registered: ${channel}`);
        },
      },
    };
    Screen(ctx);

    resolveInitialInspect({
      success: true,
      agent: {
        id: "agent_watch",
        name: "Watch",
        status: "running",
        run_seq: 1,
        read_only: true,
        priority: "normal",
        target_paths: [],
        execution: {},
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watchCalls, 1);
    assert.deepEqual(
      originatingCalls.map((call) => call.channel),
      [
        "collaboration.inspect_agent",
        "collaboration.list_tree",
        "collaboration.watch_tree_events",
      ]
    );
    assert.equal(ctx.__state.get("dashboard.detailLoading"), false);
    assert.equal(ctx.__state.get("dashboard.view"), "detail");

    resolveFirstWatch({
      success: true,
      events: [{
        agent_id: "agent_watch",
        execution_id: "root_watch",
        type: "checkpoint",
        created_at: 1,
        data: {},
      }],
      revision: 1,
      next_revision: 1,
      snapshot_required: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inspectCalls, 2, "event refresh must reuse the originating IPC closure");
    assert.equal(watchCalls, 2, "watch loop must continue through the originating IPC closure");
    assert.deepEqual(
      originatingCalls.map((call) => call.channel),
      [
        "collaboration.inspect_agent",
        "collaboration.list_tree",
        "collaboration.watch_tree_events",
        "collaboration.inspect_agent",
        "collaboration.list_tree",
        "collaboration.watch_tree_events",
      ]
    );
    assert.ok(originatingCalls.every((call) => call.options === undefined));

    tree = Screen(ctx);
    const back = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Back"
    );
    back.props.onClick();
    resolveSecondWatch({ success: true, events: [], revision: 1, next_revision: 1, timed_out: true });
    await openPromise;

    assert.equal(replacementCalls.length, 0, "the replacement IPC must not run inside the originating action");
    assert.equal(ctx.__state.get("dashboard.error") || "", "");
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update helpers validate archive names and build host contracts", () => {
  assert.equal(entryModule.__test.isToolPkgArchive({ name: "release.TOOLPKG" }), true);
  assert.equal(entryModule.__test.isToolPkgArchive({ path: "/tmp/release.toolpkg" }), true);
  assert.equal(entryModule.__test.isToolPkgArchive({ name: "release.zip" }), false);

  const payload = entryModule.__test.buildToolPkgUpdatePayload({
    path: "/tmp/picked_1.toolpkg",
    name: "Collaboration 1.0.3.toolpkg",
    size: 1234,
  }, 42);
  assert.deepEqual(payload, {
    source_path: "/tmp/picked_1.toolpkg",
    source_name: "Collaboration 1.0.3.toolpkg",
    source_size: 1234,
    target_path: "/sdcard/Android/data/com.ai.assistance.operit/files/packages/com.operit.collaboration_orchestrator-42.toolpkg",
  });
  assert.deepEqual(entryModule.__test.buildToolPkgCopyParams(payload), {
    source: "/tmp/picked_1.toolpkg",
    destination: payload.target_path,
    recursive: "false",
    source_environment: "android",
    dest_environment: "android",
  });
  assert.deepEqual(entryModule.__test.buildToolPkgBroadcastParams(payload), {
    action: "com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG",
    component: "com.ai.assistance.operit/.core.tools.packTool.ToolPkgDebugInstallReceiver",
    extras: {
      package_name: "com.operit.collaboration_orchestrator",
      file_path: payload.target_path,
      reset_subpackage_states: true,
    },
  });
});

test("ToolPkg update selection validates before confirmation", async () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const cases = [
      {
        result: { cancelled: true, files: [] },
        toast: "Package selection cancelled",
      },
      {
        result: { cancelled: false, files: [{ name: "release.zip", path: "/tmp/release.zip" }] },
        toast: "Choose a .toolpkg archive",
      },
      {
        result: { cancelled: false, files: [{ name: "release.toolpkg", uri: "content://release" }] },
        toast: "The host did not return a package path that can be copied",
      },
    ];
    for (const item of cases) {
      const toolCalls = [];
      const toasts = [];
      const ctx = createContext("en-US");
      ctx.showToast = (message) => { toasts.push(message); };
      ctx.openFilePicker = async (options) => {
        assert.deepEqual(options, {
          mimeTypes: ["application/zip", "application/octet-stream", "*/*"],
          allowMultiple: false,
          persistPermission: false,
        });
        return item.result;
      };
      ctx.callTool = async (...args) => { toolCalls.push(args); };
      const choose = flattenNodes(Screen(ctx)).find(
        (node) => node.type === "Button" && node.props.text === "Choose package"
      );
      assert.ok(choose);
      await choose.props.onClick();
      assert.equal(ctx.__state.get("dashboard.view"), "list");
      assert.equal(ctx.__state.get("dashboard.notice") || "", "");
      assert.equal(ctx.__state.get("dashboard.error") || "", "");
      assert.deepEqual(toasts, [item.toast]);
      assert.equal(toolCalls.length, 0);
    }
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update confirms before copying and dispatches the broadcast last", async () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  const toolCalls = [];
  try {
    const ctx = createContext("en-US");
    ctx.openFilePicker = async () => ({
      cancelled: false,
      files: [{ name: "release.TOOLPKG", path: "/tmp/staged.toolpkg", size: 321 }],
    });
    ctx.callTool = async (name, params) => {
      toolCalls.push({ name, params });
      return { success: true };
    };

    let tree = Screen(ctx);
    const choose = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    );
    await choose.props.onClick();
    assert.equal(toolCalls.length, 0, "selection must not create side effects before confirmation");
    assert.equal(ctx.__state.get("dashboard.view"), "confirm");
    assert.equal(ctx.__state.get("dashboard.confirmAction").kind, "updateToolPkg");
    assert.match(ctx.__state.get("dashboard.confirmAction").warning, /release\.TOOLPKG \(321 B\)/);

    tree = Screen(ctx);
    const confirm = flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    );
    await confirm.props.onClick();
    assert.deepEqual(toolCalls.map((call) => call.name), ["copy_file", "send_broadcast"]);
    assert.equal(toolCalls[0].params.source, "/tmp/staged.toolpkg");
    assert.equal(toolCalls[0].params.destination, toolCalls[1].params.extras.file_path);
    assert.equal(toolCalls[1].params.extras.package_name, "com.operit.collaboration_orchestrator");
    assert.equal(ctx.__state.get("dashboard.view"), "list");
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update settles after the broadcast request returns without duplicate progress", async () => {
  const original = global.ToolPkg;
  const toasts = [];
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const ctx = createContext("en-US");
    ctx.showToast = (message) => { toasts.push(message); };
    ctx.openFilePicker = async () => ({
      cancelled: false,
      files: [{ name: "release.toolpkg", path: "/tmp/staged.toolpkg" }],
    });
    ctx.callTool = async () => ({ success: true });
    let tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    ).props.onClick();
    tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    ).props.onClick();

    assert.equal(ctx.__state.get("dashboard.packageUpdate.loading"), false);
    assert.equal(ctx.__state.get("dashboard.packageUpdate.phase"), "idle");
    assert.equal(ctx.__state.get("dashboard.notice"), "");
    assert.deepEqual(toasts, [
      "Update request submitted; the host will install and reload it in the background",
    ]);
    const settledNodes = flattenNodes(Screen(ctx));
    assert.ok(settledNodes.some(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    ));
    assert.equal(settledNodes.some(
      (node) => node.type === "Text" && node.props.text === "Copying the package…"
    ), false);
    assert.equal(settledNodes.filter(
      (node) => node.type === "Text" &&
        node.props.text === "Update request submitted; the host will install and reload it in the background"
    ).length, 0);
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update stops when copying fails", async () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  const toolCalls = [];
  const toasts = [];
  try {
    const ctx = createContext("en-US");
    ctx.showToast = (message) => { toasts.push(message); };
    ctx.openFilePicker = async () => ({
      cancelled: false,
      files: [{ name: "release.toolpkg", path: "/tmp/staged.toolpkg" }],
    });
    ctx.callTool = async (name, params) => {
      toolCalls.push({ name, params });
      if (name === "copy_file") throw new Error("copy denied");
      return { success: true };
    };
    let tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    ).props.onClick();
    tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    ).props.onClick();
    assert.deepEqual(toolCalls.map((call) => call.name), ["copy_file"]);
    assert.deepEqual(toasts, ["copy denied"]);
    assert.equal(ctx.__state.get("dashboard.error") || "", "");
    assert.equal(ctx.__state.get("dashboard.notice") || "", "");
    assert.equal(ctx.__state.get("dashboard.packageUpdate.loading"), false);
    assert.equal(ctx.__state.get("dashboard.packageUpdate.phase"), "idle");
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update reports missing host capabilities through Toast", async () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  try {
    const toasts = [];
    const ctx = createContext("en-US");
    ctx.showToast = (message) => { toasts.push(message); };
    const choose = flattenNodes(Screen(ctx)).find(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    );
    await choose.props.onClick();
    assert.deepEqual(toasts, [
      "This host is missing the file picker or tool-call support required for ToolPkg updates",
    ]);
    assert.equal(ctx.__state.get("dashboard.error") || "", "");
    assert.equal(ctx.__state.get("dashboard.notice") || "", "");
    assert.equal(ctx.__state.get("dashboard.view"), "list");
  } finally {
    global.ToolPkg = original;
  }
});

test("ToolPkg update surfaces a broadcast failure through Toast after a successful copy", async () => {
  const original = global.ToolPkg;
  global.ToolPkg = { ipc: { async call() { return { success: true }; } } };
  const toolCalls = [];
  const toasts = [];
  try {
    const ctx = createContext("en-US");
    ctx.showToast = (message) => { toasts.push(message); };
    ctx.openFilePicker = async () => ({
      cancelled: false,
      files: [{ name: "release.toolpkg", path: "/tmp/staged.toolpkg" }],
    });
    ctx.callTool = async (name, params) => {
      toolCalls.push({ name, params });
      if (name === "send_broadcast") throw new Error("receiver unavailable");
      return { success: true };
    };
    let tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Choose package"
    ).props.onClick();
    tree = Screen(ctx);
    await flattenNodes(tree).find(
      (node) => node.type === "Button" && node.props.text === "Confirm"
    ).props.onClick();
    assert.deepEqual(toolCalls.map((call) => call.name), ["copy_file", "send_broadcast"]);
    assert.deepEqual(toasts, ["receiver unavailable"]);
    assert.equal(ctx.__state.get("dashboard.error") || "", "");
    assert.equal(ctx.__state.get("dashboard.notice"), "");
    assert.equal(ctx.__state.get("dashboard.packageUpdate.loading"), false);
    assert.equal(ctx.__state.get("dashboard.packageUpdate.phase"), "idle");
  } finally {
    global.ToolPkg = original;
  }
});

test("initial Agent loading retries a transient IPC startup failure", async () => {
  const calls = [];
  const original = global.ToolPkg;
  global.ToolPkg = {
    ipc: {
      async call(channel, payload, options) {
        calls.push({ channel, payload, options });
        if (channel === "collaboration.get_settings") {
          return {
            success: true,
            settings: { max_concurrent_agents: 6, max_tool_calls: 16, conversation_context_mode: "auto" },
          };
        }
        const listCalls = calls.filter((call) => call.channel === "collaboration.list_agents").length;
        if (channel === "collaboration.list_agents" && listCalls === 1) {
          throw new Error("ToolPkg IPC runtime is unavailable");
        }
        return {
          success: true,
          active: 0,
          queued: 0,
          total: 1,
          has_more: false,
          agents: [{ id: "agent_retry", name: "Retry", status: "completed" }],
        };
      },
    },
  };
  const ctx = createContext();
  const tree = Screen(ctx);
  await tree.props.onLoad();
  assert.equal(calls.filter((call) => call.channel === "collaboration.list_agents").length, 2);
  assert.equal(ctx.__state.get("dashboard.error"), "");
  assert.equal(ctx.__state.get("dashboard.agents")[0].id, "agent_retry");
  global.ToolPkg = original;
});