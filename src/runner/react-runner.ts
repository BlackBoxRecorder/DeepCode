/**
 * ReActRunner — wraps the existing ReAct Agent behind the AgentRunner interface.
 *
 * This is the default runner. It delegates directly to Agent.runWithMessages(),
 * forwarding streaming events unchanged. No ReAct behaviour is modified.
 */
import type { Message } from "../llm/index.js";
import type { Agent } from "../index.js";
import type { AgentMode, AgentRunner } from "./types.js";
import type { AgentStreamEvent, AgentResult } from "../index.js";

// ============================================================================
// ReActRunner
// ============================================================================

export class ReActRunner implements AgentRunner {
  readonly mode: AgentMode = "react";

  constructor(private agent: Agent) {}

  get conversationMessages(): readonly Message[] {
    return this.agent.conversationMessages;
  }

  get systemPromptText(): string {
    return this.agent.systemPromptText;
  }

  setConversationMessages(messages: Message[]): void {
    this.agent.setConversationMessages(messages);
  }

  run(
    inputMessages: Message[],
  ): AsyncGenerator<AgentStreamEvent, AgentResult> {
    return this.agent.runWithMessages(inputMessages);
  }
}
