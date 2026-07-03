# Write 工具

## 1. 概述

**用途**：写入内容到文件，自动创建父目录。

**工厂函数**：`createWriteTool(cwd, operations?)`

**返回类型**：`ToolDefinition`

**关键参数**：
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件路径（相对或绝对） |
| `content` | string | ✅ | 要写入的内容 |

## 2. 核心实现流程

### 2.1 整体流程

```
输入参数 (path, content)
  │
  ▼
路径解析 (resolveToCwd)
  │
  ▼
提取父目录路径
  │
  ▼
创建父目录 (operations.mkdir)
  │
  ▼
写入文件 (operations.writeFile)
  │
  ▼
返回成功信息 (ToolResult)
```

### 2.2 路径解析

使用 `resolveToCwd` 进行基础路径解析：

```typescript
const absolutePath = resolveToCwd(path, cwd);
```

**处理逻辑**：
- 相对路径：基于 `cwd` 解析
- 绝对路径：直接使用
- `~` 开头：扩展为 HOME 目录

### 2.3 提取父目录

```typescript
const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
```

### 2.4 创建父目录

```typescript
await operations.mkdir(dir);
```

**默认实现**（`createLocalFileOperations`）：
```typescript
mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {})
```

- 使用 `{ recursive: true }` 递归创建
- 已存在时不报错
- 自动创建所有缺失的中间目录

### 2.5 写入文件

```typescript
await operations.writeFile(absolutePath, content);
```

**默认实现**：
```typescript
writeFile: (path, content) => fsWriteFile(path, content, "utf-8")
```

- 使用 UTF-8 编码
- 文件已存在时覆盖
- 文件不存在时创建

### 2.6 返回结果

```typescript
return {
  content: [
    {
      type: "text",
      text: `Successfully wrote ${content.length} bytes to ${path}`,
    },
  ],
  details: undefined,
};
```

## 3. 关键设计决策

### 3.1 为什么自动创建父目录？

- **简化使用**：用户无需手动创建目录结构
- **符合预期**：大多数文件写入场景需要此功能
- **避免错误**：减少 "目录不存在" 的运行时错误

### 3.2 为什么覆盖写入？

- **符合标准行为**：大多数文件系统和编辑器的默认行为
- **明确语义**：write = 创建或覆盖
- **简单可靠**：避免复杂的追加/合并逻辑

### 3.3 为什么返回字节数？

- **确认写入**：让用户知道写入了多少数据
- **便于验证**：可用于检查写入是否完整
- **标准化**：与 Unix `cp` 等工具行为一致

## 4. 边界情况和错误处理

### 4.1 路径相关

| 情况 | 处理 |
|------|------|
| 相对路径 | 基于 cwd 解析为绝对路径 |
| 绝对路径 | 直接使用 |
| `~` 路径 | 扩展为 HOME 目录 |
| 路径包含空格 | 正常处理（URL 编码由调用者负责） |

### 4.2 目录相关

| 情况 | 处理 |
|------|------|
| 父目录不存在 | 自动递归创建 |
| 父目录已存在 | 正常继续（不报错） |
| 父目录无写入权限 | 抛出权限错误 |

### 4.3 文件相关

| 情况 | 处理 |
|------|------|
| 文件不存在 | 创建新文件 |
| 文件已存在 | 覆盖内容 |
| 文件无写入权限 | 抛出权限错误 |
| 文件被锁定 | 抛出锁定错误（平台相关） |

### 4.4 内容相关

| 情况 | 处理 |
|------|------|
| 空字符串 | 创建空文件 |
| Unicode 内容 | 正常写入（UTF-8） |
| 换行符 | 保持原样（不做转换） |
| 二进制内容 | 不支持（应使用 Buffer API） |

## 5. 相关核心模块

### 5.1 path-utils.ts

| 函数 | 用途 |
|------|------|
| `resolveToCwd` | 基础路径解析 |
| `resolvePath` | 处理 `~` 和绝对路径 |
| `normalizePath` | 路径规范化 |

### 5.2 file-operations.ts

| 函数 | 用途 |
|------|------|
| `createLocalFileOperations` | 默认本地文件操作 |
| `FileOperations` 接口 | 可插拔的文件操作抽象 |

**关键方法**：
- `mkdir(dir)`：递归创建目录
- `writeFile(path, content)`：写入文件内容

## 6. 测试覆盖

### 6.1 关键测试场景

- 基本文件写入
- 自动创建父目录
- 覆盖现有文件
- 相对路径和绝对路径
- 错误处理（权限不足）

### 6.2 测试文件位置

- `tests/write.test.ts`

## 7. 使用示例

### 7.1 基本使用

```typescript
import { createWriteTool, createLocalFileOperations } from "@pi-agent/fs-tool";

const writeTool = createWriteTool(
  process.cwd(),
  createLocalFileOperations()
);

// 写入文件
const result = await writeTool.execute({
  path: "output.txt",
  content: "Hello, World!"
});

console.log(result.content[0].text);
// "Successfully wrote 13 bytes to output.txt"
```

### 7.2 创建嵌套目录

```typescript
await writeTool.execute({
  path: "src/components/Button.tsx",
  content: "export const Button = () => <button>Click</button>;"
});
// 自动创建 src/components/ 目录
```

## 8. 源码位置

- **工厂函数**：`src/adapters/standalone.ts` → `createWriteTool`
- **路径解析**：`src/core/path-utils.ts` → `resolveToCwd`
- **文件操作**：`src/core/file-operations.ts` → `createLocalFileOperations`
