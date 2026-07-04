/**
 * RenderingAdapter — narrow interface for per-mode display rendering.
 *
 * Each runner mode provides its own adapter that knows how to render
 * mode-specific events. DisplayRenderer delegates to the active adapter,
 * keeping the renderer shallow and mode-local rendering logic deep.
 */
import type { TurnEvent } from "../coordinator.js";
import type {
  AgentStreamEvent,
  PlanExecuteEvent,
  LoopEngineeringEvent,
} from "../runner/events.js";

// ============================================================================
// Adapter interface
// ============================================================================

/**
 * Each runner mode adapter implements this to map mode-specific events
 * into three narrow display operations. The interface is deliberately
 * sparse — three methods covers every event type without becoming a
 * shadow of the event union.
 */
export interface RenderingAdapter {
  /** The mode this adapter handles (for DisplayRenderer routing). */
  readonly mode: string;

  /** Render one turn event. Returns true if handled, false if not for this adapter. */
  handleEvent(event: TurnEvent, ctx: RenderContext): boolean;
}

/** Mutable rendering context shared across events in a turn. */
export interface RenderContext {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  hasShownReasoningInRound: boolean;
  totalToolCalls: number;
}

// ============================================================================
// ReAct adapter — handles chunk, tool_result, done, upgrade_requested
// ============================================================================

export class ReActRenderingAdapter implements RenderingAdapter {
  readonly mode = "react";

  handleEvent(event: TurnEvent, ctx: RenderContext): boolean {
    switch (event.type) {
      case "chunk": {
        const { delta } = event.chunk;
        if (delta.reasoning_content) {
          if (!ctx.hasShownReasoningInRound) {
            ctx.stdout.write("\n[Thinking...]\n");
            ctx.hasShownReasoningInRound = true;
          }
          ctx.stdout.write(delta.reasoning_content);
        }
        if (delta.content) {
          if (ctx.hasShownReasoningInRound) {
            ctx.stdout.write("\n--- Answer ---\n");
            ctx.hasShownReasoningInRound = false;
          }
          ctx.stdout.write(delta.content);
        }
        return true;
      }
      case "tool_result": {
        ctx.totalToolCalls++;
        const status = event.result.success ? "✓" : "✗";
        const paramsStr = JSON.stringify(event.params);
        ctx.stdout.write(`\n  ${status} ${event.tool} ${paramsStr}`);
        ctx.hasShownReasoningInRound = false;
        return true;
      }
      case "done": {
        if (ctx.totalToolCalls > 0) {
          ctx.stdout.write(`\n[${ctx.totalToolCalls} tool(s) used]\n`);
        }
        return true;
      }
      default:
        return false; // Not a ReAct event
    }
  }
}

// ============================================================================
// Plan-Execute adapter — handles plan_generated, task_start, task_progress,
// task_done, plan_complete. Delegates inner events to ReActAdapter.
// ============================================================================

export class PlanExecuteRenderingAdapter implements RenderingAdapter {
  readonly mode = "plan-execute";
  private reactAdapter = new ReActRenderingAdapter();
  private currentTaskId: string | null = null;
  private planTaskTotal = 0;
  private planTaskIndex = 0;

  handleEvent(event: TurnEvent, ctx: RenderContext): boolean {
    switch (event.type) {
      case "plan_generated": {
        this.planTaskTotal = event.plan.tasks.length;
        ctx.stdout.write(`\n[Plan] ${this.planTaskTotal} task(s):\n`);
        for (const t of event.plan.tasks) {
          ctx.stdout.write(`  ${t.id}. ${t.goal}\n`);
        }
        ctx.stdout.write("\n");
        return true;
      }
      case "task_start": {
        this.currentTaskId = event.taskId;
        this.planTaskIndex = event.index;
        ctx.stdout.write(`\n[${event.index}/${event.total}] ${event.goal}\n`);
        return true;
      }
      case "task_progress": {
        // Delegate inner ReAct events to the ReAct adapter
        const inner = event.event;
        if (
          inner.type === "chunk" ||
          inner.type === "tool_result" ||
          inner.type === "done"
        ) {
          this.reactAdapter.handleEvent(inner as unknown as TurnEvent, ctx);
        }
        return true;
      }
      case "task_done": {
        const marker = event.status === "done" ? "✓" : "✗";
        ctx.stdout.write(`\n  ${marker} Task ${event.taskId} ${event.status}`);
        if (event.result) {
          ctx.stdout.write(` (${event.result.slice(0, 80)})`);
        }
        ctx.stdout.write("\n");
        return true;
      }
      case "plan_complete": {
        if (event.result.content) {
          ctx.stdout.write(`\n${event.result.content}\n`);
        }
        return true;
      }
      default:
        return false; // Not a plan-execute event
    }
  }
}

// ============================================================================
// Loop-Engineering adapter — extends PlanExecute adapter with verification
// and retry events.
// ============================================================================

export class LoopEngineeringRenderingAdapter implements RenderingAdapter {
  readonly mode = "loop-engineering";
  private planAdapter = new PlanExecuteRenderingAdapter();

  handleEvent(event: TurnEvent, ctx: RenderContext): boolean {
    // First try plan-execute events (parent adapter)
    if (this.planAdapter.handleEvent(event, ctx)) {
      return true;
    }

    // Then loop-specific events
    switch (event.type) {
      case "verification": {
        const vMarker = event.passed ? "✓ VERIFIED" : "✗ FAILED";
        ctx.stdout.write(`\n[Attempt ${event.attempt}] ${vMarker}`);
        if (event.reason) {
          ctx.stdout.write(`\n  Reason: ${event.reason}`);
        }
        if (event.suggestion) {
          ctx.stdout.write(`\n  Suggestion: ${event.suggestion}`);
        }
        ctx.stdout.write("\n");
        return true;
      }
      case "loop_retry": {
        ctx.stdout.write(
          `\n[Retry ${event.attempt}/${event.maxAttempts}] ${event.reason}`,
        );
        if (event.suggestion) {
          ctx.stdout.write(`\n  → ${event.suggestion}`);
        }
        ctx.stdout.write("\n");
        return true;
      }
      default:
        return false;
    }
  }
}

// ============================================================================
// Factory — pick the right adapter for a given mode
// ============================================================================

const adapterCache = new Map<string, RenderingAdapter>();

export function getAdapterForMode(mode: string): RenderingAdapter {
  const cached = adapterCache.get(mode);
  if (cached) return cached;

  let adapter: RenderingAdapter;
  switch (mode) {
    case "react":
      adapter = new ReActRenderingAdapter();
      break;
    case "plan-execute":
      adapter = new PlanExecuteRenderingAdapter();
      break;
    case "loop-engineering":
      adapter = new LoopEngineeringRenderingAdapter();
      break;
    default:
      adapter = new ReActRenderingAdapter();
  }
  adapterCache.set(mode, adapter);
  return adapter;
}
