/**
 * JSON Schema property definition, compatible with DeepSeek tool call format.
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: any[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
}

/**
 * JSON Schema definition for tool parameters.
 * Compatible with DeepSeek API tool call specification.
 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Result returned by a tool execution.
 */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Tool interface that all tools must implement.
 */
export interface Tool {
  /** Unique tool name, used for identification */
  name: string;
  /** Tool description, used by LLM to understand tool capabilities */
  description: string;
  /** JSON Schema parameter definition, compatible with DeepSeek format */
  parameters: JsonSchema;
  /** Execute the tool with given parameters */
  execute: (params: Record<string, any>) => Promise<ToolResult>;
}

/**
 * Tool registry for managing and looking up tools.
 */
export interface ToolRegistry {
  /** Register a new tool */
  register(tool: Tool): void;
  /** Get a tool by name */
  getTool(name: string): Tool | undefined;
  /** Get all registered tools */
  getAllTools(): Tool[];
  /** Get tools formatted for LLM (DeepSeek API format) */
  getToolsForLLM(): any[];
}

export { DefaultToolRegistry } from "./registry.js";
