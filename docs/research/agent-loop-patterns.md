# Agent Loop 模式研究：ReAct / Plan-and-Execution / Loop Engineering

> 研究时间：2026-07-04
> 研究范围：三种主流 Agent Loop 模式的概念、原理、流程及优缺点对比

---

## 1. ReAct（Reasoning + Acting）

### 1.1 概念与原理

**ReAct**（Reasoning + Acting）由 Shunyu Yao 等人于 2022 年在论文 *"ReAct: Synergizing Reasoning and Acting in Language Models"* 中提出 [\[arXiv:2210.03629\]](https://arxiv.org/abs/2210.03629)。该框架的核心思想是：**让 LLM 以交错方式同时生成推理轨迹（Reasoning Traces）和任务特定动作（Task-Specific Actions）**，从而在推理和行动之间产生协同效应。

推理轨迹帮助模型引导、追踪和更新行动计划，并处理异常；而行动则允许模型与外部知识库或环境进行交互，获取额外信息来支持推理。二者相互促进：推理帮助定位下一步检索什么，行动获取的信息反过来纠正推理中的幻觉。

ReAct 是**首个引入 Chain-of-Thought（CoT）推理与工具调用交替进行的框架**，它结合了 CoT 的推理能力和工具调用的外部信息获取能力。[\[promptingguide.ai\]](https://www.promptingguide.ai/techniques/react)

### 1.2 流程

ReAct 的核心是一个 **Thought → Action → Observation** 循环：

```
Thought: 我需要搜索 X，找到 Y，然后计算 Z
Action: Search[X]
Observation: 搜索结果...
Thought: 搜索没有提到 Y，我需要查询 Y
Action: Lookup[Y]
Observation: 查询结果...
Thought: 现在我有了所有信息，可以给出最终答案
Action: Finish[最终答案]
```

具体来说：

1. **Thought（思考）**：LLM 分析当前状态和目标，进行推理，决定下一步应该做什么
2. **Action（行动）**：执行具体的操作，如搜索、查询数据库、调用 API 等
3. **Observation（观察）**：获取行动的结果，作为下一轮思考的输入
4. **循环**：重复上述步骤，直到任务完成

不同任务类型会调整 thought 的使用密度：对于推理密集型任务（如问答），每一步都需要 thought；对于决策密集型任务（如 ALFWorld 游戏），thought 则稀疏使用。[\[Yao et al., 2022\]](https://arxiv.org/abs/2210.03629)

### 1.3 优点

1. **高度灵活**：每步工具调用后都可以根据观察结果调整策略，无预设计划的约束
2. **错误恢复能力强**：可以在出现错误或异常信息时动态调整推理方向，重新规划
3. **可解释性好**：Thought 轨迹提供了人类可读的推理过程，增强了透明度和可信度
4. **简单直接**：实现相对简单，不需要复杂的状态管理
5. **处理异常**：能够处理预料之外的情况，因为每一步都可以重新思考

### 1.4 缺点

1. **每次工具调用都需要一次 LLM 调用**：如果一个任务需要 5 次工具调用，就需要 5 次 LLM 推理，延迟高、成本高 [\[LangChain Blog, 2024\]](https://www.langchain.com/blog/planning-agents)
2. **一次只规划一步**：LLM 只在当前步骤上推理，缺乏对全局的显式规划，可能导致次优路径
3. **容易陷入局部最优**：由于没有全局视图，可能在局部路径上走偏
4. **检索质量敏感**：如果搜索/工具返回的信息质量差，可能导致推理链断裂，且较难恢复 [\[Yao et al., 2022\]](https://arxiv.org/abs/2210.03629)
5. **结构性约束限制灵活性**：ReAct 的 thought-action-observation 结构虽然是其优势，但在某些推理任务上（如 HotpotQA）反而限制了推理的灵活性，因为将推理过程绑定到了工具调用的框架中

---

## 2. Plan-and-Execution（计划与执行）

### 2.1 概念与原理

**Plan-and-Execute** 模式采用"先规划，后执行"的策略，将任务处理明确分为两个阶段 [\[LangChain Blog, 2024\]](https://www.langchain.com/blog/planning-agents)：

1. **规划阶段（Planning Phase）**：LLM 分析任务目标，分解为一系列子任务，生成完整的执行计划
2. **执行阶段（Execution Phase）**：按照计划逐步执行子任务，处理执行结果，必要时重新规划

其设计动机来自 ReAct 的两个痛点：每次工具调用需要一次 LLM 调用，以及 LLM 一次只规划一个子问题。通过显式的规划步骤，可以将"大局思考"集中在一个阶段完成，后续执行只需轻量级 LLM 或直接按计划调用工具 [\[agentic-patterns.com\]](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)。

Plan-and-Execute 参考了 Wang 等人的 *Plan-and-Solve Prompting* 论文以及 Yohei Nakajima 的 BabyAGI 项目。

### 2.2 流程

经典的 Plan-and-Execute 流程包含：

```
用户任务 → Planner（生成多步计划） → Executor（逐步执行） → 判断是否需要重规划 → 返回结果
```

1. **Planner**：接收用户查询，生成一个多步骤计划（如：步骤1: 搜索 X，步骤2: 分析数据，步骤3: 汇总报告）
2. **Executor(s)**：接收计划中的每个步骤，调用工具完成该步骤
3. **Re-planning**：执行完成后，判断是否需要根据执行结果重新规划，如果需要则生成补充计划
4. **返回最终结果**

该模式的关键特征是**规划与执行分离**：规划阶段在见到任何不可信的工具输出之前就确定了行动序列，这增强了控制流的完整性和安全性。[\[agentic-patterns.com\]](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)

### 2.3 主要变体

#### 2.3.1 ReWOO（Reasoning WithOut Observations）

ReWOO 在规划器中引入**变量赋值**机制，允许后续步骤引用前面步骤的输出（如 `#E2` 语法），使得任务列表可以在不重新规划的情况下执行。最后通过 Solver 将所有输出整合为最终答案。[\[Xu et al.\]](https://www.langchain.com/blog/planning-agents)

#### 2.3.2 LLMCompiler

LLMCompiler 将任务以 **DAG（有向无环图）** 形式流式输出。包含三个核心组件 [\[Kim et al.\]](https://www.langchain.com/blog/planning-agents)：

- **Planner**：流式输出 DAG 任务（包含工具、参数和依赖关系）
- **Task Fetching Unit**：一旦任务的依赖满足就立即调度执行，支持并行执行（论文声称 3.6x 加速）
- **Joiner**：根据任务执行结果决定是返回最终答案还是重新规划

### 2.4 优点

1. **更高的任务完成率**：强制 LLM 显式"通盘思考"所有步骤，研究表明任务完成率提升 40-70%，幻觉减少约 60% [\[Parisien et al., 2024\]](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)
2. **成本更低**：大型 LLM（Planner）只需调用一次或少数几次，子任务可使用更小、更便宜的模型执行 [\[LangChain Blog, 2024\]](https://www.langchain.com/blog/planning-agents)
3. **执行更快**：子任务可以并行执行（尤其是 LLMCompiler），不需要每步都等一次 LLM 推理
4. **更好的全局优化**：规划者能看到整个任务的全局视图，而非只关注当前步骤
5. **控制流安全性更高**：规划在执行前确定，不受不可信工具输出的影响，防止工具输出劫持控制流 [\[agentic-patterns.com\]](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)
6. **任务分解清晰**：复杂任务被分解为更小、更专注的子任务

### 2.5 缺点

1. **初始规划可能不够准确**：如果初始计划有误，而执行阶段才发现，可能需要大量回退和重新规划
2. **灵活性不足**：如果执行过程中出现了计划外的信息或异常，不能像 ReAct 那样即时调整
3. **顺序执行瓶颈**：基础的 Plan-and-Execute 仍然是串行执行，每个步骤顺序进行（LLMCompiler 通过 DAG 解决了部分问题）
4. **上下文管理挑战**：需要在整个规划-执行周期中维护计划状态和中间结果
5. **对简单任务过度设计**：对于 1-2 步就能完成的任务，显式规划增加了不必要的开销
6. **输出内容仍可能被污染**：虽然控制流不能被劫持，但工具返回的内容（如邮件正文）仍可能包含恶意内容 [\[agentic-patterns.com\]](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)

---

## 3. Loop Engineering（循环工程 / 计划-执行-检查-调整）

### 3.1 概念与原理

**Loop Engineering**（循环工程）是 2026 年 6 月兴起的一个概念，由 Peter Steinberger（OpenClaw 作者）和 Boris Cherny（Claude Code 工程师）几乎同时提出。其核心理念从"手动写 prompt"转向**"设计驱动 Agent 的循环系统"**。[\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)

Loop Engineering 不是一种单一的算法或架构，而是一种**设计方法论**，关注的是 Agent 运行的迭代循环本身的质量。其核心短语为：**discover → plan → execute → verify → repeat**（发现 → 计划 → 执行 → 验证 → 重复）[\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)

这实际上是**PDCA 循环（Plan-Do-Check-Act，计划-执行-检查-调整）** 在 AI Agent 领域的工程化应用。它不是简单地让 Agent 行动并观察结果，而是系统性地设计了整个反馈循环的每个环节。

Loop Engineering 是继 Prompt Engineering（2022-2024）→ Context Engineering（2025）→ Harness Engineering（2026 初）之后的第四层演进。每一层都不是替代前一层，而是将其作为组件包含在内。[\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)

**区分 Loop 和 Chain**：Chain 是线性固定的（A → B → C），一次运行；Loop 是循环可调整的——根据观察结果决定重复、分支或改变路线。当步骤无法预先完全确定时（这在编程、研究、调试中几乎是常态），就需要 Loop。[\[HappyCapy, 2026\]](https://happycapy.ai/blog/loop-engineering-ai-agents)

### 3.2 流程

一个设计良好的 Loop 通常包含五个核心组成部分 [\[MindStudio, 2026\]](https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents) [\[HappyCapy, 2026\]](https://happycapy.ai/blog/loop-engineering-ai-agents)：

```
┌─────────────────────────────────────────────────────┐
│                  Loop Engineering                    │
│                                                     │
│  Trigger → Goal → Execute → Verify → Decide         │
│     ↑                                    │          │
│     └────────── Repeat ──────────────────┘          │
│                                                     │
│  子循环：Reason → Act → Observe → (repeat)          │
└─────────────────────────────────────────────────────┘
```

1. **Goal Definition（目标定义）**：明确、可验证的终止条件。例如"所有测试通过且无 lint 错误"，而不应是模糊的"把代码改好"。目标必须是可以被程序化检查的。
2. **Tools / Actions（工具/行动）**：Agent 可以执行的操作集，如执行代码、读写文件、搜索文档、运行测试等。
3. **Observation（观察）**：每次行动的反馈，最好是结构化反馈而非原始输出。例如预处理错误信息，包含相关代码上下文、错误类型分类等。
4. **Termination Logic（终止逻辑）**：多种退出条件——成功条件（目标达成）、失败条件（达到最大迭代数、无进展检测）、降级路径（转交人工处理）。
5. **Error Handling（错误处理）**：区分可恢复错误（语法错误、缺失导入）和硬阻塞（凭证缺失），根据错误类型调整策略，避免重复相同的失败尝试。

**关键设计原则**：验证（Verification）应该由**不同于执行 Agent 的组件**来完成，以确保客观性。验证器的职责是判断目标是否真正达成，而非 Agent 是否"尽力了"。[\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)

### 3.3 常见 Loop 模式

Loop Engineering 包含了多种具体模式 [\[HappyCapy, 2026\]](https://happycapy.ai/blog/loop-engineering-ai-agents) [\[MindStudio, 2026\]](https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents)：

| 模式 | 工作方式 | 适用场景 |
|------|---------|---------|
| **Retry Loop** | 重复执行直到成功或达到上限 | 不稳定的步骤、瞬时故障 |
| **Plan-Execute-Verify** | 先规划，执行，再验证结果是否达标 | 有可检查结果的多步骤任务 |
| **Explore-Narrow** | 广泛探索多个路径，然后收敛到最佳路径 | 研究和探索类任务 |
| **Reflexion（自我批判）** | 行动后自我评估输出质量并重试 | 质量敏感型工作 |
| **Human-in-the-Loop** | 关键节点暂停等待人工审批 | 高风险或不可逆操作 |
| **Multi-Agent Orchestration** | 编排器在多个子 Agent 中运行子循环 | 超出单个 Agent 能力范围的大型任务 |

### 3.4 优点

1. **自主运行能力**：设计良好的 Loop 可以在无人干预下长时间自主运行（如夜间运行发现失败测试、尝试修复、重新验证、留下 PR）
2. **系统级的可靠性**：从顶层设计解决了循环的终止、错误处理和验证问题，而非依赖模型自身的判断
3. **可度量性**：提供了明确的评估指标——目标成功率、平均迭代次数、无进展率、Token 成本、恢复率 [\[HappyCapy, 2026\]](https://happycapy.ai/blog/loop-engineering-ai-agents)
4. **与人-在-环结合**：支持在关键节点暂停、等待人工判断的模式
5. **更高杠杆**：设计一个好的循环系统，其价值远超写好单个 prompt，可实现规模化的自动化
6. **检验与执行分离**：验证由独立组件完成，避免了 Agent 自我评估的偏差
7. **灵活的组合性**：可以根据任务需求组合不同的 Loop 模式

### 3.5 缺点

1. **成本更高**：Loop 天然比单次 prompt 更昂贵，每个迭代都消耗 token。18 个月前可能经济上不划算，随着模型降价才变得可行 [\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)
2. **系统设计复杂度高**：需要设计触发机制、目标定义、验证逻辑、终止条件、状态管理等整套系统，对工程能力要求高
3. **验证设计困难**：许多任务的"完成"标准难以程序化验证（如架构决策、代码美观度），限制了 Loop 的适用范围
4. **快速制造技术债务**：无人值守的 Loop 如果出错，会以高速、大规模地制造错误。没有严格验证的 Loop 是"有漂亮 PR 的失控成本事件" [\[LinearLoop, 2026\]](https://www.linearloop.io/blog/what-is-loop-engineering)
5. **不适合开放式决策**：当"完成"的定义本质上需要人类判断时（如架构选择），Loop 效果不佳
6. **可能过度工程化**：对于简单的单步骤任务，设计完整 Loop 是过度设计

---

## 4. 三种模式对比总结

| 维度 | ReAct | Plan-and-Execution | Loop Engineering |
|------|-------|-------------------|-----------------|
| **核心思想** | 推理与行动交替进行 | 先规划后执行，规划与执行分离 | 系统性地设计循环的每个环节 |
| **规划方式** | 每步即时决策，无全局规划 | 一次生成完整计划，然后执行 | 计划+执行+验证的组合，计划可被验证结果修正 |
| **LLM 调用频率** | 每步工具调用需要一次 LLM 推理 | 规划 1 次 + 执行 N 次（可用轻量模型） | 取决于具体模式，可在规划-验证节点集中调用 |
| **灵活性** | ★★★★★ 极高，每步可即时调整 | ★★★ 中等，计划是预定的但支持重规划 | ★★★★ 高，验证失败后重试并调整 |
| **全局优化** | ★★ 较低，只看当前步 | ★★★★ 高，通盘考虑后规划 | ★★★★★ 最高，系统级全局优化 |
| **执行速度** | 较慢（串行 LLM 调用） | 较快（可并行，用轻量模型） | 取决于模式，通常比单次 prompt 慢但可优化 |
| **成本** | 中等（每次工具调用 = 1 次 LLM） | 较低（大模型少调，小模型多调） | 较高（迭代消耗，但性价比随模型降价提升） |
| **实现复杂度** | ★★ 低，简单直观 | ★★★ 中等 | ★★★★★ 高，需要完整的系统工程 |
| **可解释性** | 高（完整的 thought 轨迹） | 中（计划可见，执行细节可能不透明） | 高（循环日志完整，可追踪） |
| **错误恢复** | 即时、灵活但可能无效 | 需要触发重规划，响应较慢 | 系统级错误处理，区分可恢复/不可恢复 |
| **控制流安全性** | 低（工具输出可影响后续行动） | 高（行动序列在见到工具输出前定好） | 高（验证器独立，终止条件明确） |
| **适用场景** | 简单到中等复杂度、需要灵活性的任务 | 中等到复杂、可分解的多步任务 | 大规模、长时间自主运行、需高质量保障的任务 |
| **代表实现** | LangChain ReAct Agent | LangGraph Plan-and-Execute, ReWOO, LLMCompiler | Claude Code, OpenAI Codex Agent, 各类 2026 年编码 Agent |

### 选型建议

- **简单任务 + 需要快速响应** → 选 **ReAct**：问题明确、步骤少、成本敏感的场景
- **复杂多步任务 + 可明确分解** → 选 **Plan-and-Execution**：数据处理、报告生成、多步工作流
- **大规模自主运行 + 需要高质量保障** → 选 **Loop Engineering**：持续集成修复、自动化代码审查、长时间自主编码任务

在实践中，这三种模式并非互斥：**Loop Engineering 本身包含 ReAct 作为子循环**（每次工具调用仍可能用 Reason → Act → Observe），也包含 Plan-and-Execute 作为其组合模式之一（Plan-Execute-Verify）。Loop Engineering 是更高层次的系统设计方法论，而 ReAct 和 Plan-and-Execution 是具体可选的执行策略。

---

## 参考来源

1. Yao, S., Zhao, J., Yu, D., et al. (2022). *ReAct: Synergizing Reasoning and Acting in Language Models*. arXiv:2210.03629. [https://arxiv.org/abs/2210.03629](https://arxiv.org/abs/2210.03629)
2. Prompt Engineering Guide. *ReAct Prompting*. [https://www.promptingguide.ai/techniques/react](https://www.promptingguide.ai/techniques/react)
3. LangChain Team (2024). *Plan-and-Execute Agents*. [https://www.langchain.com/blog/planning-agents](https://www.langchain.com/blog/planning-agents)
4. Agentic Patterns. *Plan-Then-Execute Pattern*. [https://agentic-patterns.com/patterns/plan-then-execute-pattern/](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)
5. HappyCapy (2026). *Loop Engineering for AI Agents: The 2026 Guide*. [https://happycapy.ai/blog/loop-engineering-ai-agents](https://happycapy.ai/blog/loop-engineering-ai-agents)
6. MindStudio (2026). *What Is Loop Engineering? The New Meta for AI Coding Agents*. [https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents](https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents)
7. LinearLoop (2026). *What Is Loop Engineering? The AI Development Shift in 2026*. [https://www.linearloop.io/blog/what-is-loop-engineering](https://www.linearloop.io/blog/what-is-loop-engineering)
8. Li, J. (2024). *ReAct vs Plan-and-Execute: A Practical Comparison of LLM Agent Patterns*. DEV Community. [https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9](https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9)
9. Beurer-Kellner et al. (2025), §3.1 (2) Plan-Then-Execute.
10. Parisien et al. (2024), *Deliberation Before Action: Language Models with Tool Use*.
