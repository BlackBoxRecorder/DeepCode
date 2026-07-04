/**
 * AgentRunner — unified interface for all Agent Loop modes.
 *
 * ReAct, Plan-Execute, and Loop Engineering runners all implement this
 * interface so the Coordinator can treat them interchangeably.
 */
import type { Message } from "../llm/index.js";
import type { AgentResult } from "../index.js";
import type { RunnerStreamEvent } from "./events.js";

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
 *
 * @typeParam TEvents - The event type this specific runner yields.
 *   Defaults to RunnerStreamEvent (the combined union) for consumers
 *   that don't care about the specific mode.
 */
export interface AgentRunner<TEvents = RunnerStreamEvent> {
  /** The Agent Loop mode this runner implements. */
  readonly mode: AgentMode;

  /** Current conversation messages. */
  readonly conversationMessages: readonly Message[];

  /** System prompt used for constructing message lists. */
  readonly systemPromptText: string;

  /** Replace the current conversation message list (e.g. on session switch). */
  setConversationMessages(messages: Message[]): void;

  /**
   * Execute the agent loop with a pre-built message list.
   * Yields streaming events for real-time display.
   */
  run(inputMessages: Message[]): AsyncGenerator<TEvents, AgentResult>;
}
