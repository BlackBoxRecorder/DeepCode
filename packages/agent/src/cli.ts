#!/usr/bin/env node
/**
 * deepCode CLI - terminal AI agent entry point.
 *
 * Usage:
 *   DEEPSEEK_API_KEY="your-key" node dist/cli.js
 * or:
 *   pnpm start
 */
import * as readline from "node:readline";
import { Agent } from "./index.js";
import { SessionManager, type TurnRecord } from "./session.js";
import type { Message } from "@timetickme/llm";
import { DeepSeekClient } from "@timetickme/llm";
import { createBashToolAsTool } from "@timetickme/bash-tool";
import { createAllFsTools } from "@timetickme/fs-tool";

// ============================================================================
// Configuration
// ============================================================================

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY environment variable is required.");
  console.error("Usage: DEEPSEEK_API_KEY='your-key' pnpm start");
  process.exit(1);
}

const CWD = process.cwd();

// ============================================================================
// Initialize Tools and Agent
// ============================================================================

const bashTool = createBashToolAsTool(CWD);
const fsTools = createAllFsTools(CWD);

const agent = new Agent({
  llm: new DeepSeekClient({
    apiKey: API_KEY,
  }),
  tools: [bashTool, ...fsTools],
  systemPrompt:
    "You are a helpful terminal AI agent. You have access to bash commands " +
    "and filesystem tools. When performing tasks, use tools to gather " +
    "information before responding. Be concise and direct.",
});

// ============================================================================
// Session State
// ============================================================================

const sessionManager = new SessionManager();

let currentSessionId: string | null = null;
let currentMessages: Message[] = [];

// ============================================================================
// Command handlers
// ============================================================================

function printHelp(): void {
  console.log("Available commands:");
  console.log("  /help       - Show this help message");
  console.log("  /new        - Start a new session");
  console.log("  /sessions   - List session history");
  console.log("  /continue <id> - Continue a previous session");
  console.log("  /tools      - List available tools");
  console.log("  /reset      - Same as /new");
  console.log("  /exit       - Exit the program");
  console.log();
  console.log("Any other input will be sent to the AI agent.");
}

function printTools(): void {
  const tools = [bashTool, ...fsTools];
  console.log("Available tools:");
  for (const tool of tools) {
    console.log(`  ${tool.name}: ${tool.description}`);
  }
}

async function handleCommand(input: string): Promise<boolean> {
  const cmd = input.trim();

  // /continue with session id
  if (cmd.startsWith("/continue ")) {
    const sessionId = cmd.slice("/continue ".length).trim();
    if (!sessionId) {
      console.log("Usage: /continue <session-id>");
      return true;
    }
    await handleContinue(sessionId);
    return true;
  }

  switch (cmd) {
    case "/help":
      printHelp();
      return true;

    case "/tools":
      printTools();
      return true;

    case "/exit":
      console.log("Goodbye!");
      process.exit(0);

    case "/new":
    case "/reset":
      handleNew();
      return true;

    case "/sessions":
      await handleSessions();
      return true;

    default:
      console.log(`Unknown command: ${cmd}`);
      console.log("Type /help to see available commands.");
      return true;
  }
}

async function handleSessions(): Promise<void> {
  const sessions = await sessionManager.listSessions();
  if (sessions.length === 0) {
    console.log("No session history.");
    return;
  }
  console.log("Session history:");
  for (const s of sessions) {
    const marker = s.id === currentSessionId ? "* " : "  ";
    const date = new Date(s.createdAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const title = s.title.padEnd(40, " ");
    console.log(
      `${marker}${s.id.slice(0, 8)}  [${date}]  ${title}  (${s.turnCount} turns)`,
    );
  }
}

async function handleContinue(sessionId: string): Promise<void> {
  const meta = await sessionManager.getSessionMeta(sessionId);
  if (!meta) {
    console.log(`Session "${sessionId.slice(0, 8)}" not found.`);
    return;
  }

  const messages = await sessionManager.loadMessages(sessionId);
  currentSessionId = sessionId;
  currentMessages = [
    { role: "system", content: agent.systemPromptText },
    ...messages,
  ];
  console.log(`Switched to session ${sessionId.slice(0, 8)}: ${meta.title}`);
}

function handleNew(): void {
  currentSessionId = null;
  currentMessages = [];
  console.log("New session started.");
}

async function handleChat(input: string): Promise<void> {
  // Auto-create session on first message
  if (currentSessionId === null) {
    const meta = await sessionManager.createSession(input);
    currentSessionId = meta.id;
    currentMessages = [{ role: "system", content: agent.systemPromptText }];
    process.stdout.write(`[Session ${meta.id.slice(0, 8)}] `);
  }

  // Record the number of messages before this turn (for saving later)
  const messagesBefore = currentMessages.length;

  // Append user message to shared list
  currentMessages.push({ role: "user", content: input });

  let hasShownReasoningInRound = false;
  let totalToolCalls = 0;

  try {
    for await (const event of agent.runWithMessages(currentMessages)) {
      switch (event.type) {
        case "chunk": {
          const { delta } = event.chunk;

          // Output reasoning content
          if (delta.reasoning_content) {
            if (!hasShownReasoningInRound) {
              process.stdout.write("\n[Thinking...]\n");
              hasShownReasoningInRound = true;
            }
            process.stdout.write(delta.reasoning_content);
          }

          // Output answer content, with separator if reasoning was shown
          if (delta.content) {
            if (hasShownReasoningInRound) {
              process.stdout.write("\n--- Answer ---\n");
              hasShownReasoningInRound = false;
            }
            process.stdout.write(delta.content);
          }
          break;
        }

        case "tool_result": {
          totalToolCalls++;
          const status = event.result.success ? "✓" : "✗";
          const paramsStr = JSON.stringify(event.params);
          process.stdout.write(`\n  ${status} ${event.tool} ${paramsStr}`);
          hasShownReasoningInRound = false;
          break;
        }

        case "done": {
          if (totalToolCalls > 0) {
            process.stdout.write(`\n[${totalToolCalls} tool(s) used]\n`);
          }
          break;
        }
      }
    }
    process.stdout.write("\n");
  } catch (err) {
    console.error("\nError:", err instanceof Error ? err.message : String(err));
    return;
  }

  // Save this turn to the session file
  const newMessages = currentMessages.slice(messagesBefore);
  if (newMessages.length > 0) {
    const turnRecord: TurnRecord = {
      type: "turn",
      timestamp: new Date().toISOString(),
      userInput: input,
      messages: newMessages,
    };
    try {
      await sessionManager.appendTurn(currentSessionId!, turnRecord);
    } catch (err) {
      console.error(
        "\n[Session save error:",
        err instanceof Error ? err.message : String(err),
        "]",
      );
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("deepCode - Terminal AI Agent");
  console.log("Type /help for commands, or just ask a question.");
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Check for commands (must be the entire line, starting with /)
    if (input.startsWith("/")) {
      await handleCommand(input);
    } else {
      await handleChat(input);
    }

    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
