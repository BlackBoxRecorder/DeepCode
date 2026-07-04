/**
 * Tests for PlanExecuteRunner — plan generation, task execution, event order.
 * Also tests Coordinator integration for plan-execute mode turn persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../src/index.js";
import { ReActRunner, PlanExecuteRunner } from "../../src/runner/index.js";
import { SessionManager } from "../../src/session.js";
import { ConversationCoordinator } from "../../src/coordinator.js";
import type {
  LLMClient,
  LLMResponse,
  LLMStreamChunk,
  Message,
} from "../../src/llm/index.js";
import type { Tool, ToolResult } from "../../src/tool-interface/index.js";
import type { Plan } from "../../src/index.js";

// ============================================================================
// Mock LLM Clients
// ============================================================================

/**
 * Creates a mock planner LLM that returns a JSON plan.
 */
function createMockPlannerLLM(planJson: string): LLMClient {
  return {
    chat: async (): Promise<LLMResponse> => ({
      content: planJson,
      finish_reason: "stop",
    }),
    chatStream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield {
        delta: {},
        finish_reason: "stop",
        accumulated: {
          content: planJson,
          finish_reason: "stop",
        },
      };
    },
  };
}

/**
 * Creates a mock agent LLM that returns a simple text response.
 */
function createMockAgentLLM(response: string): LLMClient {
  async function* chatStream(): AsyncGenerator<LLMStreamChunk> {
    yield {
      delta: {},
      finish_reason: "stop",
      accumulated: {
        content: response,
        finish_reason: "stop",
      },
    };
  }

  return {
    chat: async () => ({
      content: response,
      finish_reason: "stop",
    }),
    chatStream,
  };
}

/**
 * Creates a mock agent LLM that throws on call.
 */
function createThrowingAgentLLM(errorMsg: string): LLMClient {
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
 * Creates a mock agent LLM that first makes a tool call, then responds.
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
      yield {
        delta: {},
        finish_reason: "stop",
        accumulated: {
          content: "Done after tool call.",
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

// ============================================================================
// Helpers
// ============================================================================

/** A simple tool that always succeeds. */
function createEchoTool(): Tool {
  return {
    name: "echo",
    description: "Echo back the input",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo" },
      },
      required: ["message"],
    },
    async execute(params: Record<string, any>): Promise<ToolResult> {
      return { success: true, output: `Echo: ${params.message}` };
    },
  };
}

/** Collect all events from a runner run. */
async function collectRunnerEvents(
  runner: { run: (msgs: Message[]) => AsyncGenerator<any, any> },
  input: string,
) {
  const events: any[] = [];
  const messages: Message[] = [
    { role: "system", content: "Test system prompt" },
    { role: "user", content: input },
  ];
  try {
    for await (const event of runner.run(messages)) {
      events.push(event);
    }
  } catch (err) {
    events.push({ type: "error", error: err });
  }
  return events;
}

/** Collect TurnEvents from a coordinator turn. */
async function collectTurnEvents(
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

// ============================================================================
// Tests: PlanExecuteRunner
// ============================================================================

describe("PlanExecuteRunner", () => {
  // ------------------------------------------------------------------
  // Plan generation
  // ------------------------------------------------------------------

  it("should generate plan and emit plan_generated event", async () => {
    const planJson = JSON.stringify({
      tasks: [
        { id: "1", goal: "List all files in current directory" },
        { id: "2", goal: "Count the files" },
      ],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("Done!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(
      runner,
      "List and count all files",
    );

    const planGenEvent = events.find((e: any) => e.type === "plan_generated");
    expect(planGenEvent).toBeDefined();
    expect(planGenEvent.plan.tasks).toHaveLength(2);
    expect(planGenEvent.plan.tasks[0].goal).toBe(
      "List all files in current directory",
    );
  });

  it("should parse plan JSON wrapped in markdown code fences", async () => {
    const planJson =
      "```json\n" +
      JSON.stringify({
        tasks: [{ id: "1", goal: "Run a command" }],
      }) +
      "\n```";

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("Done!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(runner, "Run a command please");

    const planGenEvent = events.find((e: any) => e.type === "plan_generated");
    expect(planGenEvent).toBeDefined();
    expect(planGenEvent.plan.tasks).toHaveLength(1);
  });

  it("should fail gracefully when planner returns invalid JSON", async () => {
    const plannerLLM = createMockPlannerLLM("not json at all");
    const agentLLM = createMockAgentLLM("Done!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(runner, "Do something");

    const doneEvent = events.find((e: any) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.result.success).toBe(false);
    expect(doneEvent.result.content).toContain("Plan generation failed");
  });

  // ------------------------------------------------------------------
  // Task execution — events in order
  // ------------------------------------------------------------------

  it("should emit events in correct order: plan_generated → task_start → task_progress → task_done → plan_complete → done", async () => {
    const planJson = JSON.stringify({
      tasks: [{ id: "1", goal: "Echo hello" }],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("Task completed successfully.");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(runner, "Echo hello please");

    const eventTypes = events.map((e: any) => e.type);

    const planGenIdx = eventTypes.indexOf("plan_generated");
    const taskStartIdx = eventTypes.indexOf("task_start");
    const taskDoneIdx = eventTypes.indexOf("task_done");
    const planCompleteIdx = eventTypes.indexOf("plan_complete");
    const doneIdx = eventTypes.indexOf("done");

    expect(planGenIdx).toBeGreaterThan(-1);
    expect(taskStartIdx).toBeGreaterThan(planGenIdx);
    expect(taskDoneIdx).toBeGreaterThan(taskStartIdx);
    expect(planCompleteIdx).toBeGreaterThan(taskDoneIdx);
    expect(doneIdx).toBeGreaterThan(planCompleteIdx);
  });

  // ------------------------------------------------------------------
  // Task execution — task_progress wrapping
  // ------------------------------------------------------------------

  it("should wrap inner agent events in task_progress", async () => {
    const planJson = JSON.stringify({
      tasks: [{ id: "1", goal: "Use echo tool" }],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const toolLLM = createMockLLMWithToolCall("echo", {
      message: "hello",
    });
    const echoTool = createEchoTool();
    const agent = new Agent({ llm: toolLLM, tools: [echoTool] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(runner, "Use the echo tool");

    // Should have task_progress wrapping chunk/tool_result/done
    const taskProgressEvents = events.filter(
      (e: any) => e.type === "task_progress",
    );
    expect(taskProgressEvents.length).toBeGreaterThan(0);

    // At least one inner event should be a chunk or tool_result
    const innerEventTypes = taskProgressEvents.map((e: any) => e.event.type);
    expect(innerEventTypes).toContain("tool_result");
  });

  // ------------------------------------------------------------------
  // Task failure handling
  // ------------------------------------------------------------------

  it("should handle sub-task failure and continue", async () => {
    const planJson = JSON.stringify({
      tasks: [
        { id: "1", goal: "This will fail" },
        { id: "2", goal: "This will succeed" },
      ],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const failingLLM = createThrowingAgentLLM("Sub-task crash!");

    const agent = new Agent({ llm: failingLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    const events = await collectRunnerEvents(runner, "Do two things");

    const taskDoneEvents = events.filter((e: any) => e.type === "task_done");
    expect(taskDoneEvents.length).toBe(2);

    expect(taskDoneEvents[0].status).toBe("failed");
    expect(taskDoneEvents[1].status).toBe("failed"); // Agent crashes each time

    const doneEvent = events.find((e: any) => e.type === "done");
    expect(doneEvent.result.success).toBe(false);
  });

  // ------------------------------------------------------------------
  // AgentRunner interface compliance
  // ------------------------------------------------------------------

  it("should implement AgentRunner interface", () => {
    const plannerLLM = createMockPlannerLLM("{}");
    const agentLLM = createMockAgentLLM("ok");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    expect(runner.mode).toBe("plan-execute");
    expect(Array.isArray(runner.conversationMessages)).toBe(true);
    expect(typeof runner.systemPromptText).toBe("string");
    expect(typeof runner.setConversationMessages).toBe("function");
    expect(typeof runner.run).toBe("function");
  });

  it("should track conversation messages across runs", async () => {
    const planJson = JSON.stringify({
      tasks: [{ id: "1", goal: "Do one thing" }],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("All done!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const runner = new PlanExecuteRunner(plannerLLM, agent);

    await collectRunnerEvents(runner, "First request");
    expect(runner.conversationMessages.length).toBeGreaterThan(0);
    expect(runner.conversationMessages.some((m) => m.role === "user")).toBe(
      true,
    );
  });
});

// ============================================================================
// Tests: Coordinator in plan-execute mode
// ============================================================================

describe("ConversationCoordinator — plan-execute mode", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `deepcode-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionManager = new SessionManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Mode switching
  // ------------------------------------------------------------------

  it("should switch to plan-execute mode when configured", () => {
    const plannerLLM = createMockPlannerLLM("{}");
    const agentLLM = createMockAgentLLM("ok");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const reactRunner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner: reactRunner,
      sessionManager,
      llm: plannerLLM,
      agent,
    });

    expect(coordinator.currentMode).toBe("react");
    coordinator.setMode("plan-execute");
    expect(coordinator.currentMode).toBe("plan-execute");
  });

  it("should throw when switching to plan-execute without LLM/Agent config", () => {
    const agentLLM = createMockAgentLLM("ok");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const reactRunner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner: reactRunner,
      sessionManager,
    });

    expect(() => coordinator.setMode("plan-execute")).toThrow("not configured");
  });

  // ------------------------------------------------------------------
  // TurnRecord with plan/subTasks
  // ------------------------------------------------------------------

  it("should persist plan and subTasks in TurnRecord for plan-execute turns", async () => {
    const planJson = JSON.stringify({
      tasks: [
        { id: "1", goal: "First task" },
        { id: "2", goal: "Second task" },
      ],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("Task success!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const reactRunner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner: reactRunner,
      sessionManager,
      llm: plannerLLM,
      agent,
    });

    coordinator.setMode("plan-execute");
    const events = await collectTurnEvents(coordinator, "Do two things");

    // Verify no errors
    const errorEvents = events.filter(
      (e: any) => e.type === "agent_error" || e.type === "save_error",
    );
    expect(errorEvents.length).toBe(0);

    // Verify session persisted with plan data
    const sessions = await sessionManager.listSessions();
    expect(sessions.length).toBe(1);
    const messages = await sessionManager.loadMessages(sessions[0].id);
    expect(messages.length).toBeGreaterThan(0);

    // Read raw JSONL to check plan/subTasks fields
    const sessionId = sessions[0].id;
    const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const jsonlContent = await fs.readFile(jsonlPath, "utf-8");
    const turnRecord = JSON.parse(jsonlContent.trim().split("\n")[0]);

    expect(turnRecord.plan).toBeDefined();
    expect(turnRecord.plan.tasks).toHaveLength(2);
    expect(turnRecord.subTasks).toBeDefined();
    expect(turnRecord.subTasks).toHaveLength(2);
    expect(turnRecord.subTasks[0].taskId).toBe("1");
    expect(turnRecord.subTasks[0].goal).toBe("First task");
    expect(turnRecord.subTasks[0].status).toBe("done");
  });

  // ------------------------------------------------------------------
  // Event emission
  // ------------------------------------------------------------------

  it("should emit plan events through coordinator", async () => {
    const planJson = JSON.stringify({
      tasks: [{ id: "1", goal: "Do it" }],
    });

    const plannerLLM = createMockPlannerLLM(planJson);
    const agentLLM = createMockAgentLLM("Done!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const reactRunner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner: reactRunner,
      sessionManager,
      llm: plannerLLM,
      agent,
    });

    coordinator.setMode("plan-execute");
    const events = await collectTurnEvents(coordinator, "Do something");

    const eventTypes = events.map((e: any) => e.type);
    expect(eventTypes).toContain("plan_generated");
    expect(eventTypes).toContain("task_start");
    expect(eventTypes).toContain("task_progress");
    expect(eventTypes).toContain("task_done");
    expect(eventTypes).toContain("plan_complete");
    expect(eventTypes).toContain("done");
  });

  // ------------------------------------------------------------------
  // Backward compatibility
  // ------------------------------------------------------------------

  it("should load old ReAct session files without plan fields", async () => {
    // Create a coordinator in react mode and make a turn
    const agentLLM = createMockAgentLLM("Hello!");
    const agent = new Agent({ llm: agentLLM, tools: [] });
    const reactRunner = new ReActRunner(agent);

    const coordinator = new ConversationCoordinator({
      runner: reactRunner,
      sessionManager,
    });

    await collectTurnEvents(coordinator, "Hello react");

    const sessions = await sessionManager.listSessions();
    expect(sessions.length).toBe(1);

    // Read raw JSONL — should NOT have plan field
    const sessionId = sessions[0].id;
    const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const jsonlContent = await fs.readFile(jsonlPath, "utf-8");
    const turnRecord = JSON.parse(jsonlContent.trim().split("\n")[0]);

    expect(turnRecord.plan).toBeUndefined();
    expect(turnRecord.subTasks).toBeUndefined();

    // Load through sessionManager — should work fine
    const messages = await sessionManager.loadMessages(sessionId);
    expect(messages.length).toBeGreaterThan(0);
  });
});
