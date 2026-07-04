/**
 * ConversationCoordinator — manages session lifecycle and turn execution.
 *
 * Sits between CLI (display) and AgentRunner + SessionManager (logic + persistence).
 * Owns conversation state so display adapters (CLI, future TUI) don't need to.
 */
import type { Message, LLMClient } from "./llm/index.js";
import type { AgentStreamEvent, AgentResult, Agent } from "./index.js";
import type { AgentRunner, AgentMode } from "./runner/index.js";
import { PlanExecuteRunner } from "./runner/index.js";
import {
  SessionManager,
  type SessionMeta,
  type TurnRecord,
  type PlanRecord,
  type SubTaskRecord,
  type VerificationRecord,
} from "./session.js";

// ============================================================================
// Types
// ============================================================================

/** Events yielded during turn execution. Extends Agent's own events. */
export type TurnEvent =
  | AgentStreamEvent
  | { type: "session_created"; sessionId: string; title: string }
  | { type: "save_error"; error: string }
  | { type: "agent_error"; error: string };

/** Configuration for ConversationCoordinator. */
export interface CoordinatorConfig {
  runner: AgentRunner;
  sessionManager: SessionManager;
  /** LLM client — required for Plan-Execute mode switching. */
  llm?: LLMClient;
  /** Agent — required for Plan-Execute mode switching. */
  agent?: Agent;
}

// ============================================================================
// Coordinator
// ============================================================================

export class ConversationCoordinator {
  private currentRunner: AgentRunner;
  private sessionManager: SessionManager;
  private llm: LLMClient | undefined;
  private agent: Agent | undefined;
  private _sessionId: string | null = null;

  constructor(config: CoordinatorConfig) {
    this.currentRunner = config.runner;
    this.sessionManager = config.sessionManager;
    this.llm = config.llm;
    this.agent = config.agent;
  }

  // ==========================================================================
  // Read-only state (for display adapters)
  // ==========================================================================

  get currentMode(): AgentMode {
    return this.currentRunner.mode;
  }

  get currentSessionId(): string | null {
    return this._sessionId;
  }

  // ==========================================================================
  // Mode switching
  // ==========================================================================

  /**
   * Switch the Agent Loop mode.
   */
  async setMode(mode: AgentMode): Promise<void> {
    if (mode === this.currentRunner.mode) return; // Already in this mode

    if (mode === "plan-execute") {
      if (!this.llm || !this.agent) {
        throw new Error(
          "Cannot switch to plan-execute: coordinator was not configured with LLM and Agent.",
        );
      }
      const newRunner = new PlanExecuteRunner(this.llm, this.agent);
      newRunner.setConversationMessages([
        ...this.currentRunner.conversationMessages,
      ]);
      this.currentRunner = newRunner;
      return;
    }

    if (mode === "loop-engineering") {
      if (!this.llm || !this.agent) {
        throw new Error(
          "Cannot switch to loop-engineering: coordinator was not configured with LLM and Agent.",
        );
      }
      // Dynamic import to avoid circular dependency at module level
      // LoopEngineeringRunner is imported here lazily.
      const { LoopEngineeringRunner } = await import(
        "./runner/loop-engineering-runner.js"
      );
      const newRunner = new LoopEngineeringRunner(this.llm, this.agent);
      newRunner.setConversationMessages([
        ...this.currentRunner.conversationMessages,
      ]);
      this.currentRunner = newRunner;
      return;
    }

    if (mode === "react") {
      // Switching back to react — create a fresh ReActRunner.
      // The caller (app-factory) should pass agent reference, but for
      // simplicity we just keep the original runner if already react.
      // Future iterations: store a ReActRunner factory in config.
      throw new Error(
        'Switching back to "react" mode is not supported yet. Start a new session instead.',
      );
    }

    throw new Error(`Mode "${mode}" is not implemented yet.`);
  }

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  /** Discard current session and start fresh. */
  newSession(): void {
    this._sessionId = null;
    this.currentRunner.setConversationMessages([]);
  }

  /** List all persisted sessions, most recent first. */
  async listSessions(): Promise<SessionMeta[]> {
    return this.sessionManager.listSessions();
  }

  /** Resume a persisted session, restoring its full message history. */
  async resumeSession(sessionId: string): Promise<SessionMeta> {
    const meta = await this.sessionManager.getSessionMeta(sessionId);
    if (!meta) {
      throw new Error(`Session "${sessionId.slice(0, 8)}" not found.`);
    }
    const loaded = await this.sessionManager.loadMessages(sessionId);
    this._sessionId = sessionId;
    this.currentRunner.setConversationMessages([
      { role: "system", content: this.currentRunner.systemPromptText },
      ...loaded,
    ]);
    return meta;
  }

  // ==========================================================================
  // Turn execution
  // ==========================================================================

  /**
   * Execute one user-input turn through the current runner, saving the result.
   * Yields streaming events for real-time display.
   */
  async *executeTurn(userInput: string): AsyncGenerator<TurnEvent, void> {
    // Auto-create session on first message
    if (this._sessionId === null) {
      const meta = await this.sessionManager.createSession(userInput);
      this._sessionId = meta.id;
      this.currentRunner.setConversationMessages([
        { role: "system", content: this.currentRunner.systemPromptText },
      ]);
      yield {
        type: "session_created",
        sessionId: meta.id,
        title: meta.title,
      };
    }

    // Build turn input from runner's current conversation state.
    const messagesBefore = this.currentRunner.conversationMessages.length;
    const turnInput: Message[] = [
      ...this.currentRunner.conversationMessages,
      { role: "user", content: userInput },
    ];

    // Collect plan-execute metadata from stream events.
    let planRecord: PlanRecord | undefined;
    const subTaskRecords: SubTaskRecord[] = [];
    const verificationRecords: VerificationRecord[] = [];

    // Run runner (runner copies input internally — no mutation on our array)
    let result: AgentResult | undefined;
    try {
      for await (const event of this.currentRunner.run(turnInput)) {
        // Collect plan metadata from events
        if (event.type === "plan_generated") {
          planRecord = {
            tasks: event.plan.tasks.map((t) => ({
              id: t.id,
              goal: t.goal,
              status: t.status,
              result: t.result,
            })),
          };
        }
        if (event.type === "task_done") {
          const task = planRecord?.tasks.find((t) => t.id === event.taskId);
          subTaskRecords.push({
            taskId: event.taskId,
            goal: task?.goal ?? "",
            status: event.status,
            result: event.result,
          });
          // Update plan record task status
          if (task) {
            task.status = event.status;
            task.result = event.result;
          }
        }
        if (event.type === "verification") {
          verificationRecords.push({
            attempt: event.attempt,
            passed: event.passed,
            reason: event.reason,
            suggestion: event.suggestion,
            timestamp: new Date().toISOString(),
          });
        }
        if (event.type === "done") {
          result = event.result;
        }
        yield event;
      }
    } catch (agentErr) {
      // Safety net: if the agent crashes after session creation, save an
      // error turn to prevent orphaned meta files (meta.json without .jsonl).
      const errorMsg =
        agentErr instanceof Error ? agentErr.message : String(agentErr);

      if (this._sessionId) {
        const errorTurn: TurnRecord = {
          type: "turn",
          timestamp: new Date().toISOString(),
          userInput,
          messages: [
            ...turnInput.slice(messagesBefore),
            {
              role: "assistant",
              content: `Agent error: ${errorMsg}`,
            } as Message,
          ],
        };
        try {
          await this.sessionManager.appendTurn(this._sessionId, errorTurn);
        } catch (saveErr) {
          yield {
            type: "save_error",
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          };
        }
      }

      // Restore message history to before the failed turn so the next
      // turn starts from a clean state.
      this.currentRunner.setConversationMessages(
        this.currentRunner.conversationMessages.slice(0, messagesBefore),
      );

      yield { type: "agent_error", error: errorMsg };
      return;
    }

    // Runner updates its internal state automatically in run().
    // No need to manually sync — conversationMessages is already up to date.

    // Persist the turn
    if (this._sessionId && result) {
      const turnMessages = result.allMessages.slice(messagesBefore);
      if (turnMessages.length > 0) {
        const turnRecord: TurnRecord = {
          type: "turn",
          timestamp: new Date().toISOString(),
          userInput,
          messages: turnMessages,
          plan: planRecord,
          subTasks: subTaskRecords.length > 0 ? subTaskRecords : undefined,
          verifications:
            verificationRecords.length > 0 ? verificationRecords : undefined,
        };
        try {
          await this.sessionManager.appendTurn(this._sessionId, turnRecord);
        } catch (err) {
          yield {
            type: "save_error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  }
}
