# deepCode MCP 支持设计文档

## 概述

在通用工具接口设计基础上，实现 MCP（Model Context Protocol）协议支持。Agent 可接入外部 MCP server，动态发现并使用由 MCP server 托管的外部工具，扩展现有 bash-tool 和 fs-tool 之外的工具生态。

## 核心决策

| 决策项 | 选择 |
|--------|------|
| 传输协议 | stdio + HTTP/SSE |
| 配置方式 | `~/.deepcode/mcp.json`（兼容 Claude Code / VS Code 格式） |
| 生命周期 | 启动时加载（预留热重载扩展点） |
| 实现方式 | `@modelcontextprotocol/sdk` |
| 命名冲突 | server 名前缀：`server-name/tool-name` |
| 连接失败 | 降级启动，跳过失败 server 并告警 |
| 架构方案 | 独立 `@timetickme/mcp` 包 |

## 包结构与依赖关系

### 新增包：`packages/mcp`

```
packages/mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              → 公开 API 导出
│   ├── config.ts             → 解析 ~/.deepcode/mcp.json
│   ├── mcp-manager.ts        → McpManager：连接管理 + 工具发现
│   ├── tool-adapter.ts       → 将 MCP Tool 转为 Tool 实例（加 server 前缀）
│   └── transports/
│       ├── stdio.ts          → spawn 子进程，stdio JSON-RPC
│       └── http.ts           → HTTP/SSE 连接
```

### 依赖关系

```
@timetickme/mcp
├── 依赖 @timetickme/tool-interface     (Tool 接口、ToolRegistry)
├── 依赖 @modelcontextprotocol/sdk      (MCP 客户端、传输层)
└── 不依赖 @timetickme/agent            (保持 agent 对 mcp 的单向依赖)
```

项目整体依赖关系更新：

```
@timetickme/agent  → @timetickme/llm, @timetickme/tool-interface, @timetickme/mcp
@timetickme/mcp    → @timetickme/tool-interface, @modelcontextprotocol/sdk
@timetickme/llm    → 无外部依赖
@timetickme/tool-interface → 无外部依赖
@timetickme/bash-tool → @timetickme/tool-interface
@timetickme/fs-tool   → @timetickme/tool-interface
```

## 配置文件

### 路径

`~/.deepcode/mcp.json`

### Schema

采用与 Claude Code、VS Code 等主流工具兼容的格式：

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "remote-db": {
      "url": "http://localhost:3001/sse",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

### 传输协议推断

- 有 `command` 字段 → **stdio**（spawn 子进程，通过 stdin/stdout 通信）
- 有 `url` 字段 → **HTTP/SSE**（连接远程 SSE 端点）
- 两者都有 → 报错（跳过该 server）
- 两者都无 → 报错（跳过该 server）

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `mcpServers` | object | ✅ | 以 server 名为 key 的 server 配置集合 |
| `<name>.command` | string | stdio 必需 | 启动命令 |
| `<name>.args` | string[] | 可选 | 命令参数 |
| `<name>.env` | object | 可选 | 环境变量（注入子进程） |
| `<name>.url` | string | http 必需 | SSE 端点 URL |
| `<name>.headers` | object | 可选 | HTTP 请求头 |

### 校验规则

- server name 必须为 kebab-case（匹配 `^[a-z][a-z0-9-]*$`）
- server name 不可重复，如有重复仅第一个生效
- 文件不存在时，静默跳过（视为无 MCP 配置）
- JSON 解析失败时，stderr 告警 + 跳过

## 核心模块设计

### McpManager

`McpManager` 负责整个 MCP 生命周期：加载配置、建立连接、发现工具、包装为 `Tool[]`。

```typescript
export class McpManager {
  /**
   * @param configPath 配置文件路径，默认 ~/.deepcode/mcp.json
   */
  constructor(configPath?: string);

  /**
   * 连接所有配置的 server，发现工具，返回 Tool[] 列表。
   * 某个 server 失败不影响其他 server。
   */
  async loadAllTools(): Promise<Tool[]>;

  /**
   * 返回每个 server 的连接状态，供 CLI 显示。
   */
  getServerStatuses(): ServerStatus[];

  /**
   * 断开所有连接，释放资源。预留 reload() 扩展点。
   */
  async dispose(): Promise<void>;
}

interface ServerStatus {
  name: string;
  transport: "stdio" | "http";
  ok: boolean;        // 连接是否成功
  toolCount: number;  // 发现工具数量
  error?: string;     // 失败原因
}
```

### ToolAdapter

将 MCP 协议的 `Tool` 定义转换为项目的 `Tool` 接口。

核心处理逻辑：

1. **工具名加前缀**：`context7` server 的 `resolve-library-id` → `context7/resolve-library-id`，避免不同 server 同名冲突
2. **JSON Schema 转换**：将 MCP 的 `inputSchema` 映射到项目的 `JsonSchema` 格式
3. **execute 封装**：内部调用 MCP 客户端的 `callTool({ name, arguments: params })`，将结果映射为 `ToolResult`

```typescript
function adaptMcpTool(serverName: string, mcpTool: McpToolDef): Tool {
  return {
    name: `${serverName}/${mcpTool.name}`,
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    parameters: convertMcpSchema(mcpTool.inputSchema),
    execute: async (params) => {
      const result = await mcpClient.callTool({
        name: mcpTool.name,
        arguments: params,
      });
      // MCP content 可以是 text/image/resource，统一提取文本
      const text = extractTextContent(result.content);
      return {
        success: !result.isError,
        output: text,
        error: result.isError ? text : undefined,
      };
    },
  };
}
```

## CLI 集成

### 启动流程变更

```typescript
// cli.ts 中
const bashTool = createBashToolAsTool(CWD);
const fsTools = createAllFsTools(CWD);

// 新增：加载 MCP 工具
const mcpManager = new McpManager();
const mcpTools = await mcpManager.loadAllTools();

// 告警失败 server
const serverStatuses = mcpManager.getServerStatuses();
for (const s of serverStatuses) {
  if (!s.ok) console.error(`[MCP] ${s.name}: ${s.error}`);
}

// 启动汇总日志
const builtinCount = 1 + fsTools.length; // bash + all fs tools
console.log(
  `Loaded ${builtinCount} built-in tools + ${mcpTools.length} MCP tool(s) ` +
  `from ${serverStatuses.filter(s => s.ok).length} server(s)`
);

// 合并
const tools: Tool[] = [bashTool, ...fsTools, ...mcpTools];
const agent = new Agent({ llm, tools, systemPrompt });
```

### 新增命令

| 命令 | 说明 |
|------|------|
| `/mcp` | 列出所有 MCP server 状态及工具数 |

输出示例：

```
MCP servers:
  ✓ sequential-thinking  [stdio]  1 tool(s)
  ✓ context7             [stdio]  2 tool(s)
  ✓ playwright           [stdio]  3 tool(s)
  ✗ remote-db            [http]   Connection refused
```

### `/tools` 命令增强

在已有工具列表末尾追加 MCP 工具：

```
Available tools:
  bash: Execute bash commands...
  ...（fs-tool 工具列表）
  context7/resolve-library-id: Resolve a library ID...
  playwright/browser_navigate: Navigate to a URL...
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `mcp.json` 不存在 | 静默跳过，Agent 正常启动 |
| JSON 格式错误 | stderr 告警 + 跳过 |
| `command` 和 `url` 同时存在或都不存在 | 跳过该 server + stderr 告警 |
| server 名不符合 kebab-case | 跳过该 server + stderr 告警 |
| 重复 server 名 | 仅第一个生效，后续跳过 + 告警 |
| stdio 子进程启动超时（30s） | 跳过该 server + stderr 告警 |
| HTTP 连接超时/拒绝 | 跳过该 server + stderr 告警 |
| `tools/list` 返回错误 | 跳过该 server + stderr 告警 |
| 工具调用时 server 返回错误 | 映射为 `ToolResult { success: false }`，由 LLM 处理 |
| 工具调用时 server 已断开 | `ToolResult { success: false, error: "MCP server disconnected" }` |
| 单个工具 inputSchema 转换失败 | 跳过该工具 + stderr 告警，同一 server 的其他工具不受影响 |

关键原则：
- **启动阶段**错误全部降级，不阻塞 Agent 启动
- **运行阶段**错误转为 `ToolResult` 失败返回，让 LLM 决策

## 测试策略

### 单元测试

| 模块 | 测试内容 |
|------|----------|
| `config.ts` | 正常解析、文件不存在、JSON 无效、字段缺失/冲突、重复名 |
| `tool-adapter.ts` | Schema 转换正确性、命名前缀、execute 成功/失败路径 |
| `mcp-manager.ts` | 全部成功、部分失败降级、全部失败不抛异常 |

### 集成测试

- 使用 `@modelcontextprotocol/server-sequential-thinking` 作为真实 stdio server，验证端到端工具发现和调用
- Mock HTTP endpoint 测试 SSE 传输路径

## 实施范围

### 第一阶段（本 spec）

- [ ] `packages/mcp` 包创建
- [ ] 配置文件解析（config.ts）
- [ ] stdio 传输（stdio.ts）
- [ ] HTTP/SSE 传输（http.ts）
- [ ] 工具适配器（tool-adapter.ts）+ JSON Schema 转换
- [ ] McpManager 完整实现（连接、发现、报告状态）
- [ ] CLI 集成（启动加载、`/mcp` 命令、`/tools` 增强）
- [ ] 单元测试 + 集成测试

### 后续阶段（不在本 spec 范围）

- [ ] 运行时热重载（`/mcp reload`）
- [ ] 动态管理命令（`/mcp add`、`/mcp remove`）
- [ ] server 断开自动重连
- [ ] 工具调用超时机制
