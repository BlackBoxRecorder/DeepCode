/**
 * PlanExecuteRunner — executes tasks in Plan-Execute mode.
 *
 * Flow:
 * 1. Planner LLM decomposes the user request into a Plan (JSON sub-task list)
 * 2. Each sub-task runs as an independent ReAct session via the Agent
 * 3. Streaming events report progress: plan_generated → task_start →
 *    task_progress (inner events) → task_done → … → plan_complete
 */
import type { Message } from "../llm/index.js";
import type { LLMClient } from "../llm/index.js";
import type { Agent } from "../index.js";
import type {
  AgentStreamEvent,
  AgentResult,
  Plan,
  PlanTask,
} from "../index.js";
import type { AgentMode, AgentRunner } from "./types.js";

// ============================================================================
// Planner Prompt
// ============================================================================

const PLANNER_SYSTEM_PROMPT = `You are a task planner. Given a user request, break it down into a sequence of concrete, independently executable sub-tasks. Each sub-task should be a single, actionable step that can be completed by an AI agent with access to bash commands and filesystem tools.

Output a JSON object with this exact structure:
{
  "tasks": [
    { "id": "1", "goal": "Description of first sub-task" },
    { "id": "2", "goal": "Description of second sub-task" }
  ]
}

Rules:
- Task IDs must be sequential numbers as strings ("1", "2", "3", ...)
- Each goal should be a clear, self-contained instruction with enough context to execute independently
- Keep goals concise but complete
- Output ONLY the JSON object, no other text or markdown formatting`;

// ============================================================================
// Helpers
// ============================================================================

/** Strip markdown code fences from LLM output. */
export function stripMarkdownCodeFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const endFence = text.indexOf("\n", 3);
    if (endFence !== -1) {
      text = text.slice(endFence + 1);
    }
    const lastFence = text.lastIndexOf("```");
    if (lastFence !== -1) {
      text = text.slice(0, lastFence);
    }
    text = text.trim();
  }
  return text;
}

/** Try to parse JSON from LLM output, handling markdown code fences. */
function parsePlanJson(raw: string): Plan | null {
  const text = stripMarkdownCodeFences(raw);

  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.tasks)) {
      const tasks: PlanTask[] = parsed.tasks.map((t: any, i: number) => ({
        id: t.id ?? String(i + 1),
        goal: String(t.goal ?? ""),
        status: "pending" as const,
      }));
      if (tasks.length === 0) return null;
      return { tasks };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// PlanExecuteRunner
// ============================================================================

export class PlanExecuteRunner implements AgentRunner {
  readonly mode: AgentMode = "plan-execute";
  private _conversationMessages: Message[] = [];

  constructor(
    private plannerLLM: LLMClient,
    private agent: Agent,
  ) {}

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
    // Copy input — we'll append the final summary at the end.
    const outerMessages = [...inputMessages];

    // Extract the user's request (last user message content).
    const lastUserMsg = [...inputMessages]
      .reverse()
      .find((m) => m.role === "user");
    const userRequest = lastUserMsg?.content ?? "";

    // ------------------------------------------------------------------
    // 1. Planner: decompose user request into a plan
    // ------------------------------------------------------------------
    const planMessages: Message[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: userRequest },
    ];

    let plan: Plan;
    try {
      const response = await this.plannerLLM.chat(planMessages, undefined, {
        tool_choice: "none",
      });
      const raw = response.content ?? "";
      const parsed = parsePlanJson(raw);
      if (!parsed) {
        throw new Error(
          `Failed to parse plan from planner output: ${raw.slice(0, 200)}`,
        );
      }
      plan = parsed;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      outerMessages.push({
        role: "assistant",
        content: `Plan generation failed: ${errorMsg}`,
      });
      this._conversationMessages = outerMessages;
      const result: AgentResult = {
        success: false,
        content: `Plan generation failed: ${errorMsg}`,
        toolCalls: [],
        iterations: 0,
        allMessages: outerMessages,
      };
      yield { type: "done", result };
      return result;
    }

    yield { type: "plan_generated", plan };

    // ------------------------------------------------------------------
    // 2. Execute each sub-task as an independent ReAct session
    // ------------------------------------------------------------------
    let allSuccess = true;
    let totalIterations = 0;
    const finalParts: string[] = [];

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      task.status = "running";
      yield {
        type: "task_start",
        taskId: task.id,
        goal: task.goal,
        index: i + 1,
        total: plan.tasks.length,
      };

      const taskMessages: Message[] = [
        { role: "system", content: this.agent.systemPromptText },
        { role: "user", content: task.goal },
      ];

      let taskResult: AgentResult | undefined;
      try {
        for await (const event of this.agent.runWithMessages(taskMessages)) {
          yield { type: "task_progress", taskId: task.id, event };
          if (event.type === "done") {
            taskResult = event.result;
          }
        }
      } catch (err) {
        task.status = "failed";
        task.result = err instanceof Error ? err.message : String(err);
        yield {
          type: "task_done",
          taskId: task.id,
          status: "failed",
          result: task.result,
        };
        allSuccess = false;
        finalParts.push(`Task ${task.id}: FAILED — ${task.result}`);
        continue;
      }

      if (!taskResult || !taskResult.success) {
        task.status = "failed";
        task.result = taskResult?.content ?? "Unknown error";
        yield {
          type: "task_done",
          taskId: task.id,
          status: "failed",
          result: task.result,
        };
        allSuccess = false;
        finalParts.push(`Task ${task.id}: FAILED — ${task.result}`);
        continue;
      }

      // Task succeeded
      task.status = "done";
      task.result = taskResult.content;
      yield {
        type: "task_done",
        taskId: task.id,
        status: "done",
        result: taskResult.content,
      };
      totalIterations += taskResult.iterations;
      finalParts.push(`Task ${task.id}: ${taskResult.content.slice(0, 200)}`);
    }

    // ------------------------------------------------------------------
    // 3. Build final result
    // ------------------------------------------------------------------
    const summary =
      `Plan execution complete. ${plan.tasks.length} task(s) processed.\n\n` +
      finalParts.join("\n\n");

    const finalAgentMessages: Message[] = [
      ...outerMessages,
      {
        role: "assistant",
        content: summary,
      },
    ];

    this._conversationMessages = finalAgentMessages;

    const result: AgentResult = {
      success: allSuccess,
      content: summary,
      toolCalls: [],
      iterations: totalIterations,
      allMessages: finalAgentMessages,
    };

    yield { type: "plan_complete", plan, result };
    yield { type: "done", result };
    return result;
  }
}
