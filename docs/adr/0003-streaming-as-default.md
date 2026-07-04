# ADR-0003: 流式输出作为 Agent 默认执行方式

Agent 的所有执行路径默认使用流式输出（`AsyncGenerator`），不保留非流式 `run()` 方法。原因：(1) 终端用户实时看到推理过程和工具调用，显著降低等待焦虑；(2) 单一路径消除"流式/非流式"的代码分支，降低维护成本；(3) 流式事件可以自然扩展（`chunk` → `tool_result` → `done`），ConversationCoordinator 可以在流上叠加会话生命周期事件。代价是 API 签名更复杂（`AsyncGenerator` 而非 `Promise`），但 CLI 已经是唯一的消费者，且 DisplayRenderer 封装了事件消费逻辑。
