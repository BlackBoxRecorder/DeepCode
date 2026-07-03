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
// Command handlers
// ============================================================================

function printHelp(): void {
  console.log("Available commands:");
  console.log("  /help    - Show this help message");
  console.log("  /reset   - Start a new conversation");
  console.log("  /tools   - List available tools");
  console.log("  /exit    - Exit the program");
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

    case "/reset":
      console.log("Conversation reset. (Start a new session)");
      return true;

    default:
      console.log(`Unknown command: ${cmd}`);
      console.log("Type /help to see available commands.");
      return true;
  }
}

async function handleChat(input: string): Promise<void> {
  process.stdout.write("Thinking...");
  try {
    const result = await agent.run(input);

    // Clear the "Thinking..." line
    process.stdout.write("\r\x1b[K");

    if (result.toolCalls.length > 0) {
      console.log(`\n[Used ${result.toolCalls.length} tool(s)]`);
      for (const call of result.toolCalls) {
        const status = call.result.success ? "✓" : "✗";
        console.log(`  ${status} ${call.tool}`);
      }
      console.log();
    }

    console.log(result.content || "(no response)");
  } catch (err) {
    process.stdout.write("\r\x1b[K");
    console.error("Error:", err instanceof Error ? err.message : String(err));
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
