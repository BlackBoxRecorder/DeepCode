# deepCode — 终端 AI Agent 领域术语

deepCode 是一个支持多模式 Agent Loop 的终端 AI Agent，核心能力包括 LLM 驱动的推理-行动循环、MCP 外部工具集成、文件系统与命令执行、技能系统以及会话持久化管理。支持三种 Agent Loop 模式：ReAct（推理-行动）、Plan-Execute（计划-执行）、Loop Engineering（计划-执行-验证-重试）。

## Agent（核心引擎）

**Agent**：
一个运行 ReAct（推理-行动）循环的执行引擎。接收用户消息，循环调用 LLM 获取响应，解析工具调用并执行，直到 LLM 返回最终回答或达到最大迭代次数。

**AgentMode**：
Agent 的 Loop 执行模式。三种模式：`react`（ReAct 推理-行动循环）、`plan-execute`（先规划后执行）、`loop-engineering`（规划-执行-验证-重试）。模式通过 `/mode` 命令显式切换，或由 LLM 在 ReAct 中自动升级到 Plan 模式。
*避免*：Agent type, execution strategy

**AgentRunner**：
统一的多模式执行器接口（`{ mode, run() }`）。ReActRunner 为默认实现，PlanExecuteRunner 内部组合 Planner + 多个 ReAct 子任务，LoopEngineeringRunner 在其上叠加 Verifier 与重试逻辑。Coordinator 持有当前 Runner 引用，模式切换时替换实例。
*避免*：Loop strategy, execution engine

**Plan-Execute（计划-执行模式）**：
先规划后执行的 Agent Loop 模式。Planner（独立 LLM 调用）将用户任务分解为目标驱动的子任务列表，Executor 依次将每个子任务作为独立 ReAct session 执行。V1 不做重规划。
*避免*：Plan-and-execute, P&E

**Loop Engineering（循环工程模式）**：
Plan-Execute + Verifier + 重试的 Agent Loop 模式。在 Plan-Execute 执行完成后，由独立的 Verifier LLM 评估结果是否达标；未达标则重新规划并重试（默认最多 3 次），辅以无进展检测（连续相同结果提前终止）。遵循 PDCA（Plan-Do-Check-Act）循环。
*避免*：Self-healing loop, autonomous loop

**Planner（规划器）**：
Plan-Execute / Loop Engineering 模式中的规划组件。独立的 LLM 调用（`tool_choice: "none"`），接收用户任务，输出目标驱动的子任务列表。使用专属 planner prompt，不访问工具。
*避免*：Task decomposer, plan generator

**Plan（计划）**：
Planner 生成的子任务列表。每个 PlanTask 包含唯一 id、自然语言 goal、执行状态（pending/running/done/failed）和可选的执行结果。V1 为线性列表，预留 dependencies 字段用于未来 DAG 升级。
*避免*：Task list, execution plan

**Verifier（验证器）**：
Loop Engineering 模式中的独立验证组件。接收原始目标、执行结果和执行日志，返回通过/未通过判断及原因。V1 用 LLM 调用实现，接口（`Verifier`）预留程序化验证扩展点。
*避免*：Checker, validator agent

**ReAct Loop**：
LLM 驱动的推理-行动循环：LLM 接收对话历史→返回思考或工具调用→Agent 解析并执行工具→将结果反馈给 LLM→重复直到 LLM 给出最终回答。
*避免*：Tool loop, agent cycle

**AgentConfig**：
Agent 的构造配置，包括 LLM 客户端、可用工具列表、system prompt 以及最大迭代次数（默认 100）。

**AgentResult**：
一次 Agent 执行的结果，包含成功状态、最终回答内容、工具调用日志、实际迭代次数以及该轮所有消息的完整列表。

**AgentStreamEvent**：
Agent 流式执行过程中发出的各类事件，包括：`chunk`（LLM 增量输出块）、`tool_result`（工具执行结果）、`done`（执行完成）。

**ToolCallLog**：
一次工具调用的记录，包括调用的工具名、传入参数和执行结果。

**ConversationCoordinator**：
位于 CLI 与 Agent + SessionManager 之间的协调层，管理会话生命周期（创建、切换、列出）和轮次执行（将用户输入交给 Agent 执行、保存结果）。
*避免*：Agent orchestrator, session manager direct usage

## 对话（Conversation）

**Session（会话）**：
一次从创建到结束的完整聊天会话。每个会话独立存储为两个文件：`.jsonl`（轮次数据）和 `.meta.json`（元数据）。

**SessionManager**：
会话的持久化管理器，负责创建会话、追加轮次、更新标题、列出/加载历史会话。采用 O(1) 增量追加写 JSONL + 轻量元数据文件的双文件方案。

**SessionMeta（会话元数据）**：
单次会话的描述信息，包括唯一 ID、标题（取第一条用户输入的前 50 字符）、创建时间、更新时间、轮次计数。

**Turn（轮次）**：
一次完整的交互回合，即用户输入一条消息到 Agent 完成所有 ReAct 迭代并给出最终响应。
*避免*：Round, iteration, exchange

**TurnRecord**：
持久化到磁盘的一轮记录，包含轮次时间戳、用户输入、该轮产生的所有消息以及可选的 Token 用量统计。

**TurnEvent**：
轮次执行过程中产生的扩展事件集合，包含 Agent 的全部流式事件以及会话相关事件（`session_created`、`save_error`、`agent_error`）。

**Message（消息）**：
对话中的单条消息，按角色（`role`）区分为四种：`system`（系统指令）、`user`（用户输入）、`assistant`（助手回复，可含 `tool_calls`）、`tool`（工具执行结果，必须引用 `tool_call_id`）。

**LLMResponse**：
LLM API 返回的完整响应，包含回复内容（`content`，可为 null）、工具调用列表（`tool_calls`）、结束原因（`finish_reason`：`stop`/`tool_calls`/`length`）、推理内容（`reasoning_content`）以及 Token 用量统计。

**LLMStreamChunk**：
流式 API 每次推送的数据块（`delta`），包含增量内容、增量推理内容或增量工具调用。最后一个块会附带聚合后的完整 `accumulated` 响应。

## 工具系统（Tool System）

**Tool（工具）**：
Agent 可调用的外部功能单元，通过统一的 `{ name, description, parameters: JsonSchema, execute }` 接口定义。工具是 Agent 与环境交互的唯一通道。

**ToolResult（工具结果）**：
工具执行后的返回结构，包含成功/失败状态、文本输出和可选的错误信息。

**ToolRegistry（工具注册器）**：
管理所有已注册工具的容器，支持注册、按名称查找、获取全部工具列表以及格式化为 LLM 可识别的函数定义格式（`LLMFunctionDef`）。

**LLMFunctionDef**：
符合 DeepSeek API 规范的函数定义格式，`type: "function"` + `function: { name, description, parameters }`，用于在 LLM 请求中声明可用工具。

**JsonSchema**：
本项目使用的 JSON Schema 子集，用于定义工具的传入参数结构。兼容 DeepSeek API 和 MCP 协议规范。

**BashTool**：
执行 bash 命令的内置工具，支持超时控制和输出截断。默认提供 `bash` 一个工具。

**FsTools（文件系统工具集）**：
一组操作文件系统的内置工具，包括 `read`（读取文件）、`write`（写入文件）、`edit`（编辑文件）、`ls`（列出目录）、`grep`（搜索内容）、`find`（查找文件）。

## MCP（外部工具集成）

**MCP（Model Context Protocol）**：
一种模型-上下文通信协议标准，deepCode 通过该协议集成外部工具服务。MCP 服务器通过 stdio 或 HTTP/SSE 通信，提供服务端定义的工具集合。

**McpManager**：
MCP 工具集成的总入口，负责加载配置、连接所有已配置的 MCP 服务器、发现工具并适配为项目内部的 Tool 实例。

**McpServerConfig（MCP 服务器配置）**：
单个 MCP 服务器的连接定义。通过 `command` + `args` 定义 stdio 传输，或通过 `url` 定义 HTTP/SSE 传输。兼容 VS Code/Claude Code 的 mcp.json 格式。

**McpTransport（MCP 传输层）**：
MCP 客户端与服务器之间的通信通道抽象，统一提供 `listTools`、`callTool`、`close` 三个方法。有 stdio 和 HTTP/SSE 两种实现。

**ToolAdapter（工具适配器）**：
将 MCP 服务器发现的工具转换为项目 Tool 实例的适配层，核心职责：以 `{server}_{tool}` 格式为工具名前缀、规范化 JSON Schema、将 `callTool` 结果包装为 `ToolResult` 格式。

**ServerStatus（服务器状态）**：
单个 MCP 服务器的连接健康状态，包含服务器名、传输类型、是否连接成功、工具数量和错误信息。

## Skills（技能系统）

**Skill（技能）**：
以 Markdown 文件形式存储的领域专业知识和工作流程指令。Skill 不注册自定义工具，LLM 通过已有的 bash/fs 工具执行技能中描述的操作。

**SkillMeta（技能元数据）**：
Skill 在启动时扫描得到的元信息，包括名称、描述、SKILL.md 路径、来源（用户级/项目级）和是否对 LLM 隐藏（`disableModelInvocation`）。不包含正文内容。

**SkillManager（技能管理器）**：
负责发现、加载和管理技能的模块。启动时扫描 `~/.deepcode/skills/`（用户级）和 `cwd/.deepcode/skills/`（项目级）两目录，解析 YAML frontmatter 提取元数据，按需读取正文。

**SkillSource（技能来源）**：
标识技能来自用户级（`user`，跨项目共享）还是项目级（`project`，仅当前项目）。项目级技能同名覆盖用户级。

**Auto Skill（自动技能）**：
`disableModelInvocation` 为 `false` 的技能，元数据在启动时自动注入 system prompt，LLM 通过 `read` 工具按需加载正文。

**Manual Skill（手动技能）**：
`disableModelInvocation` 为 `true` 的技能，不注入 system prompt，仅通过 `/skill:<name>` 命令显式调用。

## CLI（命令行界面）

**AppLoop**：
REPL（读取-求值-打印循环）主循环，使用 Node.js readline 模块驱动。每行用户输入要么路由给命令处理器（以 `/` 开头的命令），要么交给 Coordinator 执行聊天轮次。

**CommandRouter（命令路由器）**：
解析并分发以 `/` 开头的结构化指令，支持的命令包括：`/help`、`/new`、`/sessions`、`/continue`、`/tools`、`/skills`、`/skill:<name>`、`/mcp`、`/exit`。

**CommandResult（命令结果）**：
命令路由器的执行结果，指引 AppLoop 下一步行为：`handled`（已处理）、`chat`（以生成的文本作为用户输入进入聊天）、`exit`（退出程序）。

**DisplayRenderer（显示渲染器）**：
将 Agent 流式事件渲染到终端的展示层。处理推理内容、文本内容、工具结果的实时输出。支持 stdout/stderr 分离，可替换以实现未来的 TUI。

**Slash Command（斜杠命令）**：
以 `/` 开头的结构化指令，用于执行非对话操作。Agent 交互模式为混合式：斜杠命令 + 自然语言对话并存。
*避免*：System command, special command

## LLM（语言模型）

**LLMClient**：
统一的 LLM 聊天完成接口，提供 `chat`（非流式）和 `chatStream`（流式）两种方法。设计上保持提供商无关，目前由 DeepSeekClient 实现。

**DeepSeekClient**：
DeepSeek API 的原生 fetch 封装，支持思考模式（`thinking`）和工具调用。默认使用 `deepseek-v4-flash` 模型，通过环境变量 `DEEPSEEK_API_KEY` 配置。

**TokenUsage（Token 用量）**：
LLM 请求的 Token 消耗统计，包括 prompt、completion、total 以及 DeepSeek 特有的 prompt 缓存命中/未命中和推理 Token 明细。

**ToolCall（工具调用）**：
LLM 返回的工具调用指令，包含唯一 ID、函数名和 JSON 格式的参数。LLM 可一次返回多个工具调用，Agent 顺序执行。
*避免*：Function call, action

**Finish Reason（结束原因）**：
LLM 响应的终止原因标识。`stop` 表示正常结束，`tool_calls` 表示需要执行工具调用，`length` 表示达到 Token 上限被截断。

**Reasoning Content（推理内容）**：
DeepSeek 模型在思考模式下产生的推理过程文本（`reasoning_content`），先于最终答案输出。在 CLI 渲染中独立显示为 `[Thinking...]` 区域。
