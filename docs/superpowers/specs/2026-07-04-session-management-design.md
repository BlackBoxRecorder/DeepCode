# Agent 会话管理设计

## 概述

为 deepCode agent 增加会话管理功能：支持历史会话持久化、会话列表查看、选择某次会话继续聊天。会话历史保存到 `~/.deepcode/sessions` 目录下，使用 JSONL 格式，每次会话一个文件。

## 架构

```
CLI (cli.ts)
├── 命令处理: /new, /sessions, /continue <id>
├── SessionManager: create/load/append/list
│
└── Agent (index.ts) ← 保持无状态
    ├── run(userInput) — 便利方法，拼 system+user → 委托 runWithMessages()
    └── runWithMessages(messages) — 接受完整 Message[]，执行 ReAct 循环

~/.deepcode/sessions/
├── a1b2c3d4-20260704T103000.jsonl
├── e5f6g7h8-20260704T150000.jsonl
└── ...
```

**核心原则：** Agent 不感知持久化。新增 SessionManager 模块负责 JSONL 读写，CLI 协调两者。

## JSONL 文件格式

### 文件名

`{8位随机hex}-{ISO日期时间}.jsonl`，例如 `a1b2c3d4-20260704T103000.jsonl`。

### 首行 — 会话元数据 (type: "meta")

```json
{"type":"meta","id":"a1b2c3d4","title":"帮我写一个快排","createdAt":"2026-07-04T10:30:00.000Z","updatedAt":"2026-07-04T10:35:00.000Z"}
```

### 后续行 — 每轮对话记录 (type: "turn")

每轮用户输入 + agent 完整响应（含中间 tool calls）为一条记录：

```json
{
  "type": "turn",
  "timestamp": "2026-07-04T10:30:05.000Z",
  "userInput": "帮我写一个快排",
  "messages": [
    {"role":"user","content":"帮我写一个快排"},
    {"role":"assistant","content":null,"tool_calls":[...]},
    {"role":"tool","tool_call_id":"call_1","content":"..."},
    {"role":"assistant","content":"好的，这是快排实现..."}
  ],
  "usage": {"prompt_tokens":500,"completion_tokens":300,"total_tokens":800}
}
```

### 恢复会话

`loadMessages(sessionId)` 遍历 JSONL 文件，提取所有 `type === "turn"` 的行的 `messages` 数组，按序平铺成完整的 `Message[]`，前面拼上 system message 即可喂给 LLM。

### 保存时机

**按轮次实时追加**：每次 agent 完成一轮 ReAct 循环后，立即将本轮所有 messages 追加写入 JSONL 文件。意外退出不丢数据。

## SessionManager API

文件：`packages/agent/src/session-manager.ts`

```typescript
interface SessionMeta {
  id: string;
  title: string;        // 首条用户输入截取前 50 字
  createdAt: string;    // ISO 8601
  updatedAt: string;    // 每轮追加更新
}

interface TurnRecord {
  type: "turn";
  timestamp: string;
  userInput: string;
  messages: Message[];  // 本轮完整 messages（含 tool calls）
  usage?: TokenUsage;
}

class SessionManager {
  constructor(sessionsDir?: string);  // 默认 ~/.deepcode/sessions

  createSession(firstUserInput: string): Promise<SessionMeta>;
  appendTurn(sessionId: string, record: TurnRecord): Promise<void>;
  updateTitle(sessionId: string, title: string): Promise<void>;

  listSessions(): Promise<SessionMeta[]>;          // 按 updatedAt 倒序
  loadMessages(sessionId: string): Promise<Message[]>;
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
}
```

- `createSession`: 自动创建目录、生成文件名、写入 meta 行
- `listSessions`: 只读每文件首行 meta，不加载全文。用 fs.readdir + 读首行实现
- `loadMessages`: 逐行解析 JSONL，过滤 `type === "turn"`，拼接 messages
- `appendTurn`/`updateTitle`: 使用 `fs.appendFileSync` 追加，meta 行的 updatedAt 字段通过读首行 → 修改 → 覆盖写入更新（简单可靠，无需文件锁）

## Agent 改动

文件：`packages/agent/src/index.ts`

当前 `run()` 方法签名不变，内部改为委托给新增的 `runWithMessages()`：

```typescript
/** 接受完整消息列表，执行 ReAct 循环 */
async *runWithMessages(messages: Message[]): AsyncGenerator<AgentStreamEvent, AgentResult> {
  const toolCallsLog: ToolCallLog[] = [];
  let iterations = 0;
  // ... 原有 ReAct 循环逻辑（不变）
}

/** 便利方法：拼 system + user，委托 runWithMessages */
async *run(userInput: string): AsyncGenerator<AgentStreamEvent, AgentResult> {
  const messages: Message[] = [
    { role: "system", content: this.systemPrompt },
    { role: "user", content: userInput },
  ];
  yield* this.runWithMessages(messages);
}
```

改动量：Agent 主体逻辑不变，仅从 `run()` 提取到 `runWithMessages()`。`run()` 变为 5 行的包装方法。类型签名不变，对现有调用方无影响。

## CLI 改动

文件：`packages/agent/src/cli.ts`

### 新增命令

| 命令 | 行为 |
|------|------|
| `/new` | 结束当前会话，创建新会话 |
| `/sessions` | 列出所有历史会话（id、标题、时间、轮数） |
| `/continue <id>` | 切换到指定会话，恢复上下文继续聊天 |

现有 `/reset` 保留但内部等价于 `/new`。`/help` 更新显示新命令。

### 会话状态管理

CLI 维护两个状态变量：

```typescript
let currentSessionId: string | null = null;
let currentMessages: Message[] = [];  // 当前会话的消息历史
```

### handleChat 流程

1. 如果 `currentSessionId === null`，首次发消息时自动 `sessionManager.createSession(input)`
2. 组装本轮需要发给 LLM 的消息：`currentMessages + [{ role: "user", content: input }]`
3. 调用 `agent.runWithMessages(combinedMessages)`
4. 流式渲染过程中同时收集本轮产生的所有 messages（含 tool calls）
5. 本轮结束后，调用 `sessionManager.appendTurn(sessionId, turnRecord)`
6. 新产生的 assistant/tool messages 追加到 `currentMessages`

### 恢复会话流程 (`/continue <id>`)

1. 如果当前会话有未保存内容，先 `appendTurn` 保存最后一轮
2. `sessionManager.loadMessages(id)` 获取历史 messages
3. 将 system message 拼在前面，同时替换 `currentMessages` 和 `currentSessionId`
4. 打印提示信息告知用户已切换到会话 `{id}` - `{title}`

### 会话列表展示 (`/sessions`)

```
会话历史:
  a1b2c3d4  [2026-07-04 10:30]  帮我写一个快排                        (5 轮)
  e5f6g7h8  [2026-07-03 18:00]  分析当前项目结构                        (3 轮)
  x9y0z1w2  [2026-07-03 09:15]  hello world                          (1 轮)
```

## 错误处理

- **目录不存在：** `createSession` 使用 `fs.mkdirSync({ recursive: true })`
- **JSONL 损坏行：** `loadMessages` 跳过无法解析的行，打印 warning
- **文件被外部删除：** `listSessions` 只列出实际存在的文件
- **并发写入：** JSONL 追加写（appendFileSync），每次写入是原子操作，单进程使用无竞争

## 测试策略

1. **SessionManager 单元测试：** 使用临时目录，测试 create/list/load/append 全流程
2. **Agent 单元测试：** 验证 `run()` 和 `runWithMessages()` 行为一致
3. **CLI 集成测试：** 模拟用户输入序列，验证会话创建、切换、恢复

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent/src/session-manager.ts` | 新增 | SessionManager 实现 |
| `packages/agent/src/index.ts` | 修改 | 提取 runWithMessages() |
| `packages/agent/src/cli.ts` | 修改 | 新增命令、会话状态管理 |
