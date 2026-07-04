/**
 * Tests for ConversationCoordinator — turn execution and session persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../src/index.js";
import { AgentMode, ReActRunner } from "../../src/runner/index.js";
import { SessionManager } from "../../src/session.js";
import { ConversationCoordinator } from "../../src/coordinator.js";
import type {
  LLMClient,
  LLMStreamChunk,
  Message,
} from "../../src/llm/index.js";
import type { Tool, ToolResult } from "../../src/tool-interface/index.js";
import type { AgentStreamEvent } from "../../src/index.js";

// ============================================================================
// Mock LLM Client — returns a tool call response, then a final text response
// ============================================================================

/**
 * Creates a mock LLM client that first responds with a tool call,
 * then (if re-invoked) responds with a plain text message.
 */
function createMockLLMWithToolCall(
  toolName: string,
  toolArgs: Record<string, any> = {},
): LLMClient {
  let callCount = 0;

  async function* chatStream(
    _messages: Message[],
    _tools?: any[],
  ): AsyncGenerator<LLMStreamChunk> {
    callCount++;
    if (callCount === 1) {
      // First call: respond with a tool call
      yield {
        delta: {},
        finish_reason: "tool_calls",
        accumulated: {
          content: null,
          tool_calls: [
            {
              id: "call_001",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(toolArgs),
              },
            },
          ],
          finish_reason: "tool_calls",
        },
      };
    } else {
      // Second call: respond with plain text (tool result received)
      yield {
        delta: {},
        finish_reason: "stop",
        accumulated: {
          content: "Done after tool call.",
          tool_calls: undefined,
          finish_reason: "stop",
        },
      };
    }
  }

  return {
    chat: async () => ({
      content: "mock response",
      finish_reason: "stop",
    }),
    chatStream,
  };
}

/**
 * Creates a mock LLM client that throws on first call.
 */
function createThrowingMockLLM(errorMsg: string): LLMClient {
  async function* chatStream(): AsyncGenerator<LLMStreamChunk> {
    throw new Error(errorMsg);
  }

  return {
    chat: async () => {
      throw new Error(errorMsg);
    },
    chatStream,
  };
}

/**
 * Creates a mock LLM client whose first response contains the
 * [UPGRADE_TO_PLAN] marker, triggering an auto-upgrade signal.
 */
function createMockLLMWithUpgradeSignal(): LLMClient {
  async function* chatStream(): AsyncGenerator<LLMStreamChunk> {
    yield {
      delta: {},
      finish_reason: "stop",
      accumulated: {
        content:
          "[UPGRADE_TO_PLAN] This task requires multiple steps and would benefit from planning.",
        tool_calls: undefined,
        finish_reason: "stop",
      },
    };
  }

  return {
    chat: async () => ({
      content: "[UPGRADE_TO_PLAN] This task requires multiple steps.",
      finish_reason: "stop",
    }),
    chatStream,
  };
}

/**
 * Creates a mock LLM client that responds with a simple text message
 * (no upgrade signal).
 */
function createMockLLMWithTextResponse(content: string): LLMClient {
  async function* chatStream(): AsyncGenerator<LLMStreamChunk> {
    yield {
      delta: {},
      finish_reason: "stop",
      accumulated: {
        content,
        tool_calls: undefined,
        finish_reason: "stop",
      },
    };
  }

  return {
    chat: async () => ({
      content,
      finish_reason: "stop",
    }),
    chatStream,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Consume all events from a turn execution, catching errors as events. */
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

/** Verify no orphaned meta: every .meta.json must have a .jsonl with ≥ 1 turn. */
async function assertNoOrphanedMeta(
  dir: string,
  sessionManager: SessionManager,
): Promise<void> {
  const files = await fs.readdir(dir);
  const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  // Every meta file must have a corresponding jsonl
  for (const mf of metaFiles) {
    const sessionId = mf.replace(".meta.json", "");
    const expectedJsonl = `${sessionId}.jsonl`;
    expect(
      jsonlFiles.includes(expectedJsonl),
      `meta ${mf} should have corresponding ${expectedJsonl}`,
    ).toBe(true);
  }

  // No sessions with 0 turns
  const sessions = await sessionManager.listSessions();
  for (const s of sessions) {
    expect(
      s.turnCount,
      `session ${s.id} should have > 0 turns`,
    ).toBeGreaterThan(0);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("ConversationCoordinator", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `deepcode-coord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionManager = new SessionManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // Fix 1: tool throws → agent catches it → turn saved normally
  // ====================================================================

  it("should save turn when tool throws (agent catches exception)", async () => {
    const throwingTool: Tool = {
      name: "crashing_tool",
      description: "A tool that always throws",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "any input" },
        },
        required: ["input"],
      },
      async execute(_params: Record<string, any>): Promise<ToolResult> {
        throw new Error("BOOM — tool crashed!");
      },
    };

    const mockLLM = createMockLLMWithToolCall("crashing_tool", {
      input: "test",
    });

    const agent = new Agent({
      llm: mockLLM,
      tools: [throwingTool],
    });

    const runner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Hello, crash me!");

    // Tool should have reported error (not thrown)
    const toolResultEvent = events.find((e: any) => e.type === "tool_result");
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent.result.success).toBe(false);
    expect(toolResultEvent.result.error).toContain("BOOM");

    // Turn should complete normally (done event)
    const doneEvent = events.find((e: any) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // No orphaned meta
    await assertNoOrphanedMeta(tmpDir, sessionManager);
  });

  // ====================================================================
  // Fix 2: LLM throws → coordinator saves error turn (safety net)
  // ====================================================================

  it("should save error turn when LLM throws (coordinator safety net)", async () => {
    const mockLLM = createThrowingMockLLM(
      "LLM API error: 500 Internal Server Error",
    );

    const agent = new Agent({
      llm: mockLLM,
      tools: [],
    });

    const runner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Hello!");

    // Should get agent_error event (not raw error)
    const agentErrorEvent = events.find((e: any) => e.type === "agent_error");
    expect(agentErrorEvent).toBeDefined();
    expect(agentErrorEvent.error).toContain("LLM API error");

    // No orphaned meta — error turn was saved
    await assertNoOrphanedMeta(tmpDir, sessionManager);

    // Verify the saved turn contains error info
    const sessions = await sessionManager.listSessions();
    expect(sessions.length).toBe(1);
    const messages = await sessionManager.loadMessages(sessions[0].id);
    expect(messages.length).toBeGreaterThan(0);
    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("Agent error");
  });

  // ====================================================================
  // Normal flow: turn saved correctly
  // ====================================================================

  it("should save turn correctly when tool executes normally", async () => {
    const normalTool: Tool = {
      name: "normal_tool",
      description: "A normal tool that works",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "any input" },
        },
        required: ["input"],
      },
      async execute(_params: Record<string, any>): Promise<ToolResult> {
        return { success: true, output: "Tool worked!" };
      },
    };

    const mockLLM = createMockLLMWithToolCall("normal_tool", { input: "test" });

    const agent = new Agent({
      llm: mockLLM,
      tools: [normalTool],
    });

    const runner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
    });

    const events = await consumeTurn(coordinator, "Hello, use tool!");

    const hasError = events.some((e: any) => e.type === "error");
    expect(hasError).toBe(false);

    await assertNoOrphanedMeta(tmpDir, sessionManager);
  });

  // ====================================================================
  // Auto-upgrade: ReAct → Plan-Execute
  // ====================================================================

  it("ReActRunner should emit upgrade_requested when LLM returns [UPGRADE_TO_PLAN]", async () => {
    const mockLLM = createMockLLMWithUpgradeSignal();

    const agent = new Agent({
      llm: mockLLM,
      tools: [],
    });

    const runner = new ReActRunner(agent);

    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Build a full-stack app with auth." },
    ];

    const events: AgentStreamEvent[] = [];
    for await (const event of runner.run(messages)) {
      events.push(event);
    }

    // Should contain upgrade_requested
    const upgradeEvent = events.find((e) => e.type === "upgrade_requested");
    expect(upgradeEvent).toBeDefined();
    expect(upgradeEvent!.type).toBe("upgrade_requested");

    // Should contain done after upgrade
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("ReActRunner should NOT emit upgrade_requested for simple queries", async () => {
    const mockLLM = createMockLLMWithTextResponse(
      "TypeScript is a typed superset of JavaScript developed by Microsoft.",
    );

    const agent = new Agent({
      llm: mockLLM,
      tools: [],
    });

    const runner = new ReActRunner(agent);

    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is TypeScript?" },
    ];

    const events: AgentStreamEvent[] = [];
    for await (const event of runner.run(messages)) {
      events.push(event);
    }

    // Should NOT contain upgrade_requested
    const upgradeEvent = events.find((e) => e.type === "upgrade_requested");
    expect(upgradeEvent).toBeUndefined();

    // Should contain a normal done event
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("Coordinator should emit upgrade_notice and switch runner when upgrade is detected", async () => {
    // The ReAct LLM returns upgrade signal
    const reactLLM = createMockLLMWithUpgradeSignal();

    // The Plan-Execute planner LLM returns a plan
    const plannerLLM = createMockLLMWithTextResponse(
      JSON.stringify({
        tasks: [
          { id: "1", goal: "Create the project structure" },
          { id: "2", goal: "Implement authentication" },
        ],
      }),
    );

    const agent = new Agent({
      llm: reactLLM,
      tools: [],
    });

    const runner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
      llm: plannerLLM,
      agent,
    });

    const events = await consumeTurn(
      coordinator,
      "Build a full-stack app with auth.",
    );

    // Should have upgrade_notice
    const upgradeNotice = events.find((e: any) => e.type === "upgrade_notice");
    expect(upgradeNotice).toBeDefined();
    expect(upgradeNotice!.from).toBe(AgentMode.react);
    expect(upgradeNotice!.to).toBe(AgentMode.plan);

    // Should eventually complete with done
    const doneEvent = events.find((e: any) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Coordinator should now be in plan-execute mode
    expect(coordinator.currentMode).toBe(AgentMode.plan);

    await assertNoOrphanedMeta(tmpDir, sessionManager);
  });

  it("should NOT auto-upgrade when already in plan-execute mode", async () => {
    // Create coordinator in plan-execute mode
    const mockLLM = createMockLLMWithTextResponse("Task completed.");

    const agent = new Agent({
      llm: mockLLM,
      tools: [],
    });

    const runner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner,
      sessionManager,
      llm: mockLLM,
      agent,
    });

    // Switch to plan-execute first
    await coordinator.setMode(AgentMode.plan);

    // The plan-execute runner should NOT trigger another upgrade
    const events = await consumeTurn(
      coordinator,
      "Build a full-stack app with auth.",
    );

    // No upgrade_notice should be present
    const upgradeNotice = events.find((e: any) => e.type === "upgrade_notice");
    expect(upgradeNotice).toBeUndefined();
  });
});
