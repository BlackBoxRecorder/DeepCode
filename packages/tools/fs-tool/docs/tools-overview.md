# 工具实现总览

本文档概述 `@pi-agent/fs-tool` 中所有工具的架构、核心概念和相互关系，面向库贡献者。

## 1. 工具架构

### 1.1 适配器模式

所有工具通过适配器层暴露，当前仅有 **Standalone 适配器**：

```
src/adapters/standalone.ts
├── createReadTool()
├── createWriteTool()
├── createEditTool()
├── createLsTool()
├── createGrepTool()
└── createFindTool()
```

每个工厂函数返回 `ToolDefinition`，包含：
- `name` / `label` / `description`：工具元信息
- `parameters`：JSON Schema 格式的参数定义
- `execute(params, signal?)`：执行函数

### 1.2 核心抽象：FileOperations

所有文件操作通过 `FileOperations` 接口抽象（`src/core/types.ts`）：

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

**三种实现**（`src/core/file-operations.ts`）：
| 实现 | 用途 |
|------|------|
| `createLocalFileOperations()` | 本地文件系统（默认） |
| `createReadOnlyFileOperations()` | 只读模式 |
| `createMockFileOperations()` | 测试用 Mock |

### 1.3 EditOperations 接口

Edit 工具使用更窄的接口（只需 `readFile`, `writeFile`, `access`）：

```typescript
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}
```

## 2. 工具对比

| 工具 | 核心依赖 | 截断策略 | 默认限制 | 外部依赖 |
|------|----------|----------|----------|----------|
| **read** | path-utils, truncate | 头部截断 | 2000 行 / 50KB | — |
| **write** | path-utils | 无 | — | — |
| **edit** | edit-diff | 无 | — | `diff` (npm) |
| **ls** | path-utils, truncate | 头部截断 | 500 条目 | — |
| **grep** | truncate | 行截断 + 头部截断 | 100 匹配 / 500 字符/行 | `rg` (ripgrep) |
| **find** | path-utils, truncate | 头部截断 | 1000 结果 | `fd` |

## 3. 核心模块关系

```
┌─────────────────────────────────────────────────────────────┐
│                      adapters/standalone.ts                 │
│  createReadTool / WriteTool / EditTool / ...                │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  path-utils   │    │   truncate    │    │   edit-diff   │
│  路径解析      │    │  截断策略      │    │  编辑管线      │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                   ┌───────────────────┐
                   │ file-operations   │
                   │  FileOperations   │
                   └───────────────────┘
```

### 3.1 path-utils.ts

**职责**：路径解析和 macOS 兼容性处理

**关键函数**：
- `resolveToCwd(path, cwd)`：基础路径解析
- `resolveReadPath(path, cwd)`：带 macOS 变体的同步解析
- `resolveReadPathAsync(path, cwd)`：异步版本

**macOS 变体处理**：
1. 尝试原始路径
2. AM/PM 变体（窄不间断空格 `\u202F`）
3. NFD Unicode 规范化
4. 弯引号变体（U+2019）
5. 组合变体（NFD + 弯引号）

### 3.2 truncate.ts

**职责**：输出截断，防止过大输出

**三种截断函数**：

| 函数 | 方向 | 用途 | 特点 |
|------|------|------|------|
| `truncateHead` | 保留开头 | read, ls, grep, find | 不返回部分行 |
| `truncateTail` | 保留结尾 | bash 输出 | 可能返回部分首行 |
| `truncateLine` | 截取前 N 字符 | grep 匹配行 | 添加 `... [truncated]` 后缀 |

**默认常量**：
- `DEFAULT_MAX_LINES` = 2000
- `DEFAULT_MAX_BYTES` = 50KB (50 * 1024)
- `GREP_MAX_LINE_LENGTH` = 500

### 3.3 edit-diff.ts

**职责**：文本匹配、替换和 diff 生成

**Edit-Diff 管线**：
```
原始内容
  → stripBom（剥离 BOM）
  → detectLineEnding（检测 CRLF/LF）
  → normalizeToLF（规范化）
  → applyEditsToNormalizedContent
      ├─ fuzzyFindText（精确 → 模糊匹配）
      ├─ 唯一性验证
      ├─ 重叠检测
      └─ 应用替换
  → restoreLineEndings（恢复原始换行符）
  → generateUnifiedPatch / generateDiffString
```

**模糊匹配**：
- 优先精确匹配（`indexOf`）
- 失败时 NFKC 规范化后匹配
- 处理智能引号、Unicode 空格、特殊破折号

### 3.4 file-operations.ts

**职责**：提供 `FileOperations` 接口的实现

**默认实现**（`createLocalFileOperations`）：
- 基于 `node:fs/promises`
- `access` 检查 `R_OK` 权限
- `mkdir` 使用 `{ recursive: true }`
- `writeFile` 使用 UTF-8 编码

## 4. 设计原则

### 4.1 可插拔架构
所有工具接受 `FileOperations` 参数，支持：
- 本地文件系统（默认）
- 远程文件系统（SSH、S3 等）
- Mock 实现（测试）

### 4.2 截断策略
- **Read/LS**：头部截断（关注文件开头）
- **Bash**：尾部截断（关注输出结尾，如错误信息）
- **Grep**：行截断 + 头部截断（限制单行长度和总量）

### 4.3 错误处理
- 路径不存在：抛出明确错误
- 权限不足：访问错误
- 超出限制：截断 + 可操作的提示信息（如 `Use offset=N to continue`）

### 4.4 性能优化
- 外部工具集成（`rg`, `fd`）：高性能搜索
- 流式处理：支持大文件/大结果集
- 限制机制：防止输出过大（匹配数、条目数、字节数）

## 5. 外部依赖

| 工具 | 外部命令 | 用途 | 可选性 |
|------|----------|------|--------|
| grep | `rg` (ripgrep) | 高性能文本搜索 | 可选，缺失时报错 |
| find | `fd` | 高性能文件发现 | 可选，缺失时报错 |
| edit | `diff` (npm) | 统一 patch 生成 | 必需（npm 依赖） |

## 6. 文档索引

- [Read 工具](./read-tool.md)
- [Write 工具](./write-tool.md)
- [Edit 工具](./edit-tool.md)
- [Grep 工具](./grep-tool.md)
- [Find 工具](./find-tool.md)
