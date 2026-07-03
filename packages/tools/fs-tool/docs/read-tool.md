# Read 工具

## 1. 概述

**用途**：读取文件内容，支持文本文件和图片（jpg, png, gif, webp, bmp）。

**工厂函数**：`createReadTool(cwd, operations?)`

**返回类型**：`ToolDefinition`

**关键参数**：
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件路径（相对或绝对） |
| `offset` | number | ❌ | 起始行号（1-indexed） |
| `limit` | number | ❌ | 最大读取行数 |

**默认限制**：
- 最大 2000 行
- 最大 50KB

## 2. 核心实现流程

### 2.1 整体流程

```
输入参数 (path, offset, limit)
  │
  ▼
路径解析 (resolveReadPathAsync)
  ├─ 尝试原始路径
  ├─ macOS AM/PM 变体
  ├─ NFD Unicode 规范化
  ├─ 弯引号变体
  └─ 组合变体
  │
  ▼
文件访问检查 (operations.access)
  │
  ▼
内容读取 (operations.readFile)
  │
  ▼
分页处理 (offset/limit)
  │
  ▼
截断处理 (truncateHead)
  │
  ▼
返回结果 (ToolResult)
```

### 2.2 路径解析阶段

使用 `resolveReadPathAsync` 进行异步路径解析，支持 macOS 特殊路径：

```typescript
const absolutePath = await resolveReadPathAsync(path, cwd);
```

**macOS 变体处理顺序**：
1. 原始路径
2. AM/PM 变体：`Screenshot 2024-01-01 at 3.00.00 PM.png` → 使用窄不间断空格 `\u202F`
3. NFD 变体：macOS 文件系统默认使用 NFD 规范化
4. 弯引号变体：`Capture d'écran` → 使用 U+2019
5. 组合变体：NFD + 弯引号

### 2.3 内容读取

```typescript
const buffer = await operations.readFile(absolutePath);
const textContent = buffer.toString("utf-8");
const allLines = textContent.split("\n");
```

### 2.4 分页处理

**offset 处理**：
```typescript
// 转换为 0-indexed
const startLine = offset ? Math.max(0, offset - 1) : 0;

// 边界检查
if (startLine >= allLines.length) {
  throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
}
```

**limit 处理**：
```typescript
if (limit !== undefined) {
  const endLine = Math.min(startLine + limit, allLines.length);
  selectedContent = allLines.slice(startLine, endLine).join("\n");
} else {
  selectedContent = allLines.slice(startLine).join("\n");
}
```

### 2.5 截断处理

使用 `truncateHead` 进行截断：

```typescript
const truncation = truncateHead(selectedContent);
```

**截断结果处理**：

| 场景 | 处理方式 |
|------|----------|
| 单行超过 50KB | 提示使用 bash 命令 |
| 截断发生（行数） | `[Showing lines X-Y of Z. Use offset=N to continue.]` |
| 截断发生（字节） | `[Showing lines X-Y of Z (50KB limit). Use offset=N to continue.]` |
| 用户指定 limit | `[N more lines in file. Use offset=M to continue.]` |

**单行超长处理**：
```typescript
if (truncation.firstLineExceedsLimit) {
  const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
  outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
}
```

## 3. 关键设计决策

### 3.1 为什么使用 truncateHead 而非 truncateTail？

- **文件读取**：通常关注文件开头（函数定义、imports、配置）
- **Bash 输出**：通常关注结尾（错误信息、最终结果）
- 因此 read 使用 `truncateHead`，bash 使用 `truncateTail`

### 3.2 为什么支持 offset/limit？

- 大文件无法一次性读取（超过 50KB 限制）
- 允许 AI 代理分页读取文件
- 提供更好的用户体验和控制

### 3.3 图片文件处理

当检测到图片扩展名时，返回附件格式：
```typescript
{
  type: "image",
  data: base64EncodedData,
  mimeType: "image/png" // 根据扩展名确定
}
```

## 4. 边界情况和错误处理

### 4.1 路径相关

| 情况 | 处理 |
|------|------|
| 文件不存在 | 抛出访问错误 |
| 路径解析失败 | 使用原始路径（不阻塞） |
| 相对路径 | 基于 cwd 解析 |
| macOS 路径变体 | 自动尝试多种变体 |

### 4.2 内容相关

| 情况 | 处理 |
|------|------|
| 空文件 | 返回空字符串 |
| 二进制文件 | 按 UTF-8 解码（可能乱码） |
| 超长单行（>50KB） | 触发 firstLineExceedsLimit，提示使用 bash |
| BOM 文件 | 正常读取（不做特殊处理） |

### 4.3 分页相关

| 情况 | 处理 |
|------|------|
| offset 超出范围 | 抛出明确错误 |
| limit 超过剩余行数 | 返回实际可用行数 |
| 最后一页 | 无续读提示 |
| offset + limit 超出范围 | 返回到文件末尾 |

## 5. 相关核心模块

### 5.1 path-utils.ts

| 函数 | 用途 |
|------|------|
| `resolveReadPathAsync` | 异步路径解析，支持 macOS 变体 |
| `resolveToCwd` | 基础路径解析 |
| `tryMacOSScreenshotPath` | AM/PM 变体处理 |
| `tryNFDVariant` | NFD 规范化 |
| `tryCurlyQuoteVariant` | 弯引号处理 |

### 5.2 truncate.ts

| 函数/常量 | 用途 |
|-----------|------|
| `truncateHead` | 头部截断，保留前 N 行/字节 |
| `formatSize` | 字节数格式化（B, KB, MB） |
| `DEFAULT_MAX_LINES` | 默认最大行数（2000） |
| `DEFAULT_MAX_BYTES` | 默认最大字节数（50KB） |

### 5.3 file-operations.ts

| 函数 | 用途 |
|------|------|
| `createLocalFileOperations` | 默认本地文件操作 |
| `FileOperations` 接口 | 可插拔的文件操作抽象 |

## 6. 测试覆盖

### 6.1 关键测试场景

- 基本文件读取
- offset/limit 分页
- 截断行为（行数和字节）
- 错误处理（文件不存在、offset 超界）
- macOS 路径变体
- 图片文件处理

### 6.2 测试文件位置

- `tests/read.test.ts`

## 7. 源码位置

- **工厂函数**：`src/adapters/standalone.ts` → `createReadTool`
- **路径解析**：`src/core/path-utils.ts` → `resolveReadPathAsync`
- **截断逻辑**：`src/core/truncate.ts` → `truncateHead`
