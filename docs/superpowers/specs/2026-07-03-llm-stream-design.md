# LLM 包流式输出设计

## 概述

为 `@timetickme/llm` 的 `DeepSeekClient` 增加流式输出能力，新增 `chatStream()` 方法，返回 `AsyncGenerator<LLMStreamChunk>`。流式调用方可以逐 chunk 消费增量内容，同时在流结束时通过最后一个 chunk 的 `accumulated` 字段获取完整聚合结果。

## 类型定义

### LLMStreamChunk

```typescript
export interface LLMStreamChunk {
  /** 本块的增量内容 */
  delta: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  /** 仅最后一个 chunk 有值 */
  finish_reason?: "stop" | "tool_calls" | "length";
  /** 仅最后一个 chunk 有值 */
  usage?: TokenUsage;
  /** 聚合后的完整响应 — 仅最后一个 chunk 有值 */
  accumulated?: LLMResponse;
}
```

设计决策：
- **原始粒度**：`delta` 映射 DeepSeek SSE chunk 的 `delta` 字段，保留增量精度
- **尾块聚合**：最后一个 chunk 附带 `accumulated`（等价于 `LLMResponse`）+ `finish_reason` + `usage`，调用方可跳过中间 chunk 直接拿终态

### TokenUsage

```typescript
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

### LLMClient 接口扩展

```typescript
export interface LLMClient {
  chat(messages, tools?, options?): Promise<LLMResponse>;
  chatStream(messages, tools?, options?): AsyncGenerator<LLMStreamChunk>;
}
```

向后兼容：`chat()` 保持不变。

## DeepSeekClient 实现

### chatStream() 流程

```
1. 构建请求体（复用 _buildRequestBody），设置 stream: true
2. fetch POST /chat/completions
3. 获取 response.body.getReader()
4. TextDecoder 解码，按行拆分 SSE 事件
5. 解析 data: 前缀的 JSON chunk
6. 遇到 [DONE] 时产出带 accumulated 的尾 chunk，结束迭代
```

### 超时策略

流式场景需要分阶段超时（固定超时对流不适用）：

- **首 chunk 连接超时**：60s（`AbortSignal.timeout(60000)` 覆盖 fetch 阶段）
- **chunk 间读取超时**：每个 chunk 之间 30s 无数据则异常（timer 每收到 chunk 重置）

实现方式：在 `reader.read()` 上包装 Promise.race + 定时器。

### 错误处理

| 场景 | 处理 |
|------|------|
| HTTP 非 2xx | 读取 error body，抛出 `Error` |
| SSE 行 JSON 解析失败 | 静默跳过（不阻塞流） |
| 首 chunk 超时 | 抛出 `Error("Stream connection timeout")` |
| chunk 间超时 | 抛出 `Error("Stream read timeout")` |
| reader 异常 | 异常向上传播到调用方的 for await 循环 |

### 代码复用

请求体构建逻辑从 `chat()` 提取为私有方法 `_buildRequestBody(messages, tools, options)`，`chat()` 和 `chatStream()` 共用。

## 调用方适配（@timetickme/agent CLI）

CLI 的 `handleChat()` 可以从当前的"一次性等待"改为流式展示：

```typescript
// 当前：等全部完成后一次性输出
const result = await agent.run(input);
console.log(result.content);

// 流式：逐块输出，消除"Thinking..."等待感
for await (const chunk of llm.chatStream(messages, tools)) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content);
}
```

注意：`agent.run()` 内部使用 `llm.chat()`（非流式），因为 ReAct 循环需要完整响应来决定是否继续调用工具。流式 `chatStream()` 主要用于 CLI 的即时反馈场景，不改变 Agent 内部逻辑。
