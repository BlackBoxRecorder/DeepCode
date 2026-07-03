# deepCode 终端 Agent 设计文档

## 概述

使用 Node.js + TypeScript 实现一个轻量级的终端 AI Agent，类似 Claude Code。采用 pnpm workspace monorepo 管理多个独立包，第一阶段核心目标是实现可用的 ReAct 模式 Agent。

## 项目结构

```
deepcode/
├── package.json                    → 根 workspace 配置
├── pnpm-workspace.yaml             → workspace 定义
├── tsconfig.base.json              → 共享 TypeScript 配置
├── packages/
│   ├── agent/                      → @timetickme/agent（核心 agent + CLI 入口）
│   ├── llm/                        → @timetickme/llm（DeepSeek API 封装）
│   ├── tool-interface/             → @timetickme/tool-interface（工具接口定义）
│   └── tools/
│       ├── bash-tool/              → @timetickme/bash-tool（bash 命令执行）
│       └── fs-tool/                → @timetickme/fs-tool（文件系统操作）
└── packages/tui/                   → @timetickme/tui（终端 UI，第二阶段实现）
```

## 包依赖关系

```
@timetickme/agent  → @timetickme/llm, @timetickme/tool-interface
@timetickme/llm    → 无外部依赖
@timetickme/tool-interface → 无外部依赖
@timetickme/bash-tool → @timetickme/tool-interface
@timetickme/fs-tool   → @timetickme/tool-interface
```

采用接口抽象型架构：agent 只依赖 tool-interface 抽象，不依赖具体工具实现。工具通过实现 tool-interface 接入 agent。

## 技术决策

| 决策项 | 选择 |
|--------|------|
| 运行环境 | Node.js ≥18 |
| 类型系统 | TypeScript 5.x |
| 包管理 | pnpm workspace |
| npm 作用域 | @timetickme |
| LLM 提供商 | 仅 DeepSeek（使用 fetch 封装） |
| 交互模式 | 混合式（/ 开头为命令，其余为对话） |
| Agent 模式 | ReAct（LLM 返回工具调用 + 解析执行） |
| TUI 方式 | 基础 readline（第一阶段） |
| 工具架构 | 接口抽象型（通过 tool-interface 解耦） |

## 包设计详情

### @timetickme/tool-interface

通用工具接口定义包，定义 tool、tool result、tool registry 的接口契约。

```typescript
// 工具接口
interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;           // DeepSeek 兼容的 JSON Schema
  execute(params: Record<string, any>): Promise<ToolResult>;
}

// JSON Schema（兼容 DeepSeek 规范）
interface JsonSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: any[];
    items?: any;
    properties?: Record<string, any>;
  }>;
  required?: string[];
  additionalProperties?: boolean;
}

// 工具执行结果
interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

// 工具注册器
interface ToolRegistry {
  register(tool: Tool): void;
  getTool(name: string): Tool | undefined;
  getAllTools(): Tool[];
  getToolsForLLM(): any[];          // 转换为 DeepSeek tools 格式
}
```

### @timetickme/llm

DeepSeek API 封装，原生 fetch 实现，支持 thinking 模式和工具调用。

```typescript
// 客户端接口
interface LLMClient {
  chat(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig
  ): Promise<LLMResponse>;
}

// 请求配置（覆盖默认值）
interface DeepSeekRequestConfig {
  model?: string;                    // 默认: deepseek-v4-pro
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens?: number;               // 默认: 4096
  temperature?: number;              // 默认: 1
  top_p?: number;
  tool_choice?: 'none' | 'auto' | 'required';
  stream?: boolean;                  // 默认: false
}
```

### @timetickme/agent

核心 Agent，实现 ReAct 循环。

```
ReAct 循环流程：
1. 用户输入 → 构建 messages（含 system prompt + user input）
2. 调用 LLM.chat(messages, tools) → 获取响应
3. 判断 finish_reason：
   - 'stop' → 返回最终结果给用户
   - 'tool_calls' → 解析 tool_calls，执行对应工具
4. 将工具结果作为 tool 角色消息追加到 messages
5. 回到步骤 2，直到 maxIterations 限制
```

关键约束：
- maxIterations 默认 10，防止无限循环
- 工具不存在的错误通过 tool 消息返回给 LLM 让其处理
- 工具执行结果统一通过 JSON.stringify 序列化

### @timetickme/bash-tool

已有独立项目，需适配：
- 修改 scope 为 @timetickme
- 实现 @timetickme/tool-interface 的 Tool 接口
- 参数定义使用 JSON Schema 格式

### @timetickme/fs-tool

已有独立项目，需适配：
- 修改 scope 为 @timetickme
- 实现 @timetickme/tool-interface 的 Tool 接口
- 参数定义使用 JSON Schema 格式

## CLI 入口

第一阶段 CLI 入口放在 agent 包中（后续可独立为 tui 包）。

启动方式：
```bash
DEEPSEEK_API_KEY="your-key" pnpm start
```

内置命令（以 / 开头）：
- `/help` — 显示帮助信息
- `/reset` — 重置对话历史
- `/tools` — 列出可用工具
- `/exit` — 退出

## 第一阶段范围

- [ ] pnpm workspace 配置
- [ ] @timetickme/tool-interface 包创建
- [ ] @timetickme/llm 包创建（含 DeepSeek 客户端）
- [ ] @timetickme/agent 包创建（含 ReAct 循环 + CLI 入口）
- [ ] @timetickme/bash-tool 适配（scope 修改 + tool-interface 实现）
- [ ] @timetickme/fs-tool 适配（scope 修改 + tool-interface 实现）

## 第二阶段范围（后续）

- [ ] @timetickme/tui 包（交互式终端界面）
- [ ] 命令历史与自动补全
- [ ] 更多工具扩展（代码搜索、git 操作等）
