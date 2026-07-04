# LLM 包验证脚本设计

## 背景

`packages/llm/src/index.ts` 是自研的 DeepSeek API 客户端（基于原生 `fetch`），包含非流式 `chat()` 和流式 `chatStream()` 两个方法。为验证代码行为正确性、覆盖关键场景，在 `packages/llm/scripts/` 中编写验证脚本，调用真实 DeepSeek API 并打印结果到控制台。

## 运行方式

使用 `tsx`（零配置 TypeScript 执行器）直接运行 `.ts` 脚本：

```bash
npx tsx packages/llm/scripts/chat.ts
```

## 目录结构

```
packages/llm/
├── scripts/
│   ├── _common.ts          # 共享：读取 key、创建 client、格式化打印
│   ├── chat.ts             # 非流式对话
│   ├── chat-stream.ts      # 流式对话
│   ├── chat-tools.ts       # 工具调用流程
│   └── chat-thinking.ts    # 思考模式
```

## 各脚本职责

### `_common.ts` — 共享工具

- 从 `process.env.DEEPSEEK_API_KEY` 读取 API key，缺失时报错退出
- 提供 `createClient()` 工厂函数
- 提供格式化打印辅助函数（分区标题、缩进、JSON 美化）

### `chat.ts` — 非流式对话

验证点：
- 简单对话：`content`、`finish_reason`、`usage` 字段完整性
- 多轮对话（带历史消息）
- 错误处理：无效 API key 时的错误信息格式

### `chat-stream.ts` — 流式对话

验证点：
- 每个 chunk 的 `delta.content` 增量输出
- 最终 chunk 的 `accumulated` 聚合字段是否完整
- `[DONE]` 信号处理
- 流式场景下 `reasoning_content` 增量输出

### `chat-tools.ts` — 工具调用

验证点：
- 定义简单工具（如 `get_weather`），验证 LLM 返回 `tool_calls`
- tool_result 回传后 LLM 给出最终回答
- 多轮工具调用流程（如先获取日期再查天气）

### `chat-thinking.ts` — 思考模式

验证点：
- 启用 `thinking: { type: "enabled" }`，验证 `reasoning_content` 存在
- 流式模式下 `reasoning_content` 的增量 + 聚合
- 非流式模式下 `reasoning_content` 的输出

## 输出格式

每个脚本按分区打印结构化信息：

```
══════ 请求 ══════
Model: deepseek-v4-pro
Messages: 2 条
Tools: [get_weather]

══════ 响应 ══════
Content: "北京今天晴天，25°C"
Finish: stop
Usage:  prompt=42  completion=18  total=60

══════ 耗时 ══════
1.23s
```

## 依赖变更

- `packages/llm/package.json`:
  - devDependencies 新增 `tsx`
  - scripts 中为每个脚本添加 `verify:*` 快捷命令
