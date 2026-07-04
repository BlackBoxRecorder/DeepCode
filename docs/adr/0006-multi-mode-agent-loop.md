# ADR-0006: Agent Loop 多模式支持（ReAct / Plan-Execute / Loop Engineering）

当前 Agent 仅实现 ReAct（推理-行动循环）一种模式。为处理更复杂任务，引入 Plan-Execute（先规划后执行）和 Loop Engineering（规划-执行-验证-重试）两种模式。三种模式采用**分层组合**架构：ReAct 是原子执行能力，Plan-Execute = Planner + 多个 ReAct 子任务，Loop Engineering = Plan-Execute + Verifier + 终止逻辑。用户通过 slash command 显式切换模式，LLM 也可在 ReAct 中自动升级到 Plan 模式。

**核心决策：**
- **模式选择**：`/mode <react|plan|loop>` 显式切换 + LLM 自动升级
- **架构**：分层组合，非平级策略模式。`AgentRunner` 接口统一三种 Runner
- **Plan 结构**：基于目标的子任务列表（goal-based），非固定工具参数；每子任务为独立 mini-ReAct session
- **Planner**：独立 LLM 调用，`tool_choice: "none"`，V1 不做重规划
- **Verifier**：独立 LLM 评估，`Verifier` 接口预留扩展点；默认最多 3 次重试 + 无进展检测
- **流式事件**：扩展 `AgentStreamEvent`，增加 `plan_generated`/`task_start`/`verification`/`loop_retry` 等高层事件
- **持久化**：扩展 `TurnRecord` 增加 `plan`/`subTasks`/`verifications` 可选字段，向后兼容
- **Prompt 管理**：角色专属 prompt（Planner/Executor/Verifier），共享 ToolRegistry，靠 `tool_choice` 控制
- **文件布局**：`src/runner/types.ts` + `src/runner/plan-execute.ts` + `src/runner/loop-engineering.ts`
