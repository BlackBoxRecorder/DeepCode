/**
 * DisplayRenderer — renders Agent stream events to terminal output.
 *
 * Decouples display logic from the CLI event loop so it can be tested
 * independently and replaced for a future TUI without touching anything else.
 */
import type { TurnEvent } from "../coordinator.js";

// ============================================================================
// Configuration
// ============================================================================

export interface DisplayConfig {
  /** Stream to write output to (default: process.stdout). */
  stdout?: NodeJS.WriteStream;
  /** Stream to write errors to (default: process.stderr). */
  stderr?: NodeJS.WriteStream;
}

// ============================================================================
// Renderer
// ============================================================================

export class DisplayRenderer {
  private stdout: NodeJS.WriteStream;
  private stderr: NodeJS.WriteStream;

  constructor(config: DisplayConfig = {}) {
    this.stdout = config.stdout ?? process.stdout;
    this.stderr = config.stderr ?? process.stderr;
  }

  /**
   * Consume turn events from a coordinator and render them to the terminal.
   * Returns after the turn is complete (done / agent_error event).
   */
  async renderTurn(events: AsyncGenerator<TurnEvent, void>): Promise<void> {
    let hasShownReasoningInRound = false;
    let totalToolCalls = 0;
    let currentTaskId: string | null = null;
    let planTaskTotal = 0;
    let planTaskIndex = 0;

    try {
      for await (const event of events) {
        switch (event.type) {
          case "session_created": {
            this.stdout.write(`[Session ${event.sessionId.slice(0, 8)}] `);
            break;
          }
          case "plan_generated": {
            planTaskTotal = event.plan.tasks.length;
            this.stdout.write(`\n[Plan] ${planTaskTotal} task(s):\n`);
            for (const t of event.plan.tasks) {
              this.stdout.write(`  ${t.id}. ${t.goal}\n`);
            }
            this.stdout.write("\n");
            break;
          }
          case "task_start": {
            currentTaskId = event.taskId;
            planTaskIndex = event.index;
            this.stdout.write(
              `\n[${event.index}/${event.total}] ${event.goal}\n`,
            );
            break;
          }
          case "task_progress": {
            // Forward the inner event for rendering
            const inner = event.event;
            if (inner.type === "chunk") {
              const { delta } = inner.chunk;
              if (delta.reasoning_content) {
                if (!hasShownReasoningInRound) {
                  this.stdout.write("  [Thinking...]\n");
                  hasShownReasoningInRound = true;
                }
                this.stdout.write(`  ${delta.reasoning_content}`);
              }
              if (delta.content) {
                if (hasShownReasoningInRound) {
                  this.stdout.write("\n  --- Answer ---\n");
                  hasShownReasoningInRound = false;
                }
                this.stdout.write(delta.content);
              }
            } else if (inner.type === "tool_result") {
              totalToolCalls++;
              const status = inner.result.success ? "✓" : "✗";
              const paramsStr = JSON.stringify(inner.params);
              this.stdout.write(`\n    ${status} ${inner.tool} ${paramsStr}`);
              hasShownReasoningInRound = false;
            }
            // Don't forward nested done/plan events in task_progress
            break;
          }
          case "task_done": {
            const marker = event.status === "done" ? "✓" : "✗";
            this.stdout.write(
              `\n  ${marker} Task ${event.taskId} ${event.status}`,
            );
            if (event.result) {
              this.stdout.write(` (${event.result.slice(0, 80)})`);
            }
            this.stdout.write("\n");
            break;
          }
          case "plan_complete": {
            if (event.result.content) {
              this.stdout.write(`\n${event.result.content}\n`);
            }
            break;
          }
          case "chunk": {
            const { delta } = event.chunk;
            if (delta.reasoning_content) {
              if (!hasShownReasoningInRound) {
                this.stdout.write("\n[Thinking...]\n");
                hasShownReasoningInRound = true;
              }
              this.stdout.write(delta.reasoning_content);
            }
            if (delta.content) {
              if (hasShownReasoningInRound) {
                this.stdout.write("\n--- Answer ---\n");
                hasShownReasoningInRound = false;
              }
              this.stdout.write(delta.content);
            }
            break;
          }
          case "tool_result": {
            totalToolCalls++;
            const status = event.result.success ? "✓" : "✗";
            const paramsStr = JSON.stringify(event.params);
            this.stdout.write(`\n  ${status} ${event.tool} ${paramsStr}`);
            hasShownReasoningInRound = false;
            break;
          }
          case "done": {
            if (totalToolCalls > 0) {
              this.stdout.write(`\n[${totalToolCalls} tool(s) used]\n`);
            }
            break;
          }
          case "save_error": {
            this.stderr.write(`\n[Session save error: ${event.error}]\n`);
            break;
          }
          case "agent_error": {
            this.stderr.write(`\n[Agent error: ${event.error}]\n`);
            break;
          }
        }
      }
      this.stdout.write("\n");
    } catch (err) {
      this.stderr.write(
        `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** Print a line to stdout. */
  println(line: string): void {
    this.stdout.write(`${line}\n`);
  }
}
