/**
 * DisplayRenderer — renders Agent stream events to terminal output.
 *
 * Decouples display logic from the CLI event loop and delegates
 * mode-specific rendering to per-runner RenderingAdapter instances.
 * The renderer itself only handles lifecycle events (session, error, upgrade).
 */
import type { TurnEvent } from "../coordinator.js";
import { getAdapterForMode, type RenderContext } from "./rendering-adapter.js";

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
   *
   * @param events - Async generator of TurnEvents from the coordinator.
   * @param mode - The current Agent Loop mode.
   */
  async renderTurn(
    events: AsyncGenerator<TurnEvent, void>,
    mode: string = "react",
  ): Promise<void> {
    const adapter = getAdapterForMode(mode);

    const ctx: RenderContext = {
      stdout: this.stdout,
      stderr: this.stderr,
      hasShownReasoningInRound: false,
      totalToolCalls: 0,
    };

    try {
      for await (const event of events) {
        // Lifecycle events — handled directly by the renderer.
        if (event.type === "session_created") {
          this.stdout.write(`[Session ${event.sessionId.slice(0, 8)}] `);
          continue;
        }
        if (event.type === "save_error") {
          this.stderr.write(`\n[Session save error: ${event.error}]\n`);
          continue;
        }
        if (event.type === "agent_error") {
          this.stderr.write(`\n[Agent error: ${event.error}]\n`);
          continue;
        }
        if (event.type === "upgrade_notice") {
          this.stdout.write(`\n[${event.reason}]\n`);
          continue;
        }

        // Mode-specific events → delegate to the rendering adapter.
        adapter.handleEvent(event, ctx);
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
