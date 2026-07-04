/**
 * System message: sets behavior/context for the model.
 */
export interface SystemMessage {
  role: "system";
  content: string;
}

/**
 * User message: input from the user.
 */
export interface UserMessage {
  role: "user";
  content: string;
}

/**
 * Assistant message: response from the model.
 * content can be null when the model makes tool calls.
 * tool_calls present when the model invokes tools.
 */
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

/**
 * Tool message: <input param> result of a tool execution.
 * tool_call_id is required, referencing the original tool call.
 */
export interface ToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

/**
 * A single message in the conversation — discriminated by `role`.
 */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

/**
 * Tool call from LLM response.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * LLM response from the chat completion API.
 */
export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length";
  reasoning_content?: string;
  /** Token usage stats from the API response */
  usage?: TokenUsage;
}

/**
 * Token usage statistics from the API.
 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Cached prompt tokens (DeepSeek) */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** Breakdown of completion tokens (DeepSeek) */
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

/**
 * A single chunk from the streaming chat completion API.
 * The last chunk includes accumulated full response.
 */
export interface LLMStreamChunk {
  /** Incremental content from this chunk */
  delta: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  /** Only present in the last chunk */
  finish_reason?: "stop" | "tool_calls" | "length";
  /** Only present in the last chunk */
  usage?: TokenUsage;
  /** Aggregated full response — only present in the last chunk */
  accumulated?: LLMResponse;
}

/**
 * DeepSeek request-level configuration (can override defaults per call).
 */
export interface DeepSeekRequestConfig {
  model?: string;
  thinking?: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "high" | "max";
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tool_choice?: "none" | "auto" | "required";
  stream?: boolean;
}

/**
 * DeepSeek client configuration.
 */
export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  defaults?: DeepSeekRequestConfig;
}

/**
 * LLM client interface for chat completion with tool support.
 */
export interface LLMClient {
  chat(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
  ): Promise<LLMResponse>;

  chatStream(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
  ): AsyncGenerator<LLMStreamChunk>;
}

/**
 * DeepSeek API client implementation using native fetch.
 */
export class DeepSeekClient implements LLMClient {
  private config: Required<Omit<DeepSeekConfig, "defaults">> & {
    defaults: Required<DeepSeekRequestConfig>;
  };

  private static DEFAULT_BASE_URL = "https://api.deepseek.com";
  private static DEFAULT_REQUEST_CONFIG: Required<DeepSeekRequestConfig> = {
    model: "deepseek-v4-flash",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    max_tokens: 1000 * 64,
    temperature: 1,
    top_p: 1,
    tool_choice: "auto",
    stream: false,
  };

  constructor(config: DeepSeekConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? DeepSeekClient.DEFAULT_BASE_URL,
      defaults: {
        ...DeepSeekClient.DEFAULT_REQUEST_CONFIG,
        ...config.defaults,
      },
    };
  }

  /**
   * Build request body payload for DeepSeek API.
   */
  private _buildRequestBody(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
    forceStream?: boolean,
  ): Record<string, any> {
    const mergedConfig = { ...this.config.defaults, ...options };

    return {
      model: mergedConfig.model,
      messages,
      thinking: mergedConfig.thinking,
      reasoning_effort: mergedConfig.reasoning_effort,
      max_tokens: mergedConfig.max_tokens,
      temperature: mergedConfig.temperature,
      top_p: mergedConfig.top_p,
      tool_choice: mergedConfig.tool_choice,
      stream: forceStream ?? mergedConfig.stream,
      tools: tools?.length ? tools : null,
    };
  }

  async chat(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
  ): Promise<LLMResponse> {
    const body = this._buildRequestBody(messages, tools, options);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `DeepSeek API error (${response.status}): ${errorText}`,
        );
      }

      const data: any = await response.json();
      const choice = data.choices?.[0];
      const message = choice?.message;

      return {
        content: message?.content ?? null,
        tool_calls: message?.tool_calls,
        finish_reason: choice?.finish_reason ?? "stop",
        reasoning_content: message?.reasoning_content,
        usage: data.usage,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async *chatStream(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
  ): AsyncGenerator<LLMStreamChunk> {
    const body = this._buildRequestBody(messages, tools, options, true);

    // Use AbortController instead of AbortSignal.timeout() so we can
    // clear the timer after the stream finishes — otherwise the timeout
    // timer keeps the event loop alive for up to 60s after completion.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `DeepSeek API error (${response.status}): ${errorText}`,
        );
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Aggregated response fields
      let content = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let finishReason: "stop" | "tool_calls" | "length" | undefined;
      let usage: TokenUsage | undefined;

      const CHUNK_READ_TIMEOUT = 30000; // 30s between chunks

      try {
        while (true) {
          // Read with timeout between chunks
          let chunkTimeoutId: ReturnType<typeof setTimeout> | undefined;
          let readResult: Awaited<ReturnType<typeof reader.read>>;
          try {
            readResult = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                chunkTimeoutId = setTimeout(
                  () => reject(new Error("Stream read timeout")),
                  CHUNK_READ_TIMEOUT,
                );
              }),
            ]);
          } finally {
            if (chunkTimeoutId !== undefined) clearTimeout(chunkTimeoutId);
          }

          const { done, value } = readResult;

          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6); // Remove "data: " prefix
            if (data === "[DONE]") {
              // Produce final chunk with accumulated results
              yield {
                delta: {},
                finish_reason: finishReason,
                usage,
                accumulated: {
                  content: content || null,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  finish_reason: finishReason ?? "stop",
                  reasoning_content: reasoningContent || undefined,
                },
              };
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;

              // Accumulate fields
              if (delta?.content) content += delta.content;
              if (delta?.reasoning_content)
                reasoningContent += delta.reasoning_content;
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx: number = tc.index ?? 0;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: "",
                      type: "function",
                      function: { name: "", arguments: "" },
                    };
                  }
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.function?.name)
                    toolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments)
                    toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }

              if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
              }
              if (parsed.usage) {
                usage = {
                  prompt_tokens: parsed.usage.prompt_tokens ?? 0,
                  completion_tokens: parsed.usage.completion_tokens ?? 0,
                  total_tokens: parsed.usage.total_tokens ?? 0,
                  prompt_cache_hit_tokens: parsed.usage.prompt_cache_hit_tokens,
                  prompt_cache_miss_tokens:
                    parsed.usage.prompt_cache_miss_tokens,
                  completion_tokens_details:
                    parsed.usage.completion_tokens_details,
                };
              }

              yield {
                delta: {
                  content: delta?.content,
                  reasoning_content: delta?.reasoning_content,
                  tool_calls: delta?.tool_calls,
                },
                finish_reason: choice?.finish_reason,
              };
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
      } finally {
        // Release the reader lock so the underlying TCP connection can
        // be returned to the pool / closed promptly.
        try {
          reader.cancel();
        } catch {
          // Ignore — reader may already be released
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
