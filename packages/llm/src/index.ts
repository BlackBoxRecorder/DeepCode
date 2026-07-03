/**
 * Message role types for LLM conversation.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * A single message in the conversation.
 */
export interface Message {
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

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
}

/**
 * DeepSeek request-level configuration (can override defaults per call).
 */
export interface DeepSeekRequestConfig {
  model?: string;
  thinking?: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "low" | "medium" | "high";
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
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    max_tokens: 4096,
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

  async chat(
    messages: Message[],
    tools?: any[],
    options?: DeepSeekRequestConfig,
  ): Promise<LLMResponse> {
    const mergedConfig = { ...this.config.defaults, ...options };

    const body: Record<string, any> = {
      model: mergedConfig.model,
      messages,
      thinking: mergedConfig.thinking,
      reasoning_effort: mergedConfig.reasoning_effort,
      max_tokens: mergedConfig.max_tokens,
      temperature: mergedConfig.temperature,
      top_p: mergedConfig.top_p,
      tool_choice: mergedConfig.tool_choice,
      stream: mergedConfig.stream,
      tools: tools?.length ? tools : null,
    };

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content ?? null,
      tool_calls: message?.tool_calls,
      finish_reason: choice?.finish_reason ?? "stop",
      reasoning_content: message?.reasoning_content,
    };
  }
}
