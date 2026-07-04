/**
 * LoopEngineeringRunner — wraps Plan-Execute with independent verification.
 *
 * Flow:
 * 1. Planner decomposes user request → Plan (via PlanExecuteRunner internals)
 * 2. Execute tasks via PlanExecuteRunner
 * 3. Verifier (independent LLM) evaluates whether the result meets the goal
 * 4. On pass: return result, turn complete
 * 5. On fail: re-plan and re-execute (max 3 retries)
 * 6. No-progress detection: if two consecutive verifications are identical, terminate early
 */
import type { Message, LLMClient } from "../llm/index.js";
import type { Agent } from "../index.js";
import type {
  AgentStreamEvent,
  AgentResult,
  Plan,
} from "../index.js";
import type { AgentMode, AgentRunner } from "./types.js";
import { PlanExecuteRunner, stripMarkdownCodeFences } from "./plan-execute-runner.js";

// ============================================================================
// Verifier Interface & Implementation
// ============================================================================

/** Result of a Verifier evaluation. */
export interface VerificationResult {
  passed: boolean;
  reason: string;
  suggestion?: string;
}

/** Verifier — evaluates whether execution result meets the original goal. */
export interface Verifier {
  verify(
    goal: string,
    result: string,
    logs: string,
  ): Promise<VerificationResult>;
}

/** Verifier system prompt: an independent evaluator with no tool access. */
const VERIFIER_SYSTEM_PROMPT = `You are a verification evaluator. Your job is to assess whether an execution result satisfies a given goal.

You will receive:
1. The original user goal
2. A summary of what was done (execution result)
3. Detailed execution logs

Evaluate strictly:
- If the result clearly demonstrates that the goal was achieved → passed: true
- If the result does NOT achieve the goal or is insufficient → passed: false

Provide a clear reason and, when verification fails, a concrete suggestion for what to try differently on the next attempt.

Output a JSON object with this exact structure:
{
  "passed": true/false,
  "reason": "Clear explanation of the evaluation",
  "suggestion": "What to try differently (only if passed is false)"
}`;

/**
 * LLMVerifier — uses an independent LLM call (tool_choice: "none") to evaluate
 * whether the execution result meets the original goal.
 */
export class LLMVerifier implements Verifier {
  constructor(private llm: LLMClient) {}

  async verify(
    goal: string,
    result: string,
    logs: string,
  ): Promise<VerificationResult> {
    const messages: Message[] = [
      { role: "system", content: VERIFIER_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "## Original Goal",
          goal,
          "",
          "## Execution Result",
          result,
          "",
          "## Execution Logs",
          logs,
        ].join("\n"),
      },
    ];

    const response = await this.llm.chat(messages, undefined, {
      tool_choice: "none",
    });
    const raw = response.content ?? "";

    return parseVerificationJson(raw);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Try to parse JSON from verifier output. */
function parseVerificationJson(raw: string): VerificationResult {
  const text = stripMarkdownCodeFences(raw);

  try {
    const parsed = JSON.parse(text);
    return {
      passed: Boolean(parsed.passed),
      reason: String(parsed.reason ?? "No reason provided"),
      suggestion: parsed.suggestion ? String(parsed.suggestion) : undefined,
    };
  } catch {
    // Fallback: treat parse failure as verification failure
    return {
      passed: false,
      reason: `Failed to parse verifier output: ${raw.slice(0, 200)}`,
    };
  }
}

/** Check if two verification results are identical (for no-progress detection). */
function areVerificationsIdentical(
  a: VerificationResult,
  b: VerificationResult,
): boolean {
  return (
    a.passed === b.passed &&
    a.reason === b.reason &&
    (a.suggestion ?? "") === (b.suggestion ?? "")
  );
}

// ============================================================================
// LoopEngineeringRunner
// ============================================================================

const MAX_RETRIES = 3;

export class LoopEngineeringRunner implements AgentRunner {
  readonly mode: AgentMode = "loop-engineering";
  private _conversationMessages: Message[] = [];
  private planExecuteRunner: PlanExecuteRunner;
  private verifier: LLMVerifier;

  constructor(
    private llm: LLMClient,
    private agent: Agent,
  ) {
    this.planExecuteRunner = new PlanExecuteRunner(this.llm, this.agent);
    this.verifier = new LLMVerifier(this.llm);
  }

  // ==========================================================================
  // AgentRunner interface
  // ==========================================================================

  get conversationMessages(): readonly Message[] {
    return this._conversationMessages;
  }

  get systemPromptText(): string {
    return this.agent.systemPromptText;
  }

  setConversationMessages(messages: Message[]): void {
    this._conversationMessages = [...messages];
  }

  async *run(
    inputMessages: Message[],
  ): AsyncGenerator<AgentStreamEvent, AgentResult> {
    const outerMessages = [...inputMessages];

    // Extract the user's request (last user message content).
    const lastUserMsg = [...inputMessages]
      .reverse()
      .find((m) => m.role === "user");
    const userGoal = lastUserMsg?.content ?? "";

    // Collect all execution logs across attempts
    const allLogs: string[] = [];
    let bestResult: AgentResult | undefined;
    let previousVerificationResult: VerificationResult | undefined;
    let noProgress = false;
    let finalPlan: Plan | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Build the goal message for this attempt
      const attemptGoal =
        attempt === 0
          ? userGoal
          : `[Retry attempt ${attempt}/${MAX_RETRIES}] Previous attempt did not pass verification. ` +
            (previousVerificationResult?.suggestion
              ? `Suggestion: ${previousVerificationResult.suggestion}. `
              : "") +
            `Original goal: ${userGoal}`;

      // ------------------------------------------------------------------
      // 1. Plan + Execute via PlanExecuteRunner
      // ------------------------------------------------------------------
      const peMessages: Message[] = [
        { role: "system", content: this.agent.systemPromptText },
        { role: "user", content: attemptGoal },
      ];

      let peResult: AgentResult | undefined;
      let pePlan: Plan | undefined;
      const peLogParts: string[] = [];

      // We need to sync the plan-execute runner's conversation state
      // for each attempt. Reset it before each attempt.
      this.planExecuteRunner.setConversationMessages([]);

      try {
        for await (const event of this.planExecuteRunner.run(peMessages)) {
          // Collect plan info
          if (event.type === "plan_generated") {
            pePlan = event.plan;
            if (!finalPlan) finalPlan = pePlan;
            yield event;
          }
          // Forward task events
          else if (
            event.type === "task_start" ||
            event.type === "task_progress" ||
            event.type === "task_done"
          ) {
            if (event.type === "task_done") {
              peLogParts.push(
                `Task ${event.taskId}: ${event.status} — ${event.result ?? ""}`,
              );
            }
            yield event;
          }
          // Forward plan_complete
          else if (event.type === "plan_complete") {
            peResult = event.result;
            peLogParts.push(`Plan complete: ${event.result.content}`);
            yield event;
          }
          // Forward done (but we'll re-emit our own done at the end)
          else if (event.type === "done") {
            if (!peResult) peResult = event.result;
          }
          // Don't forward inner done events from plan-execute; we control
          // the outer done event. Chunk and tool_result pass through via else.
          else {
            yield event;
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        peLogParts.push(`Execution error: ${errorMsg}`);
        peResult = {
          success: false,
          content: `Execution failed: ${errorMsg}`,
          toolCalls: [],
          iterations: 0,
          allMessages: peMessages,
        };
      }

      // Store the best result so far (last successful or first)
      if (peResult && (!bestResult || peResult.success)) {
        bestResult = peResult;
      }

      const execSummary = peResult?.content ?? "No result produced.";
      const execLogs = peLogParts.join("\n");
      allLogs.push(`--- Attempt ${attempt + 1} ---\n${execLogs}`);

      // ------------------------------------------------------------------
      // 2. Verify
      // ------------------------------------------------------------------
      let verification: VerificationResult;
      try {
        verification = await this.verifier.verify(
          userGoal,
          execSummary,
          allLogs.join("\n\n"),
        );
      } catch (err) {
        verification = {
          passed: false,
          reason: `Verifier error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      yield {
        type: "verification",
        attempt: attempt + 1,
        passed: verification.passed,
        reason: verification.reason,
        suggestion: verification.suggestion,
      };

      // ------------------------------------------------------------------
      // 3. Check verification result
      // ------------------------------------------------------------------
      if (verification.passed) {
        // Success! Verification passed.
        const finalMessages: Message[] = [
          ...outerMessages,
          {
            role: "assistant",
            content: [
              `Loop Engineering complete — verification passed on attempt ${attempt + 1}.`,
              "",
              `Result: ${execSummary}`,
              `Verification: ${verification.reason}`,
            ].join("\n"),
          },
        ];

        this._conversationMessages = finalMessages;

        const result: AgentResult = {
          success: true,
          content: execSummary,
          toolCalls: bestResult?.toolCalls ?? [],
          iterations: (bestResult?.iterations ?? 0) + attempt,
          allMessages: finalMessages,
        };

        yield { type: "done", result };
        return result;
      }

      // No-progress detection
      if (previousVerificationResult) {
        if (areVerificationsIdentical(verification, previousVerificationResult)) {
          noProgress = true;
          yield {
            type: "loop_retry",
            attempt: attempt + 1,
            maxAttempts: MAX_RETRIES,
            reason:
              "No progress detected — verification result identical to previous attempt. Terminating early.",
          };
          break;
        }
      }

      previousVerificationResult = verification;

      // If we've exhausted retries, break out
      if (attempt >= MAX_RETRIES) {
        // Emit final retry notice before breaking
        yield {
          type: "loop_retry",
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES,
          reason: `Max retries (${MAX_RETRIES}) exhausted. Verification did not pass.`,
          suggestion: verification.suggestion,
        };
        break;
      }

      // Emit retry event and continue loop
      yield {
        type: "loop_retry",
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES,
        reason: verification.reason,
        suggestion: verification.suggestion,
      };
    }

    // ------------------------------------------------------------------
    // Exhausted all retries or no-progress — return best result with note
    // ------------------------------------------------------------------
    const exhaustionNote = noProgress
      ? "Loop Engineering stopped: no progress detected (identical verification results)."
      : `Loop Engineering exhausted maximum retries (${MAX_RETRIES}). Verification did not pass.`;

    const finalContent = [
      exhaustionNote,
      "",
      bestResult?.content ?? "No result produced.",
      previousVerificationResult
        ? `Last verification: ${previousVerificationResult.reason}`
        : "",
    ].join("\n");

    const finalMessages: Message[] = [
      ...outerMessages,
      {
        role: "assistant",
        content: finalContent,
      },
    ];

    this._conversationMessages = finalMessages;

    const result: AgentResult = {
      success: false,
      content: finalContent,
      toolCalls: bestResult?.toolCalls ?? [],
      iterations: (bestResult?.iterations ?? 0) + MAX_RETRIES,
      allMessages: finalMessages,
    };

    yield { type: "done", result };
    return result;
  }
}
