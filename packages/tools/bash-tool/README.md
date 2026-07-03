# @timetickme/bash-tool

Lightweight, pluggable bash command execution tool for AI agents.

## Features

- **Lightweight**: No external dependencies, uses only Node.js standard library
- **Pluggable**: Supports custom shell execution backends
- **Type Safe**: Complete TypeScript type definitions
- **Easy to Test**: Provides mock execution backend for testing
- **Streaming Output**: Supports real-time output updates
- **Timeout Control**: Configurable command timeout
- **Cancellation**: Supports AbortSignal for cancelling commands
- **Output Truncation**: Automatic truncation with full output saving

## Installation

```bash
npm install @timetickme/bash-tool
```

## Quick Start

```typescript
import { createBashTool } from "@timetickme/bash-tool";

// Create a bash tool with working directory
const bashTool = createBashTool("/path/to/project");

// Execute a command
const result = await bashTool({ command: "ls -la" });
console.log(result.content[0].text);
```

## Usage

### Basic Usage

```typescript
import { createBashTool } from "@timetickme/bash-tool";

const cwd = "/path/to/project";
const bashTool = createBashTool(cwd);

// Execute simple command
const result = await bashTool({ command: "echo hello" });
console.log(result.content[0].text); // "hello"

// Execute with timeout
const resultWithTimeout = await bashTool({
  command: "npm install",
  timeout: 30, // 30 seconds
});
```

### Streaming Output

```typescript
const bashTool = createBashTool(cwd);

await bashTool(
  { command: "npm install" },
  {
    onUpdate: (result) => {
      console.log("Progress:", result.content[0].text);
    },
  }
);
```

### Cancellation

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  await bashTool(
    { command: "long-running-command" },
    { signal: controller.signal }
  );
} catch (error) {
  if (error.message.includes("aborted")) {
    console.log("Command was cancelled");
  }
}
```

### Custom Shell Backend

```typescript
import { createBashTool, createLocalBashOperations } from "@timetickme/bash-tool";

// Use custom shell
const ops = createLocalBashOperations({
  shellPath: "/bin/zsh",
  shellArgs: ["-c"],
});

const bashTool = createBashTool(cwd, { operations: ops });
```

### Testing with Mock

```typescript
import { createBashTool, createMockBashOperations } from "@timetickme/bash-tool";

// Create mock operations for testing
const mockOps = createMockBashOperations({
  defaultOutput: "mock output",
  defaultExitCode: 0,
});

const bashTool = createBashTool("/test", { operations: mockOps });
const result = await bashTool({ command: "test" });
// result.content[0].text will be "mock output"
```

## API Reference

### `createBashTool(cwd, options?)`

Creates a bash tool function.

**Parameters:**
- `cwd` (string): Working directory for command execution
- `options` (BashToolOptions): Optional configuration

**Returns:** `BashToolFunction`

### `BashToolOptions`

```typescript
interface BashToolOptions {
  operations?: BashOperations;  // Custom execution backend
  commandPrefix?: string;       // Prefix for every command
  shellPath?: string;           // Custom shell path
  spawnHook?: BashSpawnHook;    // Hook to modify spawn context
}
```

### `BashParams`

```typescript
interface BashParams {
  command: string;    // Command to execute
  timeout?: number;   // Timeout in seconds
}
```

### `BashResult`

```typescript
interface BashResult {
  content: ContentItem[];  // Output content
  details?: BashDetails;   // Execution details
  terminate?: boolean;     // Hint to stop after this tool
}
```

### `BashDetails`

```typescript
interface BashDetails {
  exitCode: number | null;   // Process exit code
  truncated?: boolean;       // Whether output was truncated
  fullOutputPath?: string;   // Path to full output file
  cancelled?: boolean;       // Whether command was cancelled
}
```

## Examples

### Example 1: Simple Command Execution

```typescript
import { createBashTool } from "@timetickme/bash-tool";

const bash = createBashTool(process.cwd());

async function main() {
  const result = await bash({ command: "node --version" });
  console.log("Node version:", result.content[0].text);
}

main();
```

### Example 2: Command with Progress Updates

```typescript
import { createBashTool } from "@timetickme/bash-tool";

const bash = createBashTool(process.cwd());

async function installPackages() {
  await bash(
    { command: "npm install" },
    {
      onUpdate: (result) => {
        process.stdout.write(".");
      },
    }
  );
  console.log("\nInstallation complete!");
}
```

### Example 3: Command with Timeout

```typescript
import { createBashTool } from "@timetickme/bash-tool";

const bash = createBashTool(process.cwd());

async function runTests() {
  try {
    const result = await bash({
      command: "npm test",
      timeout: 60, // 1 minute timeout
    });
    console.log("Tests passed!");
  } catch (error) {
    if (error.message.includes("timeout")) {
      console.error("Tests timed out!");
    }
  }
}
```

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## Building

```bash
# Build the package
npm run build

# Clean build artifacts
npm run clean
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

For detailed architecture and implementation details, see [Architecture Documentation](docs/superpowers/specs/2026-07-03-bash-tool-architecture-design.md).

## License

MIT

## Acknowledgments

This implementation is based on the bash tool from the [pi-main](../../pi-main) project.
