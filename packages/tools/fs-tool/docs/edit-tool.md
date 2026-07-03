# Edit 工具

## 1. 概述

**用途**：通过精确文本匹配编辑文件，支持模糊匹配处理 Unicode 差异。

**工厂函数**：`createEditTool(cwd, operations?)`

**返回类型**：`ToolDefinition`

**关键参数**：
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件路径（相对或绝对） |
| `edits` | Edit[] | ✅ | 编辑操作数组 |

**Edit 接口**：
```typescript
interface Edit {
  oldText: string;  // 要查找的文本（必须唯一）
  newText: string;  // 替换文本
}
```

## 2. 核心实现流程

### 2.1 整体流程

```
输入参数 (path, edits)
  │
  ▼
路径解析 (resolveToCwd)
  │
  ▼
文件访问检查 (operations.access)
  │
  ▼
读取原始内容 (operations.readFile)
  │
  ▼
Edit-Diff 管线处理
  ├─ 剥离 BOM (stripBom)
  ├─ 检测换行符 (detectLineEnding)
  ├─ 规范化为 LF (normalizeToLF)
  ├─ 应用编辑 (applyEditsToNormalizedContent)
  │   ├─ 模糊匹配 (fuzzyFindText)
  │   ├─ 唯一性验证
  │   ├─ 重叠检测
  │   └─ 应用替换
  ├─ 恢复换行符 (restoreLineEndings)
  └─ 生成 diff/patch
  │
  ▼
写入修改后内容 (operations.writeFile)
  │
  ▼
返回结果 (ToolResult)
```

### 2.2 Edit-Diff 管线详解

```
原始内容 (rawContent)
  │
  ▼
stripBom ──────────────────────────────► { bom, text: content }
  │
  ▼
detectLineEnding ──────────────────────► originalEnding: "\r\n" | "\n"
  │
  ▼
normalizeToLF ─────────────────────────► normalizedContent (LF 换行)
  │
  ▼
applyEditsToNormalizedContent ─────────► { baseContent, newContent }
  │
  ▼
restoreLineEndings(newContent, originalEnding)
  │
  ▼
bom + restoredContent ─────────────────► finalContent
  │
  ▼
generateDiffString(baseContent, newContent)
generateUnifiedPatch(path, baseContent, newContent)
```

### 2.3 应用编辑详解

`applyEditsToNormalizedContent` 函数处理所有编辑操作：

```typescript
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  // 1. 规范化编辑内容（LF 换行）
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  // 2. 验证 oldText 不为空
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // 3. 初始匹配（检查是否需要模糊匹配）
  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText),
  );
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  // 4. 详细匹配和验证
  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  // 5. 重叠检测
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}.`);
    }
  }

  // 6. 应用替换
  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits,
      )
    : applyReplacements(replacementBaseContent, matchedEdits);

  // 7. 验证是否有变更
  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent };
}
```

### 2.4 模糊匹配机制

`fuzzyFindText` 函数实现两级匹配：

```typescript
export function fuzzyFindText(
  content: string,
  oldText: string,
): FuzzyMatchResult {
  // 1. 尝试精确匹配
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // 2. 尝试模糊匹配
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}
```

**normalizeForFuzzyMatch 处理**：
```typescript
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // 去除行尾空白
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 智能单引号 → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号 → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各种破折号/连字符 → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // 特殊空格 → 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}
```

### 2.5 替换应用

**精确匹配**：直接字符串替换
```typescript
function applyReplacements(content: string, replacements: TextReplacement[]): string {
  let result = content;
  // 从后往前替换，避免索引偏移
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}
```

**模糊匹配**：保留原始行
```typescript
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  // 1. 分析替换范围对应的行
  // 2. 将替换分组（重叠的替换合并）
  // 3. 对于每组：
  //    - 未修改的行：使用 originalContent 的原始行
  //    - 修改的行：在 baseContent 上应用替换
  // 4. 拼接结果
}
```

## 3. 关键设计决策

### 3.1 为什么使用 EditOperations 而非 FileOperations？

Edit 工具只需要：
- `readFile`：读取文件内容
- `writeFile`：写入修改后内容
- `access`：检查文件存在和权限

不需要：
- `mkdir`：不会创建新目录
- `stat`：不需要文件元信息
- `readdir`：不需要目录列表
- `exists`：通过 `access` 检查

使用更窄的接口提高了灵活性和可测试性。

### 3.2 为什么保持原始换行符和 BOM？

- **最小惊讶原则**：编辑不应改变文件的编码特征
- **版本控制友好**：避免不必要的 diff
- **跨平台兼容**：保持 CRLF/LF 一致性

### 3.3 为什么需要唯一性验证？

- **避免歧义**：多个匹配时不知道替换哪个
- **安全第一**：宁可报错也不要错误替换
- **明确错误信息**：提示用户提供更多上下文

### 3.4 为什么检测重叠？

- **避免冲突**：多个编辑可能修改同一区域
- **结果不可预测**：重叠编辑的执行顺序不确定
- **明确错误信息**：提示用户合并编辑

### 3.5 为什么生成统一 patch？

- **标准格式**：被 Git 和其他工具广泛支持
- **便于审查**：用户可以看到具体修改
- **可逆性**：理论上可以用 `patch` 命令撤销

## 4. 边界情况和错误处理

### 4.1 输入验证

| 情况 | 错误信息 |
|------|----------|
| oldText 为空 | `oldText must not be empty in {path}.` |
| oldText 未找到 | `Could not find the exact text in {path}.` |
| oldText 多个匹配 | `Found {N} occurrences of the text in {path}. The text must be unique.` |
| edits 重叠 | `edits[{i}] and edits[{j}] overlap in {path}.` |
| 替换后无变化 | `No changes made to {path}. The replacement produced identical content.` |

### 4.2 内容处理

| 情况 | 处理 |
|------|------|
| BOM 文件 | 保留 BOM，编辑后恢复 |
| CRLF 换行 | 检测并保留，编辑后恢复 |
| 混合换行符 | 以第一个换行符为准 |
| Unicode 差异 | 模糊匹配处理 |

### 4.3 模糊匹配场景

| 场景 | 示例 | 处理 |
|------|------|------|
| 智能引号 | `'hello'` vs `'hello'` | 规范化为 ASCII 引号 |
| Unicode 空格 | `hello  world` vs `hello world` | 规范化为空格 |
| 特殊破折号 | `—` vs `-` | 规范化为连字符 |
| NFKC 等价 | `ﬁ` vs `fi` | NFKC 规范化 |

### 4.4 文件相关

| 情况 | 处理 |
|------|------|
| 文件不存在 | 抛出访问错误 |
| 文件只读 | 抛出权限错误 |
| 文件被锁定 | 抛出锁定错误（平台相关） |

## 5. 相关核心模块

### 5.1 edit-diff.ts

| 函数 | 用途 |
|------|------|
| `fuzzyFindText` | 精确匹配 → 模糊匹配 |
| `normalizeForFuzzyMatch` | NFKC + 特殊字符规范化 |
| `applyEditsToNormalizedContent` | 应用所有编辑操作 |
| `applyReplacements` | 精确匹配替换 |
| `applyReplacementsPreservingUnchangedLines` | 模糊匹配替换（保留原始行） |
| `generateUnifiedPatch` | 生成统一 patch 格式 |
| `generateDiffString` | 生成带行号的 diff 字符串 |
| `detectLineEnding` | 检测 CRLF/LF |
| `normalizeToLF` | 规范化为 LF |
| `restoreLineEndings` | 恢复原始换行符 |
| `stripBom` | 剥离 BOM |

### 5.2 path-utils.ts

| 函数 | 用途 |
|------|------|
| `resolveToCwd` | 基础路径解析 |

### 5.3 file-operations.ts

| 函数 | 用途 |
|------|------|
| `EditOperations` 接口 | 编辑操作抽象 |
| `createLocalFileOperations` | 默认本地实现 |

## 6. 测试覆盖

### 6.1 关键测试场景

- 基本文本替换
- 多个编辑操作
- 模糊匹配（智能引号、Unicode 空格）
- 唯一性验证失败
- 重叠检测
- BOM 和换行符处理
- 错误处理（文件不存在、oldText 未找到）

### 6.2 测试文件位置

- `tests/edit.test.ts`

## 7. 使用示例

### 7.1 基本使用

```typescript
import { createEditTool } from "@pi-agent/fs-tool";

const editTool = createEditTool(process.cwd());

const result = await editTool.execute({
  path: "src/index.ts",
  edits: [
    {
      oldText: "const greeting = 'hello';",
      newText: "const greeting = 'world';",
    },
  ],
});

console.log(result.content[0].text);
// "Successfully replaced 1 block(s) in src/index.ts."

console.log(result.details.diff);
// 带行号的 diff 输出

console.log(result.details.patch);
// 统一 patch 格式
```

### 7.2 多个编辑

```typescript
await editTool.execute({
  path: "config.json",
  edits: [
    { oldText: '"name": "old"', newText: '"name": "new"' },
    { oldText: '"version": "1.0"', newText: '"version": "2.0"' },
  ],
});
```

### 7.3 模糊匹配

```typescript
// 文件内容：const greeting = 'hello';（使用智能引号）
// oldText 使用 ASCII 引号也能匹配
await editTool.execute({
  path: "src/index.ts",
  edits: [
    {
      oldText: "const greeting = 'hello';",  // ASCII 引号
      newText: "const greeting = 'world';",
    },
  ],
});
```

## 8. 源码位置

- **工厂函数**：`src/adapters/standalone.ts` → `createEditTool`
- **Edit-Diff 管线**：`src/core/edit-diff.ts`
- **路径解析**：`src/core/path-utils.ts` → `resolveToCwd`
