/**
 * ReAct-based Agent implementation.
 *
 * The agent runs a loop:
 * 1. Send user input + conversation history to LLM
 * 2. If LLM returns tool_calls → execute tools, send results back
 * 3. If LLM returns stop → return final response
 * 4. Repeat until max iterations
 */
import type { LLMClient, Message } from "@timetickme/llm";
import {
  DefaultToolRegistry,
  type Tool,
  type ToolRegistry,
  type ToolResult,
} from "@timetickme/tool-interface";

// ============================================================================
// Types
// ============================================================================

/** Configuration for the Agent */
export interface AgentConfig {
  /** LLM client for chat completion */
  llm: LLMClient;
  /** Tools available to the agent */
  tools: Tool[];
  /** System prompt for the conversation */
  systemPrompt?: string;
  /** Maximum ReAct iterations (prevents infinite loops), default: 10 */
  maxIterations?: number;
}

/** Result of an agent run */
export interface AgentResult {
  success: boolean;
  content: string;
  toolCalls: ToolCallLog[];
  iterations: number;
}

/** Log entry for a tool call */
export interface ToolCallLog {
  tool: string;
  params: Record<string, any>;
  result: ToolResult;
}

// ============================================================================
// Agent Implementation
// ============================================================================

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI agent. You have access to tools to help complete tasks. " +
  "Use tools when needed to gather information or perform actions. " +
  "When you have enough information, respond directly to the user.";

export class Agent {
  private llm: LLMClient;
  private registry: ToolRegistry;
  private systemPrompt: string;
  private maxIterations: number;

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = config.maxIterations ?? 10;

    this.registry = new DefaultToolRegistry();
    for (const tool of config.tools) {
      this.registry.register(tool);
    }
  }

  /**
   * Run the agent on a user input.
   */
  async run(userInput: string): Promise<AgentResult> {
    const messages: Message[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userInput },
    ];

    const toolCallsLog: ToolCallLog[] = [];
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      // 1. Call LLM
      const response = await this.llm.chat(
        messages,
        this.registry.getToolsForLLM(),
        { tool_choice: "auto" },
      );

      // 2. If no tool calls, return final result
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          success: true,
          content: response.content ?? "",
          toolCalls: toolCallsLog,
          iterations,
        };
      }

      // 3. Execute tool calls
      const assistantMessage: Message = response.content
        ? {
            role: "assistant",
            content: response.content,
            tool_calls: response.tool_calls,
          }
        : {
            role: "assistant",
            content: "",
            tool_calls: response.tool_calls,
          };
      messages.push(assistantMessage);

      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name;
        const tool = this.registry.getTool(toolName);

        if (!tool) {
          const errorResult: ToolResult = {
            success: false,
            output: "",
            error: `Tool "${toolName}" not found`,
          };
          toolCallsLog.push({
            tool: toolName,
            params: {},
            result: errorResult,
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(errorResult),
          });
          continue;
        }

        // Parse arguments and execute
        let params: Record<string, any> = {};
        try {
          params = JSON.parse(toolCall.function.arguments);
        } catch {
          const parseError: ToolResult = {
            success: false,
            output: "",
            error: "Failed to parse tool arguments",
          };
          toolCallsLog.push({
            tool: toolName,
            params: {},
            result: parseError,
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(parseError),
          });
          continue;
        }

        const result = await tool.execute(params);
        toolCallsLog.push({ tool: toolName, params, result });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Reached max iterations
    return {
      success: false,
      content: "Maximum ReAct iterations reached without a final response.",
      toolCalls: toolCallsLog,
      iterations,
    };
  }
}
