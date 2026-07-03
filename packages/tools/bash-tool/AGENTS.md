# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

`@timetickme/bash-tool` is a lightweight, pluggable bash command execution tool designed for AI agents. It provides a type-safe API for executing shell commands with support for timeout control, cancellation, streaming output, and output truncation.

## Development Commands

### Build & Clean
```bash
npm run build          # Compile TypeScript to dist/
npm run clean          # Remove dist/ directory
```

### Testing
```bash
npm test               # Run all tests once
npm run test:watch     # Run tests in watch mode
```

To run a single test file:
```bash
npx vitest run src/bash.test.ts
```

### Linting
```bash
npm run lint           # Check code with Biome
npm run lint:fix       # Auto-fix linting issues
```

## Architecture

### Core Design Pattern

The project uses a **Strategy Pattern** for command execution. The `BashOperations` interface (`src/types.ts`) defines the contract for execution backends, allowing the tool to swap between real shell execution and mock implementations for testing.

### Module Structure

**Entry Point**: `src/index.ts` - Re-exports all public APIs

**Core Implementation**: `src/bash.ts` - Contains `createBashTool()` factory function that:
- Creates a closure capturing configuration (cwd, operations, commandPrefix, spawnHook)
- Returns an async function that executes commands
- Handles output streaming with throttled updates (100ms default)
- Manages AbortSignal cancellation and timeout

**Operations (Strategy implementations)**:
- `src/operations/local.ts` - Real shell execution via `child_process.spawn()`
  - Spawns detached processes on Unix, handles process groups for cleanup
  - Validates working directory existence before execution
- `src/operations/mock.ts` - Test double with configurable responses, delays, and errors

**Utilities**:
- `src/utils/output.ts` - `OutputAccumulator` class for streaming output with automatic truncation (default: 1000 lines or 1MB). Creates temp files when output exceeds limits.
- `src/utils/shell.ts` - Platform-aware shell configuration, ANSI stripping, binary sanitization
- `src/utils/process.ts` - Process tree management (kill, wait, status check)

### Type System

All types are defined in `src/types.ts`:
- `BashToolFunction` - The main callable type: `(params, options?) => Promise<BashResult>`
- `BashOperations` - Pluggable execution backend interface
- `BashSpawnContext` / `BashSpawnHook` - Pre-execution command modification hooks
- `TruncationResult` - Detailed truncation metadata

### Key Implementation Details

1. **Output Throttling**: Updates are throttled to 100ms intervals to avoid overwhelming callbacks
2. **Truncation Strategy**: Keeps the *last* N lines/bytes (tail behavior), not the first
3. **Error Propagation**: Command output is prepended to error messages for debugging
4. **Process Cleanup**: Uses process groups (`-pid`) on Unix for reliable tree killing

For a detailed architecture overview, see [Architecture Documentation](docs/superpowers/specs/2026-07-03-bash-tool-architecture-design.md).

## Configuration

- **TypeScript**: ES2022 target, ESNext modules, strict mode enabled
- **Test Framework**: Vitest with Node environment, test files use `*.test.ts` suffix
- **Linter**: Biome (not ESLint)
- **Node Requirement**: >=18.0.0
