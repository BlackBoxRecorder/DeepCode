# 工具实现文档设计规格

## 1. 概述

### 1.1 目标
为 `@pi-agent/fs-tool` 项目中的工具（read, write, edit, grep, find）创建详细的实现文档，面向库贡献者。

### 1.2 文档受众
- 库贡献者：需要理解工具内部实现细节
- 架构师：需要了解设计决策和权衡
- 维护者：需要快速定位和修改工具实现

### 1.3 文档深度
详细级别：包含关键代码片段、数据流、架构图和设计决策说明。

## 2. 文档结构

### 2.1 目录组织
```
docs/
├── tools-overview.md        # 总览文档
├── read-tool.md            # Read 工具实现
├── write-tool.md           # Write 工具实现
├── edit-tool.md            # Edit 工具实现
├── grep-tool.md            # Grep 工具实现
└── find-tool.md            # Find 工具实现
```

### 2.2 文档模板
每个工具文档采用统一结构：

1. **概述**：用途、接口、关键参数
2. **核心实现流程**：分阶段说明，包含流程图
3. **关键设计决策**：为什么这样设计
4. **边界情况和错误处理**：异常场景和处理策略
5. **相关核心模块**：引用和依赖关系
6. **测试覆盖**：关键测试场景

## 3. 工具实现细节

### 3.1 Read 工具

**工厂函数**：`createReadTool(cwd, operations?)`

**实现流程**：
1. 路径解析（`resolveReadPathAsync`）
   - 支持 macOS 路径变体（AM/PM、NFD、弯引号）
   - 异步检查文件存在性
2. 文件访问检查（`operations.access`）
3. 内容读取（`operations.readFile`）
4. 分页处理
   - offset：1-indexed → 0-indexed
   - limit：优先于截断限制
5. 截断处理（`truncateHead`）
   - 默认 2000 行 / 50KB
   - 单行超长特殊处理

**关键设计决策**：
- 使用 `truncateHead` 而非 `truncateTail`：文件读取关注开头
- 支持 offset/limit：大文件分页读取
- 图片文件特殊处理：返回附件格式

### 3.2 Write 工具

**工厂函数**：`createWriteTool(cwd, operations?)`

**实现流程**：
1. 路径解析（`resolveToCwd`）
2. 自动创建父目录（`operations.mkdir`）
3. 写入文件（`operations.writeFile`）
4. 返回写入字节数

**关键设计决策**：
- 自动创建父目录：简化使用
- 覆盖写入：符合预期行为
- 简单接口：只需 path 和 content

### 3.3 Edit 工具

**工厂函数**：`createEditTool(cwd, operations?)`

**实现流程**：
1. 文件访问检查（读写权限）
2. 读取原始内容
3. Edit-Diff 管线处理：
   - 剥离 BOM
   - 检测换行符（CRLF/LF）
   - 规范化为 LF
   - 模糊匹配和替换
   - 恢复原始换行符
   - 生成 diff 和 patch
4. 写入修改后内容

**Edit-Diff 管线详解**：
```
原始内容 → stripBom → detectLineEnding → normalizeToLF
  ↓
applyEditsToNormalizedContent
  ├─ fuzzyFindText（精确匹配 → 模糊匹配）
  ├─ 唯一性验证
  ├─ 重叠检测
  └─ applyReplacements / applyReplacementsPreservingUnchangedLines
  ↓
restoreLineEndings → 生成 diff/patch → 写入文件
```

**模糊匹配机制**：
- 优先精确匹配（`indexOf`）
- 失败时使用 NFKC 规范化模糊匹配
- 处理智能引号、Unicode 空格、特殊破折号

**关键设计决策**：
- 使用 `EditOperations` 接口（而非完整 `FileOperations`）
- 保持原始换行符和 BOM
- 生成统一 patch 格式

### 3.4 Grep 工具

**工厂函数**：`createGrepTool(cwd, rgPath?)`

**实现流程**：
1. 参数准备（pattern, glob, ignoreCase, literal, context, limit）
2. 启动 ripgrep 子进程（`--json` 输出）
3. 流式解析 JSON 输出
4. 匹配计数和限制（默认 100 个）
5. 行截断（`truncateLine`，500 字符）
6. 结果格式化和截断（`truncateHead`）

**ripgrep 集成**：
```bash
rg --json --line-number --color=never --hidden \
   [--ignore-case] [--fixed-strings] [--glob PATTERN] \
   -- PATTERN SEARCH_PATH
```

**关键设计决策**：
- 使用 ripgrep 而非 Node.js 原生搜索：性能优势
- JSON 输出格式：结构化解析
- 流式处理：支持大结果集
- 匹配限制：防止输出过大

### 3.5 Find 工具

**工厂函数**：`createFindTool(cwd, fdPath?)`

**实现流程**：
1. 参数准备（pattern, path, limit）
2. 启动 fd 子进程
3. 流式读取输出
4. 路径相对化（`path.relative`）
5. 结果格式化和截断

**fd 集成**：
```bash
fd --color=never --hidden --type file --type symlink \
   --glob PATTERN --max-results LIMIT . SEARCH_PATH
```

**关键设计决策**：
- 使用 fd 而非 Node.js 原生遍历：性能优势
- 支持文件和符号链接
- 结果限制（默认 1000 个）

## 4. 核心模块关联

### 4.1 path-utils.ts
- **路径解析**：`resolveToCwd`, `resolveReadPath`, `resolveReadPathAsync`
- **macOS 变体**：`tryMacOSScreenshotPath`, `tryNFDVariant`, `tryCurlyQuoteVariant`
- **路径规范化**：`normalizePath`, `toPosixPath`

### 4.2 truncate.ts
- **头部截断**：`truncateHead`（read, ls, grep, find）
- **尾部截断**：`truncateTail`（bash 输出）
- **行截断**：`truncateLine`（grep 匹配行）
- **常量**：`DEFAULT_MAX_LINES` (2000), `DEFAULT_MAX_BYTES` (50KB)

### 4.3 edit-diff.ts
- **文本匹配**：`fuzzyFindText`, `normalizeForFuzzyMatch`
- **替换应用**：`applyEditsToNormalizedContent`, `applyReplacementsPreservingUnchangedLines`
- **Diff 生成**：`generateUnifiedPatch`, `generateDiffString`
- **换行符处理**：`detectLineEnding`, `normalizeToLF`, `restoreLineEndings`
- **BOM 处理**：`stripBom`

### 4.4 file-operations.ts
- **本地实现**：`createLocalFileOperations`
- **只读实现**：`createReadOnlyFileOperations`
- **Mock 实现**：`createMockFileOperations`（测试用）

## 5. 设计原则

### 5.1 可插拔架构
所有工具接受 `FileOperations` 接口，支持：
- 本地文件系统
- 远程文件系统（SSH）
- Mock 实现（测试）

### 5.2 截断策略
- **Read/LS**：头部截断（关注开头）
- **Bash**：尾部截断（关注结尾）
- **Grep**：行截断 + 头部截断（限制单行和总量）

### 5.3 错误处理
- 路径不存在：明确错误信息
- 权限不足：访问错误
- 超出限制：截断 + 提示信息

### 5.4 性能优化
- 外部工具集成（rg, fd）：高性能搜索
- 流式处理：支持大文件/大结果集
- 懒加载：按需导入模块

## 6. 文档维护

### 6.1 更新策略
- 工具实现变更时，更新对应文档
- 核心模块变更时，更新所有相关工具文档
- 定期审查文档准确性

### 6.2 版本控制
- 文档与代码同步版本
- 重大变更时更新文档版本号

## 7. 验收标准

### 7.1 文档完整性
- [ ] 所有工具都有对应文档
- [ ] 每个文档包含完整结构
- [ ] 核心模块关联清晰

### 7.2 文档准确性
- [ ] 代码片段与实际实现一致
- [ ] 设计决策说明准确
- [ ] 边界情况覆盖完整

### 7.3 文档可用性
- [ ] 贡献者能快速理解实现
- [ ] 便于定位和修改代码
- [ ] 相互引用清晰

## 8. 后续工作

### 8.1 文档编写顺序
1. `tools-overview.md`（总览）
2. `read-tool.md`（基础工具）
3. `write-tool.md`（基础工具）
4. `edit-tool.md`（复杂工具）
5. `grep-tool.md`（外部依赖）
6. `find-tool.md`（外部依赖）

### 8.2 工具函数
- 编写文档时可复用模板
- 建立文档与代码的映射关系
