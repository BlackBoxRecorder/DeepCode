# Grep 工具

## 1. 概述

**用途**：使用正则表达式搜索文件内容，基于 ripgrep 实现高性能搜索。

**工厂函数**：`createGrepTool(cwd, rgPath?)`

**返回类型**：`ToolDefinition`

**关键参数**：
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | 搜索模式（正则或字面量） |
| `path` | string | ❌ | 搜索目录（默认当前目录） |
| `glob` | string | ❌ | 文件过滤 glob 模式 |
| `ignoreCase` | boolean | ❌ | 忽略大小写（默认 false） |
| `literal` | boolean | ❌ | 字面量匹配（默认 false） |
| `context` | number | ❌ | 上下文行数（默认 0） |
| `limit` | number | ❌ | 最大匹配数（默认 100） |

**默认限制**：
- 最大 100 个匹配
- 每行最大 500 字符
- 输出最大 50KB

## 2. 核心实现流程

### 2.1 整体流程

```
输入参数 (pattern, path, glob, ignoreCase, literal, context, limit)
  │
  ▼
参数准备
  ├─ 解析路径 (resolveToCwd)
  ├─ 构建 rg 命令参数
  └─ 设置限制 (effectiveLimit)
  │
  ▼
启动 ripgrep 子进程
  │
  ▼
流式解析 JSON 输出
  ├─ 逐行读取
  ├─ 解析 JSON 事件
  ├─ 提取匹配信息
  └─ 计数和限制
  │
  ▼
格式化结果
  ├─ 路径相对化 (path.relative)
  ├─ 行截断 (truncateLine)
  └─ 结果截断 (truncateHead)
  │
  ▼
返回结果 (ToolResult)
```

### 2.2 ripgrep 集成

**命令构建**：
```typescript
const args: string[] = [
  "--json",           // JSON 输出格式
  "--line-number",    // 包含行号
  "--color=never",    // 无颜色
  "--hidden",         // 包含隐藏文件
];

if (ignoreCase) args.push("--ignore-case");
if (literal) args.push("--fixed-strings");
if (glob) args.push("--glob", glob);

args.push("--", pattern, searchPath);
```

**完整命令示例**：
```bash
rg --json --line-number --color=never --hidden \
   --ignore-case --glob "*.ts" \
   -- "function\s+\w+" /path/to/search
```

### 2.3 子进程管理

```typescript
const child = spawn(rg, args, {
  stdio: ["ignore", "pipe", "pipe"],  // 忽略 stdin，pipe stdout/stderr
});

const rl = createInterface({ input: child.stdout });
let stderr = "";

child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});
```

**信号处理**：
```typescript
const onAbort = () => {
  aborted = true;
  if (!child.killed) child.kill();
};
signal?.addEventListener("abort", onAbort, { once: true });
```

### 2.4 JSON 输出解析

ripgrep `--json` 输出格式：
```json
{"type":"begin","data":{"path":{"text":"src/index.ts"}}}
{"type":"match","data":{"path":{"text":"src/index.ts"},"lines":{"text":"export function foo() {\n"},"line_number":10}}
{"type":"end","data":{"path":{"text":"src/index.ts"},"stats":{"elapsed":0.001}}}
```

**解析逻辑**：
```typescript
rl.on("line", (line) => {
  if (!line.trim() || matchCount >= effectiveLimit) return;
  
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  
  if (event.type === "match") {
    matchCount++;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;
    
    if (filePath && typeof lineNumber === "number") {
      matches.push({ filePath, lineNumber, lineText });
    }
    
    if (matchCount >= effectiveLimit) {
      matchLimitReached = true;
      stopChild();  // 达到限制时停止子进程
    }
  }
});
```

### 2.5 结果格式化

**路径相对化**：
```typescript
const relativePath = path.relative(searchPath, match.filePath);
// /path/to/search/src/index.ts → src/index.ts
```

**行截断**（`truncateLine`）：
```typescript
const { text: truncatedText, wasTruncated } = truncateLine(line);
// 超过 500 字符的行被截断：`... [truncated]`
```

**输出格式**：
```
src/index.ts:10: export function foo() {
src/utils.ts:25: export function bar() {
```

### 2.6 结果截断

使用 `truncateHead` 截断最终输出：
```typescript
const truncation = truncateHead(output);
output = truncation.content;
```

**限制提示**：
```typescript
const notices: string[] = [];
if (matchLimitReached) {
  notices.push(`${effectiveLimit} match limit reached`);
}
if (truncation.truncated) {
  notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
}
if (linesTruncated) {
  notices.push("Long lines truncated");
}

if (notices.length > 0) {
  output += `\n\n[${notices.join(". ")}]`;
}
```

## 3. 关键设计决策

### 3.1 为什么使用 ripgrep 而非 Node.js 原生搜索？

| 方面 | ripgrep | Node.js 原生 |
|------|---------|--------------|
| 性能 | 极快（Rust 实现） | 较慢 |
| 功能 | 完整正则支持 | 需要手动实现 |
| 忽略规则 | 自动读取 .gitignore | 需要手动处理 |
| 二进制文件 | 自动跳过 | 需要手动检测 |

### 3.2 为什么使用 JSON 输出格式？

- **结构化解析**：无需手动解析文本格式
- **包含元信息**：文件路径、行号、匹配内容
- **错误处理**：错误信息也是 JSON 格式
- **可扩展**：未来可添加更多信息

### 3.3 为什么流式处理？

- **内存效率**：无需一次性加载所有结果
- **响应性**：可以边搜索边返回
- **限制支持**：达到限制时立即停止

### 3.4 为什么限制匹配数？

- **防止输出过大**：100 个匹配通常足够
- **性能保护**：避免处理过多结果
- **用户体验**：过多结果反而难以使用

### 3.5 为什么截断单行？

- **防止超长行**：某些文件可能有极长的行
- **输出控制**：保持输出可读性
- **内存保护**：避免单行占用过多内存

## 4. 边界情况和错误处理

### 4.1 ripgrep 相关

| 情况 | 处理 |
|------|------|
| ripgrep 未安装 | 抛出错误：`Failed to run ripgrep` |
| ripgrep 执行失败 | 抛出错误，包含 stderr |
| ripgrep 被信号终止 | 检查退出码 |

### 4.2 搜索相关

| 情况 | 处理 |
|------|------|
| 无匹配结果 | 返回 `(no matches found)` |
| 匹配数达到限制 | 提示 `100 match limit reached` |
| 搜索目录不存在 | ripgrep 报错，捕获并抛出 |
| 无权限目录 | ripgrep 跳过，不报错 |

### 4.3 输出相关

| 情况 | 处理 |
|------|------|
| 输出超过 50KB | 截断并提示 |
| 单行超过 500 字符 | 截断并标记 `[truncated]` |
| 匹配限制达到 | 停止子进程，提示限制 |

### 4.4 信号处理

| 情况 | 处理 |
|------|------|
| AbortSignal 触发 | 杀死子进程，抛出 "Operation aborted" |
| 子进程已结束 | 忽略信号 |

## 5. 相关核心模块

### 5.1 truncate.ts

| 函数 | 用途 |
|------|------|
| `truncateHead` | 截断最终输出（50KB 限制） |
| `truncateLine` | 截断单行（500 字符限制） |
| `formatSize` | 格式化字节数 |
| `DEFAULT_MAX_BYTES` | 默认最大字节数（50KB） |

### 5.2 path-utils.ts

| 函数 | 用途 |
|------|------|
| `resolveToCwd` | 解析搜索路径 |

### 5.3 Node.js 内置模块

| 模块 | 用途 |
|------|------|
| `child_process.spawn` | 启动 ripgrep 子进程 |
| `readline.createInterface` | 流式读取输出 |
| `path.relative` | 路径相对化 |

## 6. 测试覆盖

### 6.1 关键测试场景

- 基本正则搜索
- 字面量搜索（`literal: true`）
- 忽略大小写（`ignoreCase: true`）
- glob 过滤（`glob: "*.ts"`）
- 匹配限制
- 行截断
- 错误处理（ripgrep 未安装）

### 6.2 测试文件位置

- `tests/grep.test.ts`

## 7. 使用示例

### 7.1 基本使用

```typescript
import { createGrepTool } from "@pi-agent/fs-tool";

const grepTool = createGrepTool(process.cwd());

const result = await grepTool.execute({
  pattern: "function\s+\w+",
  path: "src",
});

console.log(result.content[0].text);
// src/index.ts:10: export function foo() {
// src/utils.ts:25: export function bar() {
```

### 7.2 高级搜索

```typescript
const result = await grepTool.execute({
  pattern: "TODO|FIXME",
  path: "src",
  glob: "*.ts",
  ignoreCase: true,
  context: 2,  // 显示上下文
  limit: 50,
});
```

### 7.3 字面量搜索

```typescript
const result = await grepTool.execute({
  pattern: "import React",
  literal: true,  // 不作为正则处理
  glob: "*.{ts,tsx}",
});
```

## 8. 源码位置

- **工厂函数**：`src/adapters/standalone.ts` → `createGrepTool`
- **截断逻辑**：`src/core/truncate.ts` → `truncateHead`, `truncateLine`
- **路径解析**：`src/core/path-utils.ts` → `resolveToCwd`
