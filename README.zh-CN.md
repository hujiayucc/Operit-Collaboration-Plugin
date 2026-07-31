<div align="center">

# 多 Agent 协作调度器

为 Operit 提供后台多 Agent 协作能力

[项目仓库](https://github.com/hujiayucc/Operit-Collaboration-Plugin)

**[English](README.md) | 简体中文**

</div>

用于将分析、开发、审查、测试和后台工作委派给持久子 Agent 的 Operit ToolPkg 插件，包含原生 Compose DSL 控制台、任务树、消息路由、恢复、诊断和提示词阶段工具过滤。

## 主要功能

- 十三个协作与控制工具，用于创建、跟踪、发消息、续接 Run、等待、中断、详情与任务树查询、事件监听、设置和历史管理。
- 父子任务树、单根调度、状态聚合和活动后代中断传播。
- 使用 SQLite Event Store schema v4 持久化 Agent、Run、消息、检查点、树上下文、游标和请求幂等记录；SQLite 不可用时明确回退到内存。
- 可选共享主会话上下文。每个检查点通过绑定的聊天引用读取最新用户/助手历史，不包含系统提示和工具轨迹。
- 通过单调 revision 事件、受限物化快照和逐 Agent 游标，在父级、后代及兄弟 Agent 之间共享检查点级任务树上下文。
- 使用 `COLLABORATION_CONTROL` 返回 `progress`、`finish`、`fail`、消息确认和 Agent 间/发往主流程的消息。
- 原生控制台支持状态、结果、任务树、消息、续作、中断、清理和全局设置。
- 生命周期诊断和 Agent 工具网关。网关只过滤可见工具并保护插件控制接口，不构成操作系统级隔离。

## 安装与构建

可将项目目录导入为 ToolPkg，或构建安装包：

```bash
npm install
npm run build
```

产物为项目根目录下的 `<项目目录名>-v<manifest.version>.toolpkg`。构建器只在临时目录验证，并对入包 JavaScript 执行保守压缩，同时保持函数名、类名、参数名、局部变量名和属性名不混淆，也不改写仓库 `src/`。若目标已存在，命令成功退出但不覆盖；仅在明确需要替换时使用 `--replace`。

安装包仅包含运行时文件和单行 `manifest.json`。已编译 JavaScript 存放在安装包的 `dist/` 目录中；TypeScript 源文件不会入包，`LICENSE`、中英文 README、`tsconfig.json` 和 `prompts/` 也不会入包。

## 协作工具

| 工具 | 用途 |
| --- | --- |
| `spawn_agent` | 创建稳定 Agent 并排队首个 Run。 |
| `list_agents` | 查询 Agent、当前 Run、结果、消息和任务树状态。 |
| `send_message` | 向活动 Agent 的下一检查点排队补充消息。 |
| `followup_task` | 在终态 Agent 上创建新 Run，并保留其身份。 |
| `wait_agent` | 等待指定 Agent 进入终态。 |
| `interrupt_agent` | 中断当前 Run 及其活动后代。 |
| `inspect_agent` | 查询单个 Agent 的 Run、消息、控制和任务树详细状态。 |
| `list_tree` | 列出以指定 Agent 为根的任务树节点。 |
| `watch_tree_events` | 长轮询根 Run 的增量任务树事件。 |
| `get_settings` | 读取全局调度设置。 |
| `update_settings` | 更新调度限制、`max_tool_calls`、`max_model_retries` 和 `conversation_context_mode`。 |
| `delete_agent` | 删除已终止 Agent 及其历史。 |
| `clear_history` | 清除所有已终止 Agent 的历史。 |

返回 queued 只表示已经排队，不代表任务完成。主 Agent 仍负责跟踪和验证委派结果。

## 快速示例

```text
task: "实现用户接口并运行相关测试"
context: "保持现有响应格式"
include_conversation_context: true
workspace_path: "/workspace"
target_paths_json: "[\"/workspace/server\"]"
workspace_env: "android"
read_only: false
priority: "normal"
timeout_ms: 900000
```

可写任务必须设置 `read_only: false` 并提供非空绝对目标路径列表。缺少写路径或传入空数组时自动只读。路径声明只用于调度和提示约束，不是操作系统级强制隔离。

## 设置与限制

| 设置 | 可选值 | 默认值 |
| --- | --- | --- |
| 全局活动 Run | `0` 不限，或 `1`–`16` | `6` |
| 单根任务树活动 Run | `0` 不限，或 `1`–`8` | `3` |
| 全局 `max_tool_calls` | `0` 不限，或 `1`–`64` | `16` |
| `max_model_retries` | `-1` 不限，或 `0`–`12` | `5` |
| 对话上下文 | `off`、`on`、`auto` | `auto` |
| Agent `timeout_ms` | `0` 不限，或 `30000`–`3600000` 的整数 | `900000` |

`timeout_ms` 只度量首个或相邻响应块的网络空闲时间，不限制总生成时长；非法值返回 `timeout_invalid`。

模型重试覆盖网络、限流、超时和服务临时异常；余额不足、认证、参数、上下文超限和策略拒绝不重试。若失败前工具可能已执行，下一检查点先核验目标状态。

任务树最大深度为 8，每个父 Run 最多 12 个直接子 Run。follow-up 会创建新的根任务树。

## 消息与控制

父消息在 Agent 的下一检查点注入。`delivered` 表示模型已收到，`acknowledged` 表示模型在 `message_acks` 中返回该消息 ID。只应确认实际处理过的 ID。

Agent 可在 `COLLABORATION_CONTROL` 中添加 `outbound_messages`，目标可为 `main`、`parent`、`root` 或同一任务树中的其他活动 Agent。发往 `main` 的消息会通过 Agent 结果中的 `main_messages` 返回。

## 持久化与恢复

优先使用 SQLite Event Store schema v4。成功响应会报告持久化模式和 revision；SQLite 不可用时返回 `persistence: "memory"`。

runtime 重启后，未启动的 queued Run 会重新排队；符合条件的只读 Run 可在同一 Run 上创建新 attempt。活动写 Run 或存在未决副作用的 Run 会标记为 `orphaned`，避免自动重复写入。

## 探针与网关

`tool_lifecycle_probe` 子包提供：

- `probe_get_status`、`probe_get_log`、`probe_clear_log`、`probe_get_prompt_compose_log`
- `gateway_register`、`gateway_unregister`、`gateway_status`

探针缓冲仅存内存，重启后清空。网关按精确工具名过滤；非空白名单优先，宿主未提供工具列表时关闭式返回空列表。子 Agent、summary 和 finalization 上下文通过提示过滤与 IPC 执行守卫持续隐藏 collaboration、probe 和 gateway 控制接口。

## 系统提示模板

可选宿主模板位于 `prompts/`：

- `prompt-full-zh.md`、`prompt-full-en.md`
- `prompt-read-only-zh.md`、`prompt-read-only-en.md`
- `prompt-mini-zh.md`、`prompt-mini-en.md`

两份 README 和这些源码模板不会被运行时自动读取或注入。

## 验证

```bash
npm run typecheck
npm test
```

## 许可证

[GPL-3.0](LICENSE)