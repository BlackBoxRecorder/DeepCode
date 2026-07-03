# @pi-agent/fs-tool

Pluggable filesystem tools for AI agents.

## Overview

This package provides a set of filesystem tools that can be used in AI agent applications. The tools are designed to be framework-agnostic and can be used with any AI agent framework.

## Features

- **Pluggable Architecture**: Tools use a pluggable `FileOperations` interface, allowing you to swap out the underlying file system implementation
- **Framework Agnostic**: Tools can be used with any AI agent framework
- **Type Safe**: Written in TypeScript with full type definitions
- **Extensible**: Easy to add new tools or modify existing ones

## Installation

```bash
npm install @pi-agent/fs-tool
```

## Usage

### Basic Usage

```typescript
import { createLocalFileOperations, createReadTool, createWriteTool } from "@pi-agent/fs-tool";

// Create file operations
const operations = createLocalFileOperations();

// Create tools
const readTool = createReadTool(process.cwd(), operations);
const writeTool = createWriteTool(process.cwd(), operations);

// Use tools
const result = await readTool.execute({ path: "./file.txt" });
console.log(result.content);
```

### With Pi-Agent Framework

```typescript
import { createPiAgentReadTool, createPiAgentWriteTool } from "@pi-agent/fs-tool";
import { createLocalFileOperations } from "@pi-agent/fs-tool/core";

// Create file operations
const operations = createLocalFileOperations();

// Create pi-agent compatible tools
const readTool = createPiAgentReadTool(process.cwd(), operations);
const writeTool = createPiAgentWriteTool(process.cwd(), operations);

// Use tools with pi-agent
```

### Custom File Operations

```typescript
import { createReadTool } from "@pi-agent/fs-tool";
import type { FileOperations } from "@pi-agent/fs-tool/core";

// Custom file operations (e.g., for SSH)
const remoteOperations: FileOperations = {
  readFile: async (path) => {
    // Implement SSH file reading
    return Buffer.from("file content");
  },
  writeFile: async (path, content) => {
    // Implement SSH file writing
  },
  access: async (path) => {
    // Implement SSH file access check
  },
  mkdir: async (dir) => {
    // Implement SSH directory creation
  },
  stat: async (path) => {
    // Implement SSH file stat
    return { isDirectory: () => false };
  },
  readdir: async (path) => {
    // Implement SSH directory listing
    return [];
  },
  exists: async (path) => {
    // Implement SSH file existence check
    return true;
  },
};

// Create tool with custom operations
const readTool = createReadTool(process.cwd(), remoteOperations);
```

## API Reference

### Core Types

- `FileOperations`: Interface for file system operations
- `ToolDefinition`: Interface for tool definitions
- `ToolResult`: Interface for tool results
- `TruncationResult`: Interface for truncation results

### Core Functions

- `createLocalFileOperations()`: Create local file system operations
- `createReadOnlyFileOperations()`: Create read-only file system operations
- `createMockFileOperations()`: Create mock file system operations for testing

### Path Utilities

- `resolvePath()`: Resolve a path relative to a working directory
- `resolveToCwd()`: Resolve a path to a working directory
- `resolveReadPath()`: Resolve a read path with macOS-specific fallbacks
- `pathExists()`: Check if a path exists

### Truncation Utilities

- `truncateHead()`: Truncate content from the head
- `truncateTail()`: Truncate content from the tail
- `truncateLine()`: Truncate a single line
- `formatSize()`: Format bytes as human-readable size

### Adapters

#### Pi-Agent Adapter

- `createPiAgentReadTool()`: Create a pi-agent compatible read tool
- `createPiAgentWriteTool()`: Create a pi-agent compatible write tool
- `createPiAgentLsTool()`: Create a pi-agent compatible ls tool
- `createPiAgentToolFactory()`: Create a pi-agent tool factory

#### Standalone Adapter

- `createReadTool()`: Create a standalone read tool
- `createWriteTool()`: Create a standalone write tool
- `createLsTool()`: Create a standalone ls tool
- `createToolFactory()`: Create a standalone tool factory

## Architecture

The package is organized into three main modules:

1. **Core Module**: Contains framework-agnostic utilities and types
2. **Adapters Module**: Provides adapters for different frameworks
3. **Tools Module**: Re-exports adapters for convenience

### Core Module

The core module contains:

- **File Operations**: Pluggable file system operations
- **Path Utilities**: Path resolution and manipulation utilities
- **Truncation Utilities**: Content truncation utilities
- **Types**: TypeScript type definitions

### Adapters Module

The adapters module provides:

- **Pi-Agent Adapter**: Compatibility with the pi-agent framework
- **Standalone Adapter**: Simple interface for standalone usage

### Tools Module

The tools module re-exports adapters for convenience.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
