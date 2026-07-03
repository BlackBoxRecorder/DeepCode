# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

`@pi-agent/fs-tool` is a pluggable filesystem tools library for AI agents. It provides read, write, edit, ls, grep, and find operations with a swappable `FileOperations` interface, enabling use with local filesystems, SSH, mock backends, or any custom I/O layer.

## Commands

```bash
# Build (TypeScript → dist/)
npm run build

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint check
npm run lint

# Lint with auto-fix
npm run lint:fix
```

Linting uses **Biome** (not ESLint/Prettier). Tests use **Vitest** with `globals: true` in `node` environment. No test files (`*.test.ts`) currently exist — `src/test.ts` is a manual smoke-test script, not a Vitest test suite.

## Architecture

### Module Layout

```
src/
├── core/           # Framework-agnostic primitives
│   ├── types.ts        # FileOperations, ToolDefinition, TruncationResult, tool input types
│   ├── file-operations.ts  # createLocalFileOperations, createReadOnlyFileOperations, createMockFileOperations
│   ├── path-utils.ts   # Path resolution with macOS screenshot/NFD/curly-quote fallbacks
│   ├── truncate.ts     # truncateHead (file reads), truncateTail (bash output), truncateLine (grep matches)
│   └── edit-diff.ts    # Fuzzy text matching, unified diff generation, BOM/line-ending handling
├── adapters/       # Framework-specific tool factories
│   ├── pi-agent.ts     # Tools returning PiAgentToolResult (for @pi-agent framework)
│   └── standalone.ts   # Tools returning ToolResult (framework-agnostic)
└── tools/          # Thin re-export layer → ../adapters/
```

### Key Design: Pluggable FileOperations

The `FileOperations` interface (`src/core/types.ts`) is the central abstraction. All tools accept it as a parameter, defaulting to `createLocalFileOperations()`. To target remote or virtual filesystems, implement this interface:

```typescript
interface FileOperations {
  readFile(absolutePath: string): Promise<Buffer>;
  writeFile(absolutePath: string, content: string): Promise<void>;
  access(absolutePath: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  stat(absolutePath: string): Promise<{ isDirectory: () => boolean }>;
  readdir(absolutePath: string): Promise<string[]>;
  exists(absolutePath: string): Promise<boolean>;
}
```

The edit tool uses a narrower `EditOperations` interface (only `readFile`, `writeFile`, `access`).

### Two Adapter Families

| Adapter | Return type | Use case |
|---------|-------------|----------|
| **Pi-Agent** (`createPiAgent*Tool`) | `PiAgentToolResult` | Integration with the pi-agent framework |
| **Standalone** (`create*Tool`) | `ToolResult` / `ToolDefinition` | Framework-agnostic usage |

Both families share the same core logic. Each adapter has a factory function (`createPiAgentToolFactory` / `createToolFactory`) that produces all tools bound to a `cwd`.

### Tool Suite

| Tool | External dependency | Notes |
|------|---------------------|-------|
| **read** | — | Truncates to 2000 lines / 50KB; supports `offset`/`limit` for pagination |
| **write** | — | Auto-creates parent directories |
| **edit** | `diff` (npm) | Exact-text replacement with fuzzy Unicode matching; validates uniqueness |
| **ls** | — | 500 entry limit; alphabetical, case-insensitive |
| **grep** | `ripgrep` (rg) | Spawns `rg --json` subprocess; 100 match limit |
| **find** | `fd` | Spawns `fd` subprocess; 1000 result limit |

### Edit-Diff Pipeline (`src/core/edit-diff.ts`)

The edit tool applies replacements through this pipeline:
1. Strip BOM, detect line endings, normalize to LF
2. `fuzzyFindText` — try exact `indexOf`, then NFKC-normalized fuzzy match
3. Validate: empty oldText, uniqueness, overlap detection
4. Apply replacements (exact → direct string splice; fuzzy → `applyReplacementsPreservingUnchangedLines` to keep original line endings intact)
5. Restore BOM + original line endings, generate unified patch

### Path Resolution (`src/core/path-utils.ts`)

`resolveReadPath` / `resolveReadPathAsync` try multiple macOS-specific fallbacks when the initial path doesn't exist:
- Narrow no-break space before AM/PM in screenshot filenames
- NFD unicode normalization (macOS filesystem default)
- Curly quotes (U+2019) in localized screenshot names
- Combined NFD + curly quote variant

### Truncation Strategy (`src/core/truncate.ts`)

- **`truncateHead`**: Keeps first N lines/bytes. Used for file reads and ls output. Returns `firstLineExceedsLimit` flag when a single line exceeds the byte cap.
- **`truncateTail`**: Keeps last N lines/bytes. Used for bash output. May return partial first line as edge case.
- **`truncateLine`**: Clips a single grep match line to 500 chars with `... [truncated]` suffix.

## TypeScript Configuration

- Target: ES2022, module: ES2022, moduleResolution: node
- Strict mode enabled with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- All imports use `.js` extension (ESM output): `import { foo } from "./bar.js"`
- Declaration + declarationMap + sourceMap enabled for the published `dist/` output

## Package

- Published as `@pi-agent/fs-tool` with only `dist/` in the `files` array
- Entry point: `dist/index.js` (types: `dist/index.d.ts`)
- Single runtime dependency: `diff` (used for unified patch generation)
- External CLI tools `rg` (ripgrep) and `fd` are optional — grep/find tools will fail gracefully if absent
