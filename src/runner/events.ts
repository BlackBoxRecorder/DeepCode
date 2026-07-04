/**
 * Runner event types — per-mode event definitions and the combined union.
 *
 * Each runner mode owns its event types locally. The combined RunnerStreamEvent
 * is the type Coordinator and display adapters consume.
 */
import type { LLMStreamChunk } from "../llm/index.js";
import type { AgentResult } from "../index.js";
import type { ToolResult } from "../tool-interface/index.js";

// ============================================================================
// Base ReAct events (defined in Agent, re-used here for the combined union)
// ============================================================================

/** Narrow AgentStreamEvent — only what Agent.runWithMessages() emits. */
export type AgentStreamEvent =
  | { type: "chunk"; chunk: LLMStreamChunk }
  | {
      type: "tool_result";
      tool: string;
      params: Record<string, any>;
      result: ToolResult;
    }
  | { type: "done"; result: AgentResult }
  | {
      type: "upgrade_requested";
      userInput: string;
      reason: string;
    };

// ============================================================================
// Plan-Execute types
// ============================================================================

/** A single sub-task within a plan. */
export interface PlanTask {
  id: string;
  goal: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
}

/** A plan: an ordered list of sub-tasks decomposed from a user request. */
export interface Plan {
  tasks: PlanTask[];
  /** Reserved for future DAG support. */
  dependencies?: Record<string, string[]>;
}

/** Plan-Execute runner events. */
export type PlanExecuteEvent =
  | { type: "plan_generated"; plan: Plan }
  | {
      type: "task_start";
      taskId: string;
      goal: string;
      index: number;
      total: number;
    }
  | {
      type: "task_progress";
      taskId: string;
      event: AgentStreamEvent;
    }
  | {
      type: "task_done";
      taskId: string;
      status: "done" | "failed";
      result?: string;
    }
  | { type: "plan_complete"; plan: Plan; result: AgentResult }
  | { type: "done"; result: AgentResult };

// ============================================================================
// Loop-Engineering types
// ============================================================================

/** Loop-Engineering runner events — forwards PlanExecuteEvents + own verification. */
export type LoopEngineeringEvent =
  | PlanExecuteEvent
  | {
      type: "verification";
      attempt: number;
      passed: boolean;
      reason: string;
      suggestion?: string;
    }
  | {
      type: "loop_retry";
      attempt: number;
      maxAttempts: number;
      reason: string;
      suggestion?: string;
    };

// ============================================================================
// Combined union — what Coordinator + DisplayRenderer consume
// ============================================================================

/** Full event union across all runner modes. */
export type RunnerStreamEvent =
  | AgentStreamEvent
  | PlanExecuteEvent
  | LoopEngineeringEvent;
