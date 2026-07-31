# 贡献指南

本文档说明如何为多 Agent 协作调度器贡献开发代码，重点覆盖代码职责、运行时契约、验证和打包。面向用户的中文行为说明见 `README.zh-CN.md`，英文说明见 `README.md`。

## 项目结构

- `src/main.ts`：main runtime 注册、IPC 处理、提示历史采集、生命周期诊断和 Agent 工具网关。
- `src/protocol.ts`：IPC 通道名称、参数解析和宿主兼容错误信封。
- `src/collaboration/model.ts`：Agent 与 Run 数据结构、校验、限制、公开投影和终态规则。
- `src/collaboration/manager.ts`：调度、任务树、消息、重试、检查点、动作门、恢复、中断和结果发布。
- `src/collaboration/engine.ts`：宿主 AI 调用、流收集、系统/任务提示、控制解析、摘要和 finalization 交接。
- `src/collaboration/helpers.ts`：解析、脱敏、路径处理、截取和共享结果工具。
- `src/collaboration/store.ts`：SQLite Event Store schema v4、迁移、事务、树上下文、游标、账本和明确的内存回退。
- `src/packages/`：十三个 collaboration/control 工具和七个 probe/gateway 工具的公开 ToolPkg 元数据与包装器。
- `src/ui/collaboration_dashboard/`：原生 Compose DSL 控制台、main runtime IPC 客户端、校验、视图模型、组件和双语文案。
- `prompts/`：六份仅存在于源码中的操作提示模板；参与测试，但不进入安装包。
- `types/runtime.d.ts`：本项目使用的 ToolPkg 宿主 API 接口。
- `test/`：单元、集成、持久化、恢复、元数据、打包、探针和 UI 回归测试。
- `scripts/build-toolpkg.js`：可复现的 ToolPkg 构建器和单行阶段验证器。

## 运行时契约

以下行为属于兼容性敏感契约：

- 公开工具、包导出、源码 `METADATA` 与 `manifest.json` 描述必须一致。
- IPC 名称集中定义在 `src/protocol.ts`；main runtime 处理器、包包装器和控制台调用必须同步。
- Agent、Run、消息、事件、检查点、树上下文、游标、attempt、请求账本和副作用账本必须保持 SQLite Event Store schema v4 语义，除非变更包含经过测试的原子迁移。
- SQLite 异常必须明确报告为 `persistence: "memory"`，不得伪装成正常 SQLite 操作。
- `request_id` 仅在操作相同且规范化参数完全一致时幂等复用；冲突复用必须继续报错。
- execution epoch 隔离恢复 attempt、取消和迟到模型结果；旧 epoch 不得推进当前 Run。
- 父子关系绑定到精确的父 Run；follow-up 会启动新的根 Run。
- 已声明写路径和 `read_only` 只属于调度与提示约束，不是操作系统级隔离。
- `COLLABORATION_CONTROL` v1 信封使用 `progress`、`finish` 或 `fail`；必须校验其 `execution_epoch` 和真实消息确认。
- 只有工具输出的检查点会修复为 `progress`，随后进入无工具 finalization。即时工具结果交接必须完整、仅驻留内存、由该 finalization 流程消费，并排除在持久化和公开投影之外。
- `timeout_ms` 表示流网络空闲时间：首个响应块或相邻响应块等待可以超时，持续生成没有总时长截止线。
- 模型重试只覆盖瞬时故障。若失败前工具可能已经执行，重试必须先核验目标状态。
- 动作门在提示组装阶段过滤工具，不是逐次调用的操作系统级保护，不得将其描述为后者。
- 生命周期诊断只保存名称、身份、字段名和摘要，不保存完整工具参数或结果值。
- summary 和 finalization 会话不暴露工具；collaboration、probe 和 gateway 工具始终对 Child Agent 隐藏。
- 控制台通过 main runtime IPC 工作，不得直接访问 SQLite、使用 WebView 或实现永久轮询。

## 开发方法

1. 修改前先确定行为契约及其所属模块。
2. 在该职责边界内完成最小且完整的改动，避免无关重构和静默回退行为。
3. 添加聚焦的回归测试，使旧行为测试失败，并验证外部可观察的状态、输出或事件。
4. 更新所有受影响且需要同步的接口面。
5. 先运行聚焦测试，再运行完整测试套件。
6. 仅在源码测试通过后构建 ToolPkg，并通过构建脚本验证生成包。

### 同步规则

修改公开 collaboration 或 probe/gateway 工具时，应检查以下接口面：

- `manifest.json`
- `src/packages/` 中的子包 `METADATA` 块和导出包装器
- `src/protocol.ts`
- `src/main.ts` 中的处理器注册
- collaboration manager 对应操作
- 适用时的控制台 API、校验、表单和结果渲染
- 中英文描述
- 元数据、包、协议、UI 和集成测试
- `README.md`、`README.zh-CN.md` 及相关提示模板

修改运行时限制、状态字段、设置、事件或控制行为时，应同步更新 model、manager、持久化投影、公开投影、控制台文案/渲染、文档和测试。

修改控制台固定文案时，应保持 `src/ui/collaboration_dashboard/i18n.ts` 与 `index.ui.ts` 中宿主要求的内联文案一致，并保留独立的 Compose DSL 注册路径；两者都会编译为 `dist/` 下的 `.js` 运行时模块。

修改协作指令或公开工具语义时，应检查 `prompts/` 下全部六份文件。完整版、只读版、mini 版以及中英文版本必须按各自详细程度描述同一 ToolPkg 契约。

新增运行时文件时，应更新 `scripts/build-toolpkg.js` 中的 `RUNTIME_FILES` 及打包测试。除非运行时确实需要，源码提示词、测试和贡献文档应继续排除在安装包之外。

## 测试

测试使用 Node 内置测试运行器和项目内宿主桩。本仓库不包含应用 Gradle 构建流程。

开发时优先运行最小相关测试：

- `test/collaboration-unit.test.js`：规范化、解析、重试分类、动作门、设置和调度器单元逻辑。
- `test/collaboration.test.js`：manager 与 engine 端到端行为、控制、消息、重试、finalization 和任务树。
- `test/store.test.js`：schema v4、迁移、树上下文、游标、事务、只追加数据、请求、副作用和删除。
- `test/recovery.test.js`：重启与 attempt 恢复行为。
- `test/probe.test.js`：生命周期观察、归因、提示组装和网关过滤。
- `test/metadata.test.js`、`test/package.test.js`、`test/build-toolpkg.test.js`：公开元数据、包装器、运行时文件清单、提示契约和打包。
- `test/ui-*.test.js`：控制台 API、文案、校验、渲染、注册和交互行为。
- `test/integration.test.js`：main runtime、子包和宿主服务集成。

先对 TypeScript 源码树执行类型检查和编译，再运行完整测试。首先安装锁定的开发依赖；若文件系统不支持符号链接，请在安装命令后添加 `--no-bin-links`。

```bash
npm install
npm run check:migration
npm run typecheck
npm test
```

完整测试数量会随用例新增而变化；验收标准是零失败，不是固定测试数量。

测试应保持确定性，关闭其创建的 manager 和 store，释放被挂起的异步工作，并同时验证 Run 状态与真实副作用。Agent Run 成功不等于文件变更或持久化投影已经核验。

## 打包

在项目根目录执行：

```bash
npm run build
```

若预期归档已存在，无参数命令会报告跳过并以成功状态结束，不会覆盖文件。完成验证后需要重新构建时：

```bash
npm run build:replace
```

构建器会：

- 使用固定版本 `typescript@5.9.3` 将 TypeScript 源码编译到仓库的 `dist/` 目录；
- 把 `dist/` 中明确列出的已编译运行时文件复制到安装包的 `dist/` 目录，不打包 TypeScript 源文件；
- 固定使用 `terser@5.31.6` 执行两轮保守压缩，关闭 `unsafe` 和顶层转换，并保持函数名、类名、参数名、局部变量名及属性名不混淆；
- 要求每个入包 JavaScript 文件严格为一行非空内容；
- 对暂存 JavaScript 执行语法检查；
- 针对单行化后的暂存目录运行完整测试套件；
- 验证构建过程未修改源码 JavaScript；
- 写入归档并报告大小、条目数和 SHA-256。

不得直接编辑生成的 `.toolpkg`。应修正源码或运行时文件清单，然后重新构建。

## 贡献验收清单

提交开发成果前，应确认：

- 变更属于所修改模块的职责，且未扩大无关行为；
- 适用的公开元数据、导出、IPC、UI、提示词和文档已经同步；
- 持久化和 execution epoch 行为保持明确且有测试覆盖；
- 敏感工具载荷和瞬时 finalization 交接未进入持久化或公开状态；
- 聚焦回归测试和完整测试套件均通过；
- 发生变更的 JavaScript 文件通过语法检查；
- 与打包相关的变更通过单行阶段构建；
- 适用的用户可见行为已在两种 UI 语言中准确记录。