/**
 * AgentRunner — unified interface for all Agent Loop modes.
 *
 * ReAct, Plan-Execute, and Loop Engineering runners all implement this
 * interface so the Coordinator can treat them interchangeably.
 */
import type { Message } from "../llm/index.js";
import type { AgentStreamEvent, AgentResult } from "../index.js";

// ============================================================================
// Types
// ============================================================================

/** Supported Agent Loop modes. */
export type AgentMode = "react" | "plan-execute" | "loop-engineering";

/**
 * Unified runner interface for all Agent Loop modes.
 *
 * Each implementation wraps the underlying Agent (or composes multiple Agents)
 * and presents the same streaming execution contract to the Coordinator.
 */
export interface AgentRunner {
  /** The Agent Loop mode this runner implements. */
  readonly mode: AgentMode;

  /** Current conversation messages (owned by the runner). */
  readonly conversationMessages: readonly Message[];

  /** System prompt used for constructing message lists. */
  readonly systemPromptText: string;

  /** Replace the current conversation message list (e.g. on session switch). */
  setConversationMessages(messages: Message[]): void;

  /**
   * Execute the agent loop with a pre-built message list.
   * Yields streaming events for real-time display.
   */
  run(inputMessages: Message[]): AsyncGenerator<AgentStreamEvent, AgentResult>;
}
