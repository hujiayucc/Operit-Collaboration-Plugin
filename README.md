# Operit Collaboration Plugin

为当前主会话提供后台多 Agent 调度能力的 ToolPkg 插件。支持多 Agent 并行开发、父子任务委托、消息传递和中断，使用 SQLite 持久化。

## 子包

插件包含两个子包，均默认启用。

### Agent 协作工具（collaboration）

提供六个协作接口，基于 SQLite Event Store schema v3 持久化：

- `spawn_agent`：创建稳定逻辑 Agent，并非阻塞地排队首个 Run。可选 `request_id` 是持久化调用幂等键：响应丢失后用相同参数和同一键重试会返回原 Agent；同键不同参数会被拒绝。可选 `parent_agent_id` 将子 Run 绑定到父 Agent 的当前活动 Run。
- `list_agents`：按 `created_at + agent_id` 稳定游标分页查询 Agent、当前 Run、消息状态和限长结果；默认 `limit=20`、最大 100，返回 `total`、`has_more` 和 `next_cursor`。指定 `agent_ids_json` 时忽略分页并完整返回指定集合。
- `send_message`：向活动 Agent 的持久邮箱排队消息，在下一模型检查点注入。宿主接受计为 delivered，模型返回控制 ACK 后才计为 acknowledged；未确认消息最多自动重投一次。可选 `request_id` 防止重试重复排队。
- `followup_task`：仅在终态 Agent 上复用同一 `agent_id` 创建后续 Run，run_seq 加一，并注入历史运行摘要。可选 `request_id` 防止重复创建。
- `wait_agent`：等待一个或多个 Agent 进入终态；单次阻塞 1000–12000 毫秒，默认 12000，超时不取消任务，可重复调用。
- `interrupt_agent`：请求中断指定 Agent 的当前 Run，并仅向该 Run 的活动后代传播取消。排队任务立即停止，运行中任务进入协作式取消。可选 `request_id` 防止重试重复产生取消事件。

**控制协议**：子 Agent 应在响应末尾输出 `COLLABORATION_CONTROL` v1 JSON 信封，通过 `progress`、`finish` 或 `fail` 报告状态，并在 `message_acks` 中确认已处理的父消息。插件只接受最后一个完整合法信封，并强制校验 `execution_epoch`。错误 epoch 的结果作为迟到结果隔离；损坏或缺失信封记录为 `invalid` 或 `not_received` 并进入兼容模式。如果宿主只返回工具轨迹且独立安全摘要成功，运行时生成同 epoch 的 repaired `finish`，公开为 `control_status: "repaired"`。

**持久化**：Agent、Run 和消息状态保存为应用私有 SQLite Event Store schema v3 的关系型投影。事件和检查点按持久水位只追加，`run_attempts` 以 `(run, attempt)` 保留独立 epoch 审计投影，每次提交递增 revision。正常运行热路径只在一个事务内更新受影响 Agent、当前 Run 和消息。SQLite 不可用时响应报告 `persistence: "memory"`。`request_ledger` 使用 `operation + request_id` 作为键，将四个写接口的业务投影和幂等结果放在同一事务中提交。`side_effects` 账本使用 `execution_epoch + checkpoint_step + operation + request_hash` 形成幂等键：`committed` 返回原结果，`prepared` 和 `unknown` 阻止自动重复。

**调度约束**：全局最多 6 个活动 Run；单根任务树最多占 3 个活动槽；不同根任务树之间轮转，并对等待任务进行有限优先级老化（high/normal/low）。

**父子树**：`parent_agent_id` 精确绑定到父 Agent 的当前 Run，持久化 `parent_run_id`、父 epoch、根 Agent、`root_run_id` 和树深度；父 Run 终态后不能继续挂接子 Run。每个 follow-up Run 成为新的根任务树。`interrupt_agent` 向当前 Run 的所有活动后代传播取消：queued 后代立即 interrupted，running 后代进入 cancelling；终态后代及其他根树不受影响。`list_agents` 与 `wait_agent` 返回根树、直接子节点、总 Run、活动 Run 和状态计数。

**恢复**：runtime 重启时，尚未启动的 queued Run 保持原 attempt 重新入队；活动只读 Run 仅在旧 epoch 没有 `prepared/unknown` 副作用时使用同一 Run ID 创建 attempt+1 并重放上下文。活动写 Run 或存在未决副作用的 Run 不自动重试，标记 `orphaned`；恢复中的 `cancelling` Run 收敛为 `interrupted`。

### 工具生命周期探针与文件网关（tool_lifecycle_probe）

提供七个诊断与管理工具：

- `probe_get_status`：返回探针注册状态、hook 可用性、缓冲条目数和聚合计数。
- `probe_get_log`：返回最近记录的工具生命周期事件，可按工具名、发送者或拦截阶段过滤。
- `probe_clear_log`：清空工具生命周期探针的事件缓冲。
- `probe_get_prompt_compose_log`：返回 prompt compose hook 事件日志，含 chatId 和工具列表信息，用于验证身份识别和网关行为。
- `gateway_register`：为指定 Agent 注册文件网关策略，在 prompt compose 阶段裁剪其可用工具列表。支持 `allowed_tools_json`（白名单）和 `denied_tools_json`（黑名单）两种参数。
- `gateway_unregister`：移除指定 Agent 的文件网关策略。
- `gateway_status`：返回文件网关当前注册的 Agent 策略和默认禁止工具列表。

**探针机制**：探针注册工具生命周期 hook 和 prompt compose hook，记录工具调用事件和 prompt compose 事件用于验证。探针从不写文件、从不阻断调用。所有状态仅存于 main 上下文内存，重启后丢失。

**文件网关**：通过 prompt compose hook 按 Agent 身份裁剪可用工具列表。Agent 任务调用使用 `collaboration_agent:<agent_id>` 作为 chatId，summary 调用使用 `collaboration_summary:` 前缀，用户聊天保持 UUID，使网关能在不依赖宿主未暴露字段的情况下区分调用者类型。默认情况下 Agent 拥有全部可用工具（`DEFAULT_DENIED_TOOLS` 为空）；调用者可通过 `gateway_register` 为特定 Agent 设置白名单或黑名单。summary 调用的工具全部剥离，用户聊天不受影响。网关仅在提示词阶段过滤工具列表，不拦截已发出的调用。

## 任务格式

`spawn_agent` 示例：

```
task: "实现用户接口并运行相关测试"
context: "保持现有响应格式"
target_paths_json: "[\"/workspace/server\"]"
read_only: false
priority: "normal"
max_tool_calls: 16
```

`spawn_agent` 的 `target_paths_json` 示例：

```json
["/workspace/server"]
```

多个 Agent 并行开发不同模块示例——分别调用 `spawn_agent`：

```
# Agent 1: 后端模块
task: "实现用户接口并运行相关测试"
target_paths_json: "[\"/workspace/server\"]"
read_only: false

# Agent 2: 前端模块
task: "接入用户接口并验证构建"
target_paths_json: "[\"/workspace/client\"]"
read_only: false

# Agent 3: 代码审查
task: "审查现有实现并列出高风险问题"
target_paths_json: "[\"/workspace\"]"
read_only: true
```

写任务应声明 `target_paths_json`。未声明路径的写任务会在系统提示中降级为只读。路径冲突检查发生在调度阶段；对路径所有权的执行约束由子 Agent 系统提示承担。

## 子 Agent 系统提示

子 Agent 的系统提示包含以下关键引导：

- 默认拥有全部可用工具，可使用任何工具完成任务
- 调用工具前仔细阅读工具定义中的完整描述和参数 schema
- 常用文件工具（create_file、edit_file、write_file、read_file、delete_file、make_directory）的必需参数速查表
- 工具调用因参数错误失败时，阅读错误消息并立即用正确参数重试
- 创建或编辑文件后读回验证结果
- 不得调用 collaboration 工具
- 不得停止、重启、强停或杀死 Operit 宿主进程
- 响应末尾输出 `COLLABORATION_CONTROL` 信封报告状态

## 使用流程

1. 将此目录按 ToolPkg 方式导入 Operit。
2. 启用 `Agent 协作工具` 子包；需要诊断或工具过滤时启用 `工具生命周期探针与文件网关`。
3. 在主会话中调用 `spawn_agent` 分派任务，使用 `send_message` 在下一检查点补充要求。
4. 使用 `list_agents` 或 `wait_agent` 获取状态与结果。
5. Agent 进入终态后可调用 `followup_task` 续接；需要停止时调用 `interrupt_agent`。
6. 需要限制特定 Agent 的工具范围时，调用 `gateway_register` 注册策略。

## 运行时边界

- `collaboration` 接口使用应用私有 SQLite Event Store schema v3。首次打开旧快照数据库时无损迁移至关系表；首次打开 schema v2 时原子增加 `run_attempts` 并建立现有 attempt 投影。旧 `collaboration_snapshot` 不删除，迁移失败不清库。
- 所有协作响应报告 `persistence_model: "event_store"`、`persistence_schema`、`persistence_revision` 和可选 `persistence_migration`。
- 协作结果在保存和公开返回前抑制内部提示回显；需要独立摘要时最多同时运行 2 个摘要调用，摘要失败或超时返回安全的确定性回退结果。
- `EnhancedAIService.sendMessage` 是宿主管理的完整工具循环。插件无法强制做到"一次模型响应至多一个工具"，消息只能在该宿主调用结束后的下一检查点注入；消息 ACK 只能证明模型输出了确认标记，不能绝对证明其理解或遵循更新。
- 云模型是否真正并发受模型供应商限流和设备资源约束；本地模型并发也可能增加内存占用。
- 插件拒绝活动写 Agent 的已声明重叠路径，但不能阻止 Agent 通过宿主原生文件工具或 Shell 访问未声明路径。
- `interrupt_agent` 会释放对应 AI service；是否立即停止底层网络请求取决于模型供应商和宿主。旧 epoch 的迟到结果不会推进新 Run。
- ToolPkg 和子 Agent 不得停止、重启、强停、杀死或清除 Operit 宿主进程/数据。

## 验证

```bash
node --check src/main.js
node --check src/packages/collaboration.js
node --check src/packages/tool_lifecycle_probe.js
node --check src/collaboration/manager.js
node --check src/collaboration/engine.js
node --test test/*.test.js
```

## 许可证

本项目采用 [GPL-3.0](LICENSE) 许可证。