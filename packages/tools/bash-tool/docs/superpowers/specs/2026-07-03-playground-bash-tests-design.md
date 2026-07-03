# Playground Bash Commands Test Suite Design

## Overview

Create a set of standalone exploration scripts in `tests/playground/` that exercise common bash commands through the `@timetickme/bash-tool` API. Each command gets its own file, with a shared helper module for consistent setup and output formatting.

## Goals

- Validate bash-tool API behavior across diverse command categories
- Provide runnable examples for developers to explore and learn
- Cover common bash commands: file operations, networking, version control, text processing

## Constraints

- Scripts only create files/directories within `tests/playground/`
- No cleanup required (artifacts stay in playground)
- Standalone scripts run via `npx tsx`, not integrated into vitest

## File Structure

```
tests/playground/
├── helpers.ts          # Shared: bashTool creation, output formatting
├── index.ts            # Optional: run all tests sequentially
├── rm.ts               # File deletion
├── mv.ts               # File move/rename
├── cp.ts               # File copy
├── mkdir.ts            # Directory creation
├── curl.ts             # HTTP requests
├── wget.ts             # File download
├── git.ts              # Version control
├── sed.ts              # Stream editor
├── awk.ts              # Text processing
└── grep.ts             # Pattern search
```

## helpers.ts Design

```typescript
import { createBashTool } from "../../src/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Playground directory path - all operations constrained here */
export const PLAYGROUND_DIR = __dirname;

/** Create bashTool pointing to playground directory */
export function createPlaygroundBashTool() {
  return createBashTool(PLAYGROUND_DIR);
}

/** Run command and print formatted result */
export async function run(command: string, label?: string) {
  const bashTool = createPlaygroundBashTool();
  const tag = label ? `[${label}]` : "";
  console.log(`\n${tag} $ ${command}`);
  console.log("─".repeat(40));

  try {
    const result = await bashTool({ command });
    console.log(result.content[0].text);
    console.log(`✓ exit code: ${result.details?.exitCode ?? 0}`);
  } catch (err: any) {
    console.error(err.message);
    console.log("✗ command failed (see output above)");
  }
}
```

**Exported APIs:**
- `PLAYGROUND_DIR` - absolute path constant for commands requiring explicit paths
- `createPlaygroundBashTool()` - factory wrapping `createBashTool` with playground cwd
- `run(command, label?)` - execute command, print separator, handle success/failure, display exit code

## Command File Pattern

Each file follows this structure:

```typescript
import { run } from "./helpers.js";

(async () => {
  // === Setup ===
  // Create temporary test artifacts

  // === Success scenarios ===
  // Test normal command behavior

  // === Error scenarios (1-2 per file) ===
  // Test expected failure modes
})();
```

**Naming convention:** Temporary files/directories use `_test_` prefix for easy identification.

## Command Test Matrix

### rm.ts - File Deletion
- Delete single file
- Recursive directory deletion (`rm -rf`)
- Error: delete nonexistent file

### mv.ts - File Move/Rename
- Move file to new location
- Rename file in same directory
- Move with overwrite

### cp.ts - File Copy
- Copy single file
- Recursive directory copy (`cp -r`)
- Error: copy to existing file without force

### mkdir.ts - Directory Creation
- Create single directory
- Create nested directories (`mkdir -p`)
- Error: create already-existing directory

### curl.ts - HTTP Requests
- GET request to httpbin.org
- Save response to file
- Error: invalid URL

### wget.ts - File Download
- Download file from URL
- Download to specific directory
- Error: download nonexistent resource

> **Note:** `wget` is not installed on macOS by default. Install via `brew install wget` or replace with `curl -O` equivalent if unavailable.

### git.ts - Version Control
- Full workflow: init → add → commit → status → log
- Branch creation and switching
- Error: commit without staging

### sed.ts - Stream Editor
- Text substitution
- Regex pattern matching
- In-place file editing

### awk.ts - Text Processing
- Field extraction
- Conditional filtering
- Built-in variables (NR, NF)

### grep.ts - Pattern Search
- Basic pattern matching
- Recursive directory search
- Count mode (`grep -c`)

## Running

```bash
# Single command
npx tsx tests/playground/rm.ts

# All commands
npx tsx tests/playground/index.ts
```

## index.ts

```typescript
import "./rm.js";
import "./mv.js";
import "./cp.js";
import "./mkdir.js";
import "./curl.js";
import "./wget.js";
import "./git.js";
import "./sed.js";
import "./awk.js";
import "./grep.js";
```
