/**
 * ReActRunner — wraps the existing ReAct Agent behind the AgentRunner interface.
 *
 * This is the default runner. On the first LLM response, it checks for an
 * auto-upgrade signal ([UPGRADE_TO_PLAN] marker). When detected, it emits
 * upgrade_requested so the Coordinator can switch to Plan-Execute mode.
 */
import type { Message } from "../llm/index.js";
import type { Agent } from "../index.js";
import { AgentMode, type AgentRunner } from "./types.js";
import type { AgentStreamEvent, AgentResult } from "../index.js";

// ============================================================================
// Upgrade Detection
// ============================================================================

/** Marker the LLM outputs when it detects a complex multi-step task. */
const UPGRADE_MARKER = "[UPGRADE_TO_PLAN]";

/** Instruction appended to the system prompt so the LLM can signal complexity. */
const UPGRADE_SYSTEM_INSTRUCTION = `

IMPORTANT — Complexity Assessment: Before responding, assess whether the user's request is a complex multi-step task that would benefit from structured planning (e.g. building a project, implementing a feature across multiple files, refactoring code, setting up infrastructure). If so, start your response with exactly "${UPGRADE_MARKER}" followed by a brief explanation. Otherwise respond normally — do NOT mention the marker.`;

// ============================================================================
// ReActRunner
// ============================================================================

export class ReActRunner implements AgentRunner {
  readonly mode: AgentMode = AgentMode.react;

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

  async *run(
    inputMessages: Message[],
  ): AsyncGenerator<AgentStreamEvent, AgentResult> {
    // Enhance system message with upgrade detection instruction.
    const enhancedMessages = inputMessages.map((m) => {
      if (m.role === "system") {
        return { ...m, content: m.content + UPGRADE_SYSTEM_INSTRUCTION };
      }
      return m;
    });

    // Extract original user input for the upgrade_requested event.
    const lastUserMsg = [...inputMessages]
      .reverse()
      .find((m) => m.role === "user");
    const userInput = lastUserMsg?.content ?? "";

    // Buffer chunk events from the first LLM call until we see the
    // accumulated response. This lets us decide whether to upgrade before
    // any tool execution or chunk content reaches the user.
    const chunkBuffer: AgentStreamEvent[] = [];
    let checkedUpgrade = false;

    for await (const event of this.agent.runWithMessages(enhancedMessages)) {
      if (!checkedUpgrade) {
        if (event.type === "chunk") {
          chunkBuffer.push(event);

          // Last chunk of the first LLM response carries the full content.
          if (event.chunk.accumulated) {
            checkedUpgrade = true;
            const content = event.chunk.accumulated.content ?? "";

            if (content.includes(UPGRADE_MARKER)) {
              // Upgrade detected: yield buffered chunks with marker stripped,
              // then emit upgrade events and stop.
              for (const e of chunkBuffer) {
                if (e.type === "chunk") {
                  yield this._stripUpgradeMarker(e);
                } else {
                  yield e;
                }
              }

              yield {
                type: "upgrade_requested",
                userInput,
                reason:
                  "Task complexity detected — upgrading to Plan-Execute mode",
              };

              const result: AgentResult = {
                success: true,
                content: content.replace(UPGRADE_MARKER, "").trim(),
                toolCalls: [],
                iterations: 0,
                allMessages: enhancedMessages,
              };
              yield { type: "done", result };
              return result;
            }

            // No upgrade — yield buffered chunks and continue normally.
            for (const e of chunkBuffer) yield e;
            chunkBuffer.length = 0;
          }
        } else {
          // Non-chunk events before first accumulated (shouldn't normally
          // happen, but forward them just in case).
          yield event;
        }
      } else {
        // Past the first LLM response — forward everything.
        yield event;
      }
    }

    // Yield any straggler buffered events (edge case: agent terminated
    // without an accumulated chunk).
    for (const e of chunkBuffer) yield e;

    // Fallback: agent always yields "done" and returns AgentResult, so this
    // line should be unreachable. Included to satisfy TypeScript exhaustiveness.
    const fallbackResult: AgentResult = {
      success: false,
      content: "Unexpected: agent run completed without a final result.",
      toolCalls: [],
      iterations: 0,
      allMessages: enhancedMessages,
    };
    return fallbackResult;
  }

  /** Strip the upgrade marker from a chunk event for clean display. */
  private _stripUpgradeMarker(event: AgentStreamEvent): AgentStreamEvent {
    if (event.type !== "chunk") return event;

    const chunk = { ...event.chunk };
    if (chunk.delta.content) {
      chunk.delta = {
        ...chunk.delta,
        content: chunk.delta.content.replace(UPGRADE_MARKER, ""),
      };
    }
    if (chunk.accumulated?.content) {
      chunk.accumulated = {
        ...chunk.accumulated,
        content: chunk.accumulated.content.replace(UPGRADE_MARKER, "").trim(),
      };
    }
    return { ...event, chunk };
  }
}
