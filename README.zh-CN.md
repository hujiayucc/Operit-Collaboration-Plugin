<div align="center">

# 多 Agent 协作调度器

为 Operit 提供后台多 Agent 协作调度能力

[项目仓库](https://github.com/hujiayucc/Operit-Collaboration-Plugin)

---

**[English](README.md) | 简体中文**

</div>

为当前主会话提供后台多 Agent 协作调度能力的 ToolPkg 插件，面向分析、开发、审查、测试和后台跟踪。提供父子任务委托、消息传递、等待、续作、中断、原生控制台，以及生命周期诊断和 prompt compose 阶段工具过滤。优先使用 SQLite Event Store；不可用时回退内存并在响应中标明。工具网关只是工具可见性过滤，不是操作系统权限沙箱，也不拦截已发出的调用。

## 子包

插件包含两个子包，均默认启用。v1.0.1 另外注册原生 Compose DSL“多 Agent 控制台”，用于查看状态、任务树和安全地执行协作操作。

## 可视化控制台（v1.0.1）

工具箱中的“多 Agent 控制台”通过 `ToolPkg.ipc.call(..., { targetRuntime: "main" })` 直接复用 main runtime 的协作管理器：

- 查看状态统计、分页列表、Agent 详情、结果、最近事件和精确任务树；结构化 JSON 结果显示为字段卡片，Markdown 文本结果默认显示三行预览，点击后展开原生标题、段落、列表、引用、分隔线和代码块排版。
- 创建只读 Agent；创建可写 Agent 时必须同时声明 `read_only: false` 和非空绝对目标路径，并经过确认页。
- 向活动 Agent 发送消息；界面明确区分 queued、delivered 和 acknowledged。
- 对活动 Agent 执行单次等待，不使用永久轮询。
- 对终态 Agent 创建后续 Run，可选择继承权限、强制只读或重新指定可写路径；继承写权限必须再次确认。
- 中断当前 Run 前显示影响范围，并说明活动后代传播和迟到结果隔离行为。
- 在首页全局运行设置中配置最大并发 Agent 数、单根任务树并发上限、工具调用提示预算、AI 调用重试次数，以及是否将当前对话上下文传给新 Run。全局并发范围为 1–16，单根任务树并发范围为 1–8 且不高于全局并发数，工具调用提示预算范围为 1–64，AI 调用重试范围为 0–12；默认值分别为 6、3、16 和 5。AI 重试仅覆盖网络、限流、超时和服务临时异常，使用 1/2/4/8/16 秒封顶的指数退避与抖动；余额不足、认证、参数、上下文超限和策略拒绝直接结束。降低任一并发设置不会中断正在运行的 Agent，只限制后续启动。对话上下文支持关闭、开启和自动；自动模式由调用 `spawn_agent`/`followup_task` 的 AI 通过 `include_conversation_context` 判断，控制台直接创建 Agent 时在自动模式下保守地不传递。仅复制最近的用户/助手轮次，不传系统提示或工具轨迹；快照最多保留 40 轮、32000 个字符。
- 在 Agent 详情中显示检查点数、控制状态与来源，以及 queued、delivered、acknowledged 消息计数；`action_gate_repair` 分别显示为“动作门修复”与 `Action-gate repair`。
- 仅允许删除终态 Agent；“清理历史”只删除不属于活动任务树的终态 Agent。两类操作都会永久删除对应 Run、消息、事件和本地账本记录，执行前显示不可撤销确认页。
- UI 固定文案和内部枚举支持中文与英文，按运行环境语言选择；Agent 名称、任务内容、工具名、路径和 ID 等实际数据保持原值。

控制台不使用 WebView、不通过 AI 工具调用绕行、不直接访问 SQLite，也不使用 `setInterval`。UI 注册不受支持或加载失败时，核心协作工具仍可正常注册和使用。

### Agent 协作工具（collaboration）

提供六个协作接口。Agent、Run、消息和检查点优先持久化到 SQLite Event Store schema v3；SQLite 不可用时回退到内存，并在响应中标明 `persistence: "memory"`：

- `spawn_agent`：创建稳定逻辑 Agent，并非阻塞地排队首个 Run；成功返回只表示已创建和排队，不表示子任务完成。`task` 应明确目标、范围、首个动作、剩余步骤、完成判据和验证要求。可选 `request_id` 是作用于 `spawn_agent` 的持久化调用幂等键，最多 200 字符：响应丢失后用相同参数和同一键重试会返回原 Agent；同键不同参数会被拒绝。可选 `parent_agent_id` 将子 Run 绑定到父 Agent 的当前活动 Run。
- `list_agents`：按 `created_at + agent_id` 升序和不透明游标分页查询 Agent、当前 Run、消息状态和限长结果；默认 `limit=20`、最大 100，返回 `total`、`has_more` 和 `next_cursor`。指定 `agent_ids_json` 时忽略分页并返回当前存在的匹配项，未知 ID 被忽略。
- `send_message`：向活动 Agent 的持久邮箱排队消息，成功只表示 `queued_for_next_checkpoint`。消息在下一模型检查点注入；delivered 表示已呈现给模型，模型返回控制 ACK 后才计为 acknowledged；未确认消息最多自动重投一次。可选 `request_id` 防止重试重复排队。
- `followup_task`：仅在终态 Agent 上复用同一 `agent_id` 创建后续 Run，run_seq 加一，并使用新的 execution epoch 和根 Run。历史摘要会注入，未确认消息会重新排队；成功只表示新 Run 已排队。省略写路径会继承旧权限，空数组会清空并自动只读。
- `wait_agent`：等待**所有**指定 Agent 进入终态；ID 数组必须非空。单次阻塞 1000–12000 毫秒，默认 12000；`timed_out=true` 不是任务失败，不取消任务，可继续等待或查询。
- `interrupt_agent`：请求中断当前 Run，并仅向该 Run 的活动后代传播取消。排队任务立即停止，运行中任务可能先进入 `cancelling`；成功返回不代表底层调用已停止，需继续查询终态。迟到结果按 execution epoch 隔离。

**控制协议**：子 Agent 应在响应末尾输出 `COLLABORATION_CONTROL` v1 JSON 信封，通过 `progress`、`finish` 或 `fail` 报告状态。`message_acks` 只包含实际处理并纳入结果的父消息 ID；不得编造 ID，也不得确认仅观察到但未处理的消息，没有可确认消息时使用空数组。插件只接受最后一个完整合法信封，并强制校验 `execution_epoch`。错误 epoch 的结果作为迟到结果隔离；损坏或缺失信封记录为 `invalid` 或 `not_received` 并进入兼容模式。若某个工具检查点既没有最终文本，也没有有效控制信封，运行时只会生成同 epoch 的 repaired `progress`，随后进入隐藏全部工具的收尾检查点，要求 Agent 根据已提交的检查点报告明确返回 `finish`、`progress` 或 `fail`；紧接该收尾检查点会获得一次性的完整原始工具结果交接，用于完成长文本原样输出等任务。该交接不执行字符截断，只存在于当前运行时内存，不写入 Run、检查点、事件、SQLite 或公开投影，收尾请求结束后立即清除。安全摘要不能证明工具成功或任务完成。工具检查点增加累计修复数但不消耗收尾失败预算；只有连续 3 个无工具收尾检查点仍无有效控制信封时，Run 才标记为 `failed`。有效 `progress` 会重新开放工具并在下一次工具检查点后获得新的收尾预算，只有有效 `finish` 或没有未完成工具后续的普通最终响应才能完成 Run。

**持久化**：Agent、Run 和消息状态保存为应用私有 SQLite Event Store schema v3 的关系型投影。事件和检查点按持久水位只追加，`run_attempts` 以 `(run, attempt)` 保留独立 epoch 审计投影，每次提交递增 revision。每个模型步骤还保存非敏感分类诊断：工具名称、字符计数、最终文本/控制信封判断、摘要状态和是否需要自动续作；不保存原始模型响应、工具参数或工具结果正文。正常运行热路径只在一个事务内更新受影响 Agent、当前 Run 和消息。SQLite 不可用时响应报告 `persistence: "memory"`。`request_ledger` 使用 `operation + request_id` 作为键，将四个写接口的业务投影和幂等结果放在同一事务中提交。存储层还提供以 `execution_epoch + checkpoint_step + operation + request_hash` 为键的 `side_effects` 账本 API，并在恢复时阻止带有 `prepared` 或 `unknown` 记录的 Run 自动重试；当前宿主管理的普通工具调用尚未自动接入该账本，因此它不构成对所有工具副作用的完整幂等保障。

**模型调用重试**：每个检查点的宿主 AI 请求在瞬时失败时自动重试；全局 `max_model_retries` 范围为 0–12，默认 5，表示首次请求之外的重试次数。重试覆盖网络/流中断、流网络空闲超时、HTTP 408/409/425/429/5xx 和服务临时不可用，采用 1 秒起步、16 秒封顶、带 20% 抖动的指数退避，并优先使用可解析的 `Retry-After`。流网络空闲超时仅度量首个响应块或相邻响应块的等待时间；持续输出不受总生成时长限制。余额不足、认证/权限、参数、上下文超限和策略拒绝不重试。每次请求使用独立 service key；重试不增加 action checkpoint 数。若失败前工具可能已执行，下一次模型请求先进入只读核验门，确认目标状态后再继续，避免盲目重复副作用。中断会取消当前 service 和退避等待。

**调度约束**：全局活动 Run 上限可配置为 1–16，默认 6；单根任务树活动槽可配置为 1–8，默认 3，且不得高于全局上限。降低设置不会中断已经运行的 Agent，只限制后续启动；不同根任务树之间轮转，并对等待任务进行有限优先级老化（high/normal/low）。

**父子树**：`parent_agent_id` 精确绑定到父 Agent 的当前 Run，持久化 `parent_run_id`、父 epoch、根 Agent、`root_run_id` 和树深度；父 Run 终态后不能继续挂接子 Run。任务树最大深度为 8，每个父 Run 最多有 12 个直接子 Run。每个 follow-up Run 成为新的根任务树。`interrupt_agent` 向当前 Run 的所有活动后代传播取消：queued 后代立即 interrupted，running 后代进入 cancelling；终态后代及其他根树不受影响。`list_agents` 与 `wait_agent` 返回根树、直接子节点、总 Run、活动 Run 和状态计数。

**恢复**：runtime 重启时，尚未启动的 queued Run 保持原 attempt 重新入队；活动只读 Run 仅在旧 epoch 没有 `prepared/unknown` 副作用时使用同一 Run ID 创建 attempt+1 并重放上下文。活动写 Run 或存在未决副作用的 Run 不自动重试，标记 `orphaned`；恢复中的 `cancelling` Run 收敛为 `interrupted`。

### 工具生命周期探针与 Agent 工具网关（tool_lifecycle_probe）

提供七个诊断与管理工具：

- `probe_get_status`：返回生命周期 hook 的宿主能力、注册状态和错误，以及最多 500 条的事件缓冲上限、当前条目数、丢弃数和进程累计聚合计数。`registration_state` 区分 `registered`、`active_without_local_registration` 与 `not_registered`。`attribution_capability` 区分 `no_events_observed`、`host_identity_fields_observed`、`host_identity_fields_missing` 与 `runtime_agent_callbacks_observed`。`host_lifecycle_events` 和 `host_identity_bearing_events` 描述宿主 hook，`runtime_attributed_events` 统计协作运行时明确绑定的 Agent 工具调用。只有事件实际归因到 Agent 或 summary 后，`attribution_available` 才为 `true`；孤立的 `invocation_id` 不构成归因。插件不会根据工具名、时间邻近或最近会话推测归因。
- `probe_get_log`：按时间升序返回当前内存缓冲中的最近生命周期事件，并区分本次缓冲匹配数 `matched` 与进程累计 `total_events`。每条事件记录 `chat_id`、`proxy_sender_name`、`invocation_id` 和 `identity_bearing`，不保存完整工具参数值或工具结果。
- `probe_clear_log`：清空工具生命周期和 prompt compose 两类当前内存缓冲，返回总数及分项数量；这会丢弃现有诊断记录，但不重置累计 `total_events`、聚合计数或 hook 状态。
- `probe_get_prompt_compose_log`：从最多 100 条的内存缓冲中返回最近 50 条 prompt compose hook 事件，包含 chatId、身份、输入工具名/字段名摘要、网关动作和过滤后工具数量；不返回完整系统提示、工具参数值或工具结果。
- `gateway_register`：为指定 Agent 注册或替换内存工具网关策略，在 prompt compose 阶段按大小写敏感的精确工具名裁剪可见工具，不支持通配符；未知名会保存但不会匹配。Agent/summary 上下文不能调用；非空白名单优先，宿主缺少可用工具列表时关闭式返回空列表，空白名单不启用白名单模式，非法 JSON 返回结构化错误。
- `gateway_unregister`：移除指定 Agent 的自定义内存策略；策略不存在时仍成功。移除后只恢复默认可见性，collaboration、probe 和 gateway 工具的固定隐藏规则仍生效。
- `gateway_status`：返回内存网关名称、`default_denied_tools`、`fixed_hidden_tools`、`execution_guard` 和各 Agent 排序后的白名单/黑名单。`default_denied_tools` 是可配置默认拒绝集合；`fixed_hidden_tools` 列出同时受 prompt-compose 过滤和 `caller_chat_id` IPC 执行守卫保护的插件工具。

**探针机制**：探针注册工具生命周期 hook 和 prompt compose hook，只记录工具名称、身份、字段名及提示词组装摘要用于诊断。探针从不写文件、从不阻断调用；`probe_clear_log` 同时清理两类内存缓冲。所有状态仅存于 main 上下文内存，重启后丢失；异常使用宿主兼容传输信封，先检查 `transport_success` 和 `operation_success`，再从 `result.error` 读取机器可读错误。

**Agent 工具网关**：通过 prompt compose hook 按本协作运行时能够识别的 Agent 身份裁剪可用工具列表。Agent 任务调用使用 `collaboration_agent:<agent_id>` 作为 chatId，summary 调用使用 `collaboration_summary:` 前缀，finalization 调用使用 `collaboration_finalize:` 前缀，用户聊天保持 UUID。上述上下文始终看不到本插件的 collaboration、tool_lifecycle_probe 和 gateway 工具；每个公开插件工具包装器还会把宿主注入的调用会话 ID 转发到 IPC 执行守卫，因此动态激活包也不会让这些上下文执行固定隐藏工具。默认情况下 Agent 获得全部其他宿主工具（`DEFAULT_DENIED_TOOLS` 为空）；非空白名单优先，宿主缺少 `availableTools` 时关闭式返回空列表。summary 和 finalization 调用的工具全部剥离，用户聊天不受影响。该网关不为其他宿主工具提供操作系统级隔离。

## 任务格式

`spawn_agent` 示例：

```text
task: "实现用户接口并运行相关测试"
context: "保持现有响应格式"
include_conversation_context: true  # 仅在全局模式为自动时，由当前 AI 决定
workspace_path: "/workspace"
target_paths_json: "[\"/workspace/server\"]"
read_only: false
priority: "normal"
timeout_ms: 900000
```

`timeout_ms` 是宿主模型流的网络空闲超时，只度量首个响应块或相邻响应块的等待时间；持续输出不受总生成时长限制。该值必须是 `30000`–`3600000` 范围内的整数；`spawn_agent` 省略时默认 `900000`，`followup_task` 省略时继承，越界、小数或非有限值返回 `timeout_invalid`。`max_tool_calls` 是首页全局运行设置，范围为 1–64，并统一应用到所有新 Run；`spawn_agent` 和 `followup_task` 中的同名参数保留用于兼容，但当前不会覆盖全局值。

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

写任务应声明非空 `target_paths_json`，并设置 `read_only: false`。未声明写路径或传入空数组时，即使显式传入 `read_only: false`，运行时也会将 Agent 设为只读。路径冲突检查发生在调度阶段；对路径所有权的执行约束由子 Agent 系统提示承担，不构成操作系统级隔离。

## 系统提示词列表

仓库维护六份可选的宿主系统提示模板：

- `prompts/prompt-full-zh.md`：中文完整版，允许按授权范围修改本地文件。
- `prompts/prompt-full-en.md`：英文完整版，允许按授权范围修改本地文件。
- `prompts/prompt-read-only-zh.md`：中文本地只读模式，可执行本地读取、分析和经授权的远端操作。
- `prompts/prompt-read-only-en.md`：英文本地只读模式，可执行本地读取、分析和经授权的远端操作。
- `prompts/prompt-mini-zh.md`：中文 mini 模式，只保留 Operit Collaboration ToolPkg 的多 Agent 分派、Run/消息生命周期、控制信封、持久化、探针、网关和验证规则。
- `prompts/prompt-mini-en.md`：英文 mini 模式，与中文 mini 版覆盖相同的 ToolPkg 操作边界。

两份 mini 模板已通过子 Agent 创建/修正、全文读回和主流程独立验收：均包含 6 个当前 `collaboration` 工具和 7 个当前 probe/gateway 工具的准确名称，不含旧别名，也不包含角色设定、通用代码/文件/Git 流程、网络/记忆路由或其他与本 ToolPkg 无关的提示内容。

这些模板供宿主配置或人工选用，构建脚本不会把 `prompts/` 目录打进 ToolPkg。安装包包含英文 `README.md` 和中文 `README.zh-CN.md`；子 Agent 的实际运行时提示由宿主提供的 `SystemPromptConfig.SUBTASK_AGENT_PROMPT_TEMPLATE` 与归档内 `src/collaboration/engine.js` 追加的协作约束共同组成，两份 README 和上述模板不会被运行时自动读取或注入。

运行时追加的关键引导包括：

- 默认拥有全部可用工具，可使用任何工具完成任务
- 调用工具前仔细阅读工具定义中的完整描述和参数 schema
- 当前可见工具定义是调用这些工具时唯一权威的名称、参数和行为来源；不依赖硬编码工具参数清单
- 描述当前不可见或固定隐藏的工具、包、API、配置或运行时事实时，只使用任务/context 明示契约或可访问的权威源文件；资料不足时标记为未验证，不得凭记忆补全或宣称已核验
- 文件读回只证明实际落盘内容和持久性，不能证明外部接口名、参数 schema、包契约、配置事实或运行时行为正确
- 显式创建任务声明当前不可见包/API 时，先从权威 `METADATA` 源提交结构化契约证据；在所有声明包完成前，动作门只开放 `sleep`、`list_files`、`read_file`、`read_file_part`、`find_files`、`grep_code` 和 `grep_context`，并阻止创建及其他持久化修改
- 已提交检查点仍有具体精确修改待完成时，动作门才会在下一模型检查点激活并只开放 `edit_file`；`inspect_agent`/`list_agents` 的 execution 投影公开 `current_action_gate`、`action_gate_activation_count` 和 `action_gate_block_count`，最近事件公开 `action_gate_activated`、`action_gate_released`、`action_gate_blocked`，且重复 prompt-compose 轮询不会重复发状态转换事件。
- 动作门只在新的 prompt-compose 阶段收缩下一次宿主模型调用的可见工具。单次宿主调用已经组装的工具列表不会在每个工具执行前重新组合，所以同一次调用内正常完成 `read_file → edit_file → read_file` 不会产生中间门事件。逐工具执行前的强制阻断取决于宿主 lifecycle intercept 能力；插件侧 `action_gate_repair` 在执行结果回到 manager 后修复违规工具集或动作门仍活动时的提前 `finish`/兼容终态请求，并记录审计事件。门只按工具名过滤，参数与目标路径仍由宿主工具契约和声明式路径约束处理。
- `edit_file` 的嵌套或相邻同级宿主结果会形成结构化 `succeeded`、`failed` 或 `unknown` 回执；`succeeded` 释放验证工具，`unknown` 立即停止并要求先核验目标状态，连续 3 次明确 `failed` 提前终止
- 违反已经生效的动作门，或在门仍活动时请求 `finish`/兼容终态，都会生成 `ACTION_GATE_BLOCKED` 和 `action_gate_repair` 进度控制；正常遵循动作门或当前检查点已用成功回执释放门时，`action_gate_repair` 不应出现
- 工具调用因参数错误失败时，阅读错误消息并立即用正确参数重试
- 创建或编辑文件后读回验证结果
- 不得调用 collaboration 工具
- 不得停止、重启、强停或杀死 Operit 宿主进程
- 响应末尾输出 `COLLABORATION_CONTROL` 信封报告状态
- 工具检查点缺少最终正文时，紧接的无工具 finalization 会获得一次性的完整原始工具结果交接，不执行字符截断；该交接只存在于运行时内存，不进入 SQLite、检查点、事件或公开投影

## 使用流程

1. 将项目目录按 ToolPkg 方式导入 Operit，或安装从项目根目录打包生成的 `.toolpkg` 文件。安装同一 `toolpkg_id`、同一版本的新构建前，应先移除旧包，避免宿主继续使用缓存代码。
2. 运行 `node scripts/build-toolpkg.js` 会在项目根目录生成 `<项目目录名>-v<manifest.version>.toolpkg`；脚本只在临时构建目录内压缩包内 JS，不会改写 `src/` 源码。首次运行会通过 `npx terser@5.31.6` 获取固定版本压缩器。目标包已存在时，命令会报告 `skipped: true` 并以成功状态结束，不会覆盖文件；确认替换后使用 `node scripts/build-toolpkg.js --replace`。
3. 两个子包在 manifest 中均默认启用；如手动关闭，至少启用 `Agent 协作工具`，需要诊断或工具过滤时再启用 `工具生命周期探针与 Agent 工具网关`。
4. 在主会话中调用 `spawn_agent` 分派任务，使用 `send_message` 在下一检查点补充要求。
5. 使用 `list_agents` 或 `wait_agent` 获取状态与结果。
6. Agent 进入终态后可调用 `followup_task` 续接；需要停止时调用 `interrupt_agent`。
7. 需要限制特定 Agent 的工具范围时，调用 `gateway_register` 注册策略。

## 运行时边界

- `collaboration` 接口使用应用私有 SQLite Event Store schema v3。首次打开旧快照数据库时无损迁移至关系表；首次打开 schema v2 时原子增加 `run_attempts` 并建立现有 attempt 投影。旧 `collaboration_snapshot` 不删除，迁移失败不清库。
- 六个 `collaboration` 工具的成功结果直接返回结构化对象。失败结果使用宿主兼容的传输信封 `{ transport_success: true, operation_success: false, result: { success: false, error: { code, message, details } } }`，避免宿主把顶层 `success: false` 折叠成无详情的 `Step error`；直接调用包函数时同一失败会解包为内层 `{ success: false, error }`。
- 成功的协作响应报告 `persistence_model: "event_store"`、`persistence_schema`、`persistence_revision` 和可选 `persistence_migration`；参数校验或 IPC 异常位于传输信封的 `result.error`，不保证附带持久化字段。
- 协作结果在保存和公开返回前抑制内部提示回显；需要独立摘要时最多同时运行 2 个摘要调用，摘要使用与所属 Run 相同的流网络空闲超时；摘要失败或超时返回安全的确定性回退结果。
- `EnhancedAIService.sendMessage` 是宿主管理的完整工具循环。插件无法强制做到"一次模型响应至多一个工具"，消息只能在该宿主调用结束后的下一检查点注入；消息 ACK 只能证明模型输出了确认标记，不能绝对证明其理解或遵循更新。
- `registerToolLifecycleHook` 当前只提供观察性事件，没有可将 Agent execution epoch 与宿主工具调用原子绑定的执行前保留和执行后提交回调。因此普通宿主工具调用不能自动接入副作用账本；恢复时仍会保守阻止写能力或存在未决副作用的 Run 自动重试。
- 云模型是否真正并发受模型供应商限流和设备资源约束；本地模型并发也可能增加内存占用。
- 插件拒绝活动写 Agent 的已声明重叠路径，但不能阻止 Agent 通过宿主原生文件工具或 Shell 访问未声明路径。
- `interrupt_agent` 会释放对应 AI service；是否立即停止底层网络请求取决于模型供应商和宿主。旧 epoch 的迟到结果不会推进新 Run。
- 对话上下文快照由 `PromptHistoryHook` 在历史准备阶段采集；工具提示组合 Hook 只负责 summary 工具剥离、Agent 文件网关和诊断记录。
- ToolPkg 和子 Agent 不得停止、重启、强停、杀死或清除 Operit 宿主进程/数据。

## 验证

以下命令在项目根目录执行；`node --test test/*.test.js` 会运行当前完整回归套件，测试总数会随新增用例变化。

```bash
node --check scripts/build-toolpkg.js
node --check src/main.js
node --check src/packages/collaboration.js
node --check src/packages/tool_lifecycle_probe.js
node --check src/ui/collaboration_dashboard/index.ui.js
node --check src/ui/collaboration_dashboard/api.js
node --check src/ui/collaboration_dashboard/model.js
node --check src/ui/collaboration_dashboard/components.js
node --check src/ui/collaboration_dashboard/validation.js
node --check src/ui/collaboration_dashboard/request-id.js
node --check src/ui/collaboration_dashboard/i18n.js
node --check src/collaboration/manager.js
node --check src/collaboration/engine.js
node --test test/*.test.js
```

## 许可证

本项目采用 [GPL-3.0](LICENSE) 许可证。