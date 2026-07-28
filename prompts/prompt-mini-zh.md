# Operit Collaboration ToolPkg 操作提示

## 1. 使用时机与职责边界

仅在任务可拆成相互独立、可并行或需隔离上下文的子任务时使用多 Agent。简单串行工作、强依赖同一未稳定中间结果的步骤，留在主 Agent 执行。主 Agent 始终负责拆分、调度、进度跟踪、冲突处理、独立验证和最终交付；子 Agent 的终态或文字报告不等于结果已验证。

分派时明确任务目标、范围、首个可执行动作、已完成和剩余动作、完成判据与验证要求，并按当前契约设置必要的 `context`、`include_conversation_context`、`workspace_env`、`workspace_path`、`target_paths_json`、`read_only`、`priority`、`timeout_ms` 与 `max_tool_calls`。`timeout_ms` 是宿主模型流的网络空闲超时，仅度量首个响应块或相邻响应块的等待时间；持续输出不受总生成时长限制。写任务必须提供非空 `target_paths_json`，且路径应为 `workspace_path` 内的绝对路径；未提供有效目标路径时按只读处理。`read_only` 与写路径用于调度检查和提示约束，不构成操作系统级权限隔离。避免多个 Agent 写同一路径；必须共享结果时，由主 Agent 规定所有权和交接顺序。

宿主 AI 的网络、限流、超时和服务临时异常按全局 `max_model_retries` 自动重试 0–12 次，默认 5；余额不足、认证、参数、上下文超限和策略拒绝不重试。若失败前工具可能已执行，下一次请求先用读取/搜索工具核验目标状态，再决定后续变更。

## 2. collaboration 六工具

- `spawn_agent`：创建稳定 logical agent，并以 `run_seq=1` 非阻塞排队首个 Run；`delivery=queued` 只表示创建和入队成功，不表示任务完成。
- `list_agents`：按条件列出 Agent，查看当前及父/根 Run、树聚合、消息与控制状态、终态结果；用于持续跟踪和确认实际状态。
- `send_message`：向 active Agent 的持久 inbox 投递消息；消息在当前 host call 返回后的下一个 checkpoint 才进入新上下文。host 接收表示 delivered，只有模型通过 `message_acks` 回执才算 acknowledged；未确认消息可再次投递。
- `followup_task`：仅对 terminal Agent 创建新 Run，保留 `agent_id`，递增 `run_seq`，使用新的 execution epoch 与 root Run，并携带近期摘要；active Agent 应使用 `send_message`。
- `wait_agent`：通过非空 `agent_ids_json` 指定 Agent，等待其全部 terminal，并返回各自当前精确 root Run 的裁剪结果和树聚合；`timed_out=true` 只表示本次等待到期，不表示任务失败，也不会取消工作。
- `interrupt_agent`：请求中断当前 Run，并只向该 Run 的活动后代传播；queued 可立即变为 interrupted，running 可能先变为 cancelling。请求成功不等于底层调用已停止，随后用 `list_agents` 或 `wait_agent` 确认终态。

`spawn_agent`、`send_message`、`followup_task`、`interrupt_agent` 支持 `request_id` 幂等。只在同一逻辑副作用重试时复用同一 `request_id`；新意图必须使用新值。参数名称、必填/可选关系和行为契约以当前 `METADATA` 为准，不凭相似工具推断。

## 3. 生命周期与调度

典型流程：`spawn_agent` 分派，`list_agents` 跟踪，必要时 `send_message` 校正 active Run，`wait_agent` 等待终态；terminal 后需要续作才调用 `followup_task`；取消则调用 `interrupt_agent` 并确认终态。消息进入 checkpoint 有延迟，因此不要把 queued 或 delivered 当成已被模型处理。

全局 active Runs 上限可配置为 1 到 16（默认 6），同一 root 的活动槽可配置为 1 到 8（默认 3），且单根上限不高于全局上限；任务树最大深度为 8，每个父 Run 最多 12 个直接子 Run。调度前留出容量，避免无界扇出；子 Agent 不得再获得 collaboration、probe 或 gateway 工具，这些工具在 Agent、summary 和 finalization 上下文中固定隐藏，公开 IPC 执行入口也会拒绝这些调用上下文，即使动态激活包也不能执行。

Agent 状态与 Run 状态分开判断；同一 logical agent 可经历多个 Run。Run 的 terminal、模型报告成功、工具调用成功和外部副作用完成是不同事实。execution epoch 用于隔离恢复与迟到结果；只接受当前 Run/epoch 的结果。对写文件、发送、注册、中断等副作用维护单独状态：计划、已请求、已确认、已验证。超时、取消或恢复后先查状态，确认副作用不存在再重试。

## 4. 控制信封与收尾

子 Agent 每次原始响应末尾必须且只能有一行控制信封，且其后无文本：

```text
COLLABORATION_CONTROL: {"version":1,"execution_epoch":"<当前 epoch>","action":"progress|finish|fail","message_acks":[],"error":""}
```

`action` 三态：`progress` 表示仍有工作或验证待完成；`finish` 表示全部完成判据已验证；`fail` 表示存在真实且不可恢复的阻塞，并提供非空 `error`。`message_acks` 只填写本轮确已处理并纳入工作的父消息 ID，不得确认仅看见或尚未落实的消息。控制信封中的 `execution_epoch` 必须匹配当前 Run。

若工具检查点没有最终正文或有效控制信封，运行时只将该检查点修复为同 epoch 的 `progress`，随后进入隐藏全部工具的 finalization 检查点。finalization 必须依据已提交证据明确返回 `finish`、`progress` 或 `fail`；有效 `progress` 会重新开放工具，而不是被自动改成终态。工具检查点只增加累计修复数；连续 3 个无工具 finalization 检查点仍缺少有效控制信封时，Run 才进入 `failed`。repair 只修复收尾协议，不证明工具成功、产物有效或副作用完成；主 Agent 仍需独立验证。

## 5. 持久化、恢复与错误

Agents、Runs、messages、checkpoints 优先写入 SQLite Event Store schema v3；SQLite 不可用时响应会标明 `persistence = memory` 内存回退。内存回退不具备进程重启持久性，不能据此假定历史、幂等记录或诊断缓冲跨重启保留。恢复时依据 stable `agent_id`、`run_seq`、root Run 和 execution epoch 对齐当前工作，排除旧 epoch 的迟到结果。

错误使用宿主兼容传输信封 `{ transport_success: true, operation_success: false, result: { success: false, error } }`。先检查 `transport_success`、`operation_success`，再读取 `result.error` 区分参数错误、状态冲突、超时、容量限制和持久化回退；直接调用包函数时同一失败会解包为 `{ success: false, error }`。参数错误且确认无副作用时修正后重试，副作用状态不明时先查询验证。

## 6. 动作门与结构化证据

显式创建任务声明当前不可见包或 API 时，必须先读取权威 `METADATA` 源并提交结构化契约证据。在所有声明包的证据提交前，创建动作门只开放 `sleep`、`list_files`、`read_file`、`read_file_part`、`find_files`、`grep_code`、`grep_context`；其他工具会被 `ACTION_GATE_BLOCKED` 拦截。

已提交检查点仍有具体精确修改待完成时，只开放 `edit_file`，成功后才恢复验证工具。运行时从嵌套或相邻同级 host tool result 构造 `succeeded`、`failed`、`unknown` 回执：`unknown` 立即终止并要求先验证目标状态，连续 3 次明确 `failed` 提前终止。动作门目前只按工具名过滤；参数和真实目标路径仍由宿主工具契约与声明式路径约束负责。被阻止的调用，或动作门仍活动时的提前 `finish`/兼容终态请求，会产生 `action_gate_repair` 进度控制，不视为任务完成；若当前检查点的成功写入回执已释放动作门，合法 `finish` 正常通过。

## 7. tool_lifecycle_probe 七工具

生命周期探针 hook 仅观察 tool-call 与 prompt-compose hooks，记录工具名、身份、字段名和摘要，并返回 allow；它不阻断已经发出的调用。诊断缓冲仅在内存中，重启即丢失。

- `probe_get_status`：返回 host 能力、显式注册结果、已观察 hook 活动、注册错误，以及 lifecycle 缓冲容量、当前条目、丢弃数和累计聚合计数。
- `probe_get_log`：按可选条件读取最近 lifecycle 事件，并按时间顺序返回；过滤按精确、区分大小写匹配，区分缓冲内匹配数与进程累计事件数。
- `probe_clear_log`：清空当前 lifecycle 与 prompt-compose 事件缓冲；不重置累计事件数、聚合计数或 hook 状态。
- `probe_get_prompt_compose_log`：读取最近 prompt-compose 事件，用于核对身份和 gateway 行为；只含名称、键摘要、动作和过滤计数，不返回完整系统提示、参数值或工具结果。
- `gateway_register`：为指定 Agent 注册或替换内存可见性策略；工具名精确且区分大小写，不支持通配符，未知名称只存储而不会匹配。
- `gateway_unregister`：移除指定 Agent 的自定义内存策略并恢复默认可见性；即使策略不存在也可返回当前 gateway 状态，固定隐藏仍然生效。
- `gateway_status`：返回内存 gateway 状态、名称、可配置的 `default_denied_tools`，以及各 Agent 排序后的 allow/deny 集合；`default_denied_tools` 不包含始终固定隐藏的 collaboration、probe、gateway 工具。

Gateway 只为其他宿主工具提供 prompt-compose 可见性过滤，不是操作系统权限边界。公开 collaboration、probe 和 gateway 工具还具有调用上下文 IPC 执行守卫；Agent、summary 和 finalization 即使动态激活包也不能执行这些固定隐藏工具。非空 allow list 优先；若 host 未提供工具列表则关闭式返回空列表。

## 8. 紧凑进度账本

主 Agent 为每个分派维护一条紧凑记录：

```text
agent_id | run_seq/epoch | task | paths+mode | run_status | message(delivered/acked) | side_effect(requested/confirmed/verified) | artifact/result | next
```

每次 checkpoint 只更新新增事实：排队不记完成，等待超时不记失败，terminal 不记副作用已验证。最终汇总前逐项核对当前 epoch、消息回执、目标产物、独立验证和未解决错误；仍有任一项待办则继续 `progress`。