# Find 工具

## 1. 概述

**用途**：使用 glob 模式查找文件，基于 fd 实现高性能文件发现。

**工厂函数**：`createFindTool(cwd, fdPath?)`

**返回类型**：`ToolDefinition`

**关键参数**：
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | glob 模式（如 `*.ts`, `**/*.json`） |
| `path` | string | ❌ | 搜索目录（默认当前目录） |
| `limit` | number | ❌ | 最大结果数（默认 1000） |

**默认限制**：
- 最大 1000 个结果
- 输出最大 50KB

## 2. 核心实现流程

### 2.1 整体流程

```
输入参数 (pattern, path, limit)
  │
  ▼
参数准备
  ├─ 解析路径 (resolveToCwd)
  ├─ 构建 fd 命令参数
  └─ 设置限制 (effectiveLimit)
  │
  ▼
启动 fd 子进程
  │
  ▼
流式读取输出
  ├─ 逐行读取
  ├─ 路径相对化 (path.relative)
  └─ 收集结果
  │
  ▼
格式化结果
  ├─ 结果截断 (truncateHead)
  └─ 添加限制提示
  │
  ▼
返回结果 (ToolResult)
```

### 2.2 fd 集成

**命令构建**：
```typescript
const args: string[] = [
  "--color=never",      // 无颜色
  "--hidden",           // 包含隐藏文件
  "--type", "file",     // 只查找文件
  "--type", "symlink",  // 包含符号链接
];

args.push("--glob", pattern);
args.push("--max-results", String(effectiveLimit));
args.push(".", searchPath);
```

**完整命令示例**：
```bash
fd --color=never --hidden --type file --type symlink \
   --glob "*.ts" --max-results 1000 . /path/to/search
```

### 2.3 子进程管理

```typescript
const child = spawn(fd, args, {
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
const onAbortChild = () => {
  aborted = true;
  if (!child.killed) child.kill();
};
signal?.addEventListener("abort", onAbortChild, { once: true });
```

### 2.4 输出处理

**逐行读取**：
```typescript
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed) {
    const relativePath = path.relative(searchPath, trimmed);
    outputLines.push(relativePath || ".");
  }
});
```

**路径相对化**：
```typescript
// /path/to/search/src/index.ts → src/index.ts
const relativePath = path.relative(searchPath, trimmed);

// 根目录特殊情况
if (relativePath === "") {
  outputLines.push(".");
}
```

### 2.5 退出码处理

fd 退出码含义：
- `0`：找到匹配
- `1`：无匹配（正常）
- `2`：错误

```typescript
child.on("close", (_code) => {
  cleanup();
  
  if (aborted) {
    reject(new Error("Operation aborted"));
    return;
  }

  if (_code !== 0 && _code !== 1) {
    // code 1 means no matches, which is valid
    reject(new Error(`fd exited with code ${_code}: ${stderr}`));
    return;
  }

  // 处理结果...
});
```

### 2.6 结果格式化

**输出格式**：
```
src/index.ts
src/utils.ts
src/components/Button.tsx
```

**结果截断**：
```typescript
let output = outputLines.join("\n");
const truncation = truncateHead(output);
output = truncation.content;
```

**限制提示**：
```typescript
const notices: string[] = [];
const details: any = {};

if (outputLines.length >= effectiveLimit) {
  notices.push(`${effectiveLimit} result limit reached`);
  details.resultLimitReached = effectiveLimit;
}

if (truncation.truncated) {
  notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  details.truncation = truncation;
}

if (notices.length > 0) {
  output += `\n\n[${notices.join(". ")}]`;
}
```

## 3. 关键设计决策

### 3.1 为什么使用 fd 而非 Node.js 原生遍历？

| 方面 | fd | Node.js 原生 |
|------|-----|--------------|
| 性能 | 极快（Rust 实现） | 较慢 |
| 功能 | 完整 glob 支持 | 需要手动实现 |
| 忽略规则 | 自动读取 .gitignore | 需要手动处理 |
| 符号链接 | 原生支持 | 需要手动处理 |
| 并行搜索 | 自动并行 | 单线程 |

### 3.2 为什么包含符号链接？

- **完整性**：符号链接也是文件系统的一部分
- **常见用途**：monorepo 中常用符号链接
- **一致性**：与 ripgrep 行为一致

### 3.3 为什么限制结果数？

- **防止输出过大**：1000 个结果通常足够
- **性能保护**：避免处理过多结果
- **用户体验**：过多结果反而难以使用

### 3.4 为什么使用 glob 模式？

- **直观易用**：`*.ts` 比正则更直观
- **标准语法**：被广泛支持
- **fd 原生支持**：性能最优

### 3.5 为什么路径相对化？

- **可读性**：相对路径更简洁
- **可移植性**：不依赖绝对路径
- **一致性**：与 grep 工具输出格式一致

## 4. 边界情况和错误处理

### 4.1 fd 相关

| 情况 | 处理 |
|------|------|
| fd 未安装 | 抛出错误：`Failed to run fd` |
| fd 执行失败 | 抛出错误，包含 stderr |
| fd 被信号终止 | 检查退出码 |

### 4.2 搜索相关

| 情况 | 处理 |
|------|------|
| 无匹配结果 | 返回 `(no files found)` |
| 结果数达到限制 | 提示 `1000 result limit reached` |
| 搜索目录不存在 | fd 报错，捕获并抛出 |
| 无权限目录 | fd 跳过，不报错 |

### 4.3 模式相关

| 情况 | 处理 |
|------|------|
| 无效 glob 模式 | fd 报错，捕获并抛出 |
| 模式无匹配 | 返回 `(no files found)` |
| 递归模式（`**`） | fd 原生支持 |

### 4.4 输出相关

| 情况 | 处理 |
|------|------|
| 输出超过 50KB | 截断并提示 |
| 结果限制达到 | 停止子进程，提示限制 |
| 根目录匹配 | 返回 `.` |

### 4.5 信号处理

| 情况 | 处理 |
|------|------|
| AbortSignal 触发 | 杀死子进程，抛出 "Operation aborted" |
| 子进程已结束 | 忽略信号 |

## 5. 相关核心模块

### 5.1 truncate.ts

| 函数 | 用途 |
|------|------|
| `truncateHead` | 截断最终输出（50KB 限制） |
| `formatSize` | 格式化字节数 |
| `DEFAULT_MAX_BYTES` | 默认最大字节数（50KB） |

### 5.2 path-utils.ts

| 函数 | 用途 |
|------|------|
| `resolveToCwd` | 解析搜索路径 |

### 5.3 Node.js 内置模块

| 模块 | 用途 |
|------|------|
| `child_process.spawn` | 启动 fd 子进程 |
| `readline.createInterface` | 流式读取输出 |
| `path.relative` | 路径相对化 |

## 6. 测试覆盖

### 6.1 关键测试场景

- 基本 glob 搜索（`*.ts`）
- 递归搜索（`**/*.json`）
- 结果限制
- 结果截断
- 错误处理（fd 未安装）
- 路径相对化

### 6.2 测试文件位置

- `tests/find.test.ts`

## 7. 使用示例

### 7.1 基本使用

```typescript
import { createFindTool } from "@pi-agent/fs-tool";

const findTool = createFindTool(process.cwd());

const result = await findTool.execute({
  pattern: "*.ts",
  path: "src",
});

console.log(result.content[0].text);
// src/index.ts
// src/utils.ts
// src/components/Button.tsx
```

### 7.2 递归搜索

```typescript
const result = await findTool.execute({
  pattern: "**/*.json",
  path: ".",
  limit: 500,
});
```

### 7.3 复杂 glob 模式

```typescript
// 查找所有测试文件
const result = await findTool.execute({
  pattern: "**/*.{test,spec}.{ts,tsx,js,jsx}",
});

// 查找特定目录下的文件
const result = await findTool.execute({
  pattern: "src/components/**/*.tsx",
});
```

### 7.4 查找配置文件

```typescript
const result = await findTool.execute({
  pattern: "{.eslintrc,.prettierrc,tsconfig.json,package.json}",
});
```

## 8. 源码位置

- **工厂函数**：`src/adapters/standalone.ts` → `createFindTool`
- **截断逻辑**：`src/core/truncate.ts` → `truncateHead`
- **路径解析**：`src/core/path-utils.ts` → `resolveToCwd`

## 9. 与 Grep 工具的区别

| 方面 | Find | Grep |
|------|------|------|
| 搜索对象 | 文件名 | 文件内容 |
| 外部工具 | fd | ripgrep |
| 匹配模式 | glob | 正则/字面量 |
| 默认限制 | 1000 结果 | 100 匹配 |
| 输出格式 | 文件路径 | 文件路径:行号: 内容 |

**使用场景**：
- **Find**：查找特定类型的文件（`*.ts`）、查找配置文件、查找特定目录下的文件
- **Grep**：搜索代码中的特定模式、查找函数定义、搜索错误信息
