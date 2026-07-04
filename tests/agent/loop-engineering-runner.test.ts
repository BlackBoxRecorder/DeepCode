/**
 * Tests for LoopEngineeringRunner — verification, retry, and no-progress detection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../src/index.js";
import type { AgentStreamEvent, AgentResult } from "../../src/index.js";
import { SessionManager } from "../../src/session.js";
import { ConversationCoordinator } from "../../src/coordinator.js";
import { LoopEngineeringRunner } from "../../src/runner/index.js";
import type {
  LLMClient,
  LLMStreamChunk,
  LLMResponse,
  Message,
} from "../../src/llm/index.js";
import type { Tool } from "../../src/tool-interface/index.js";

// ============================================================================
// Mock LLM — multi-role responder
// ============================================================================

/**
 * Creates a mock LLM that returns different responses depending on the
 * system prompt content, allowing us to simulate planner, agent execution,
 * and verifier calls with a single mock instance.
 */
interface MockBehavior {
  /** Planner returns this JSON (plan). */
  planJson: string;
  /** Agent returns this content for each task execution. */
  agentResponse: string;
  /** Verifier returns this JSON for a given attempt (uses array, cycles through). */
  verifierResponses: string[];
}

function createMockLLM(behavior: MockBehavior): LLMClient {
  let callIndex = 0;
  let verifierCallIndex = 0;

  async function* chatStream(
    messages: Message[],
    _tools?: any[],
  ): AsyncGenerator<LLMStreamChunk> {
    callIndex++;

    const systemContent =
      messages.find((m) => m.role === "system")?.content ?? "";
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";

    let responseContent: string;

    if (
      systemContent.includes("task planner") ||
      systemContent.includes("You are a task planner")
    ) {
      // Planner call
      responseContent = behavior.planJson;
    } else if (
      systemContent.includes("verification evaluator") ||
      systemContent.includes("verification")
    ) {
      // Verifier call
      const idx = verifierCallIndex % behavior.verifierResponses.length;
      responseContent = behavior.verifierResponses[idx];
      verifierCallIndex++;
    } else {
      // Agent execution call
      responseContent = behavior.agentResponse;
    }

    yield {
      delta: { content: responseContent },
      finish_reason: "stop",
      accumulated: {
        content: responseContent,
        finish_reason: "stop",
      },
    };
  }

  return {
    chat: async (
      messages: Message[],
      _tools?: any[],
      _options?: Record<string, unknown>,
    ): Promise<LLMResponse> => {
      // For verifier calls (chat, not stream)
      const systemContent =
        messages.find((m) => m.role === "system")?.content ?? "";
      if (
        systemContent.includes("verification evaluator") ||
        systemContent.includes("verification")
      ) {
        const idx = verifierCallIndex % behavior.verifierResponses.length;
        verifierCallIndex++;
        return {
          content: behavior.verifierResponses[idx],
          finish_reason: "stop",
        };
      }
      return {
        content: behavior.agentResponse,
        finish_reason: "stop",
      };
    },
    chatStream,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Consume all events from a turn execution. */
async function consumeTurn(
  coordinator: ConversationCoordinator,
  input: string,
): Promise<any[]> {
  const events: any[] = [];
  try {
    for await (const event of coordinator.executeTurn(input)) {
      events.push(event);
    }
  } catch (err) {
    events.push({ type: "error", error: err });
  }
  return events;
}

/** Simple no-op tool for the agent. */
const noopTool: Tool = {
  name: "noop",
  description: "Does nothing",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { success: true, output: "ok" };
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("LoopEngineeringRunner", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `deepcode-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionManager = new SessionManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // Flow 1: Verification passes on first attempt
  // ====================================================================

  it("should complete on first attempt when verification passes", async () => {
    const mockLLM = createMockLLM({
      planJson: JSON.stringify({
        tasks: [{ id: "1", goal: "Do the thing" }],
      }),
      agentResponse: "Task 1 completed successfully.",
      verifierResponses: [
        JSON.stringify({ passed: true, reason: "Goal achieved." }),
      ],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Do the thing");

    // Should have verification event
    const verificationEvent = events.find((e) => e.type === "verification");
    expect(verificationEvent).toBeDefined();
    expect(verificationEvent.passed).toBe(true);
    expect(verificationEvent.attempt).toBe(1);

    // Should have done event with success
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.result.success).toBe(true);

    // Should NOT have retry events
    const retryEvents = events.filter((e) => e.type === "loop_retry");
    expect(retryEvents.length).toBe(0);

    // Session should be persisted with verification records
    const sessions = await sessionManager.listSessions();
    expect(sessions.length).toBe(1);
  });

  // ====================================================================
  // Flow 2: Verification fails then passes on retry
  // ====================================================================

  it("should retry and pass when first verification fails", async () => {
    const mockLLM = createMockLLM({
      planJson: JSON.stringify({
        tasks: [{ id: "1", goal: "Optimize startup" }],
      }),
      agentResponse: "Made some optimizations.",
      verifierResponses: [
        // First verifier call: fail
        JSON.stringify({
          passed: false,
          reason: "Startup time still above 200ms.",
          suggestion: "Try code splitting.",
        }),
        // Second verifier call: pass
        JSON.stringify({
          passed: true,
          reason: "Startup time is now under 200ms.",
        }),
      ],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Optimize startup");

    // First verification: fail
    const verifications = events.filter((e) => e.type === "verification");
    expect(verifications.length).toBe(2);
    expect(verifications[0].passed).toBe(false);
    expect(verifications[0].attempt).toBe(1);

    // Should have retry event
    const retryEvents = events.filter((e) => e.type === "loop_retry");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[0].reason).toContain("Startup time");

    // Second verification: pass
    expect(verifications[1].passed).toBe(true);
    expect(verifications[1].attempt).toBe(2);

    // Done event should be success
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.result.success).toBe(true);
  });

  // ====================================================================
  // Flow 3: Max retries exhausted (all verifications fail)
  // ====================================================================

  it("should exhaust retries and return failure when all verifications fail", async () => {
    // Use distinct failure messages to avoid triggering no-progress detection
    const mockLLM = createMockLLM({
      planJson: JSON.stringify({
        tasks: [{ id: "1", goal: "Do something complex" }],
      }),
      agentResponse: "Attempted the task.",
      verifierResponses: [
        JSON.stringify({
          passed: false,
          reason: "Not good enough — attempt 1.",
          suggestion: "Try approach A.",
        }),
        JSON.stringify({
          passed: false,
          reason: "Still failing — attempt 2.",
          suggestion: "Try approach B.",
        }),
        JSON.stringify({
          passed: false,
          reason: "Nope — attempt 3.",
          suggestion: "Try approach C.",
        }),
        JSON.stringify({
          passed: false,
          reason: "Last try failed — attempt 4.",
          suggestion: "Give up.",
        }),
      ],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Do something complex");

    // All verifications should fail
    const verifications = events.filter((e) => e.type === "verification");
    expect(verifications.length).toBeGreaterThanOrEqual(3);
    for (const v of verifications) {
      expect(v.passed).toBe(false);
    }

    // Should have retry events for each attempt
    const retryEvents = events.filter((e) => e.type === "loop_retry");
    expect(retryEvents.length).toBeGreaterThanOrEqual(3);

    // Done event should be failure
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.result.success).toBe(false);
    expect(doneEvent.result.content).toContain("exhausted");
  });

  // ====================================================================
  // Flow 4: No-progress detection
  // ====================================================================

  it("should terminate early on no-progress detection (identical verifications)", async () => {
    const identicalFailVerification = JSON.stringify({
      passed: false,
      reason: "The result is exactly the same as before.",
      suggestion: "Maybe we need external help.",
    });

    const mockLLM = createMockLLM({
      planJson: JSON.stringify({
        tasks: [{ id: "1", goal: "Do something stuck" }],
      }),
      agentResponse: "Did the same thing again.",
      verifierResponses: [
        // First: a different failure (to establish baseline)
        JSON.stringify({
          passed: false,
          reason: "Not good enough.",
          suggestion: "Try harder.",
        }),
        // Second: identical to the next one
        identicalFailVerification,
        // Third: identical to the second
        identicalFailVerification,
        // Extra (should not reach)
        JSON.stringify({ passed: true, reason: "ok" }),
      ],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Do something stuck");

    const verifications = events.filter((e) => e.type === "verification");
    // Should have made at most 3 verifications (initial + 2 identical)
    expect(verifications.length).toBeLessThanOrEqual(3);

    // Done event should mention no-progress
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.result.content).toContain("no progress");

    // Should have a retry event mentioning no-progress
    const retryEvents = events.filter((e) => e.type === "loop_retry");
    const noProgressEvent = retryEvents.find((e) =>
      e.reason.includes("No progress"),
    );
    expect(noProgressEvent).toBeDefined();
  });

  // ====================================================================
  // Flow 5: Plan generation failure
  // ====================================================================

  it("should handle plan generation failure gracefully", async () => {
    const mockLLM = createMockLLM({
      planJson: "not valid json at all {{{",
      agentResponse: "irrelevant",
      verifierResponses: ["irrelevant"],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Do something");

    // Should still complete without throwing
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  // ====================================================================
  // Flow 6: TurnRecord includes verifications
  // ====================================================================

  it("should persist verification records in TurnRecord", async () => {
    const mockLLM = createMockLLM({
      planJson: JSON.stringify({
        tasks: [{ id: "1", goal: "Record test" }],
      }),
      agentResponse: "Task done.",
      verifierResponses: [
        JSON.stringify({
          passed: false,
          reason: "Nope.",
          suggestion: "Try X.",
        }),
        JSON.stringify({ passed: true, reason: "Yes!" }),
      ],
    });

    const agent = new Agent({ llm: mockLLM, tools: [noopTool] });
    const runner = new LoopEngineeringRunner(mockLLM, agent);
    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    await consumeTurn(coordinator, "Record test");

    const sessions = await sessionManager.listSessions();
    expect(sessions.length).toBe(1);

    // Read the raw JSONL to check verifications field
    const jsonlPath = path.join(tmpDir, `${sessions[0].id}.jsonl`);
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n");
    const lastTurn = JSON.parse(lines[lines.length - 1]);

    expect(lastTurn.verifications).toBeDefined();
    expect(Array.isArray(lastTurn.verifications)).toBe(true);
    expect(lastTurn.verifications.length).toBe(2);
    expect(lastTurn.verifications[0].passed).toBe(false);
    expect(lastTurn.verifications[0].reason).toBe("Nope.");
    expect(lastTurn.verifications[1].passed).toBe(true);
    expect(lastTurn.verifications[1].reason).toBe("Yes!");
  });
});
