# API 重命名设计规格

## 1. 概述

### 1.1 目标
简化 `@pi-agent/fs-tool` 项目中的公共 API 命名，移除冗余的 "Standalone" 前缀，缩短过长的类型名，提升代码可读性和开发体验。

### 1.2 动机
- **函数名过长**：`createStandaloneReadTool` 等名称包含冗余的 "Standalone" 前缀
- **类型名过长**：`FlexibleToolDefinition` 名称不够简洁
- **代码可读性**：简短的名称更容易阅读和记忆
- **一致性**：统一的命名风格提升 API 质量

### 1.3 变更性质
**破坏性变更（Breaking Change）**：需要更新主版本号（major version bump）

## 2. 重命名映射

### 2.1 函数重命名

| 当前名称 | 新名称 | 文件位置 |
|----------|--------|----------|
| `createStandaloneReadTool` | `createReadTool` | `src/adapters/standalone.ts` |
| `createStandaloneWriteTool` | `createWriteTool` | `src/adapters/standalone.ts` |
| `createStandaloneEditTool` | `createEditTool` | `src/adapters/standalone.ts` |
| `createStandaloneLsTool` | `createLsTool` | `src/adapters/standalone.ts` |
| `createStandaloneGrepTool` | `createGrepTool` | `src/adapters/standalone.ts` |
| `createStandaloneFindTool` | `createFindTool` | `src/adapters/standalone.ts` |
| `createStandaloneToolFactory` | `createToolFactory` | `src/adapters/standalone.ts` |

### 2.2 类型重命名

| 当前名称 | 新名称 | 文件位置 |
|----------|--------|----------|
| `FlexibleToolDefinition` | `ToolDefinition` | `src/core/types.ts` |
| `ToolDefinition` | `GenericToolDefinition` | `src/core/types.ts` |

### 2.3 重命名策略说明

**函数命名策略**：
- 移除 "Standalone" 前缀
- 保留 "create" 前缀（工厂函数标准）
- 保留工具名称（Read, Write, Edit 等）
- 保留 "Tool" 后缀（明确工具类型）

**类型命名策略**：
- `FlexibleToolDefinition` → `ToolDefinition`：更简洁，作为主要工具定义类型
- `ToolDefinition` → `GenericToolDefinition`：明确其泛型特性，避免与新 `ToolDefinition` 冲突

## 3. 影响范围

### 3.1 源码文件

| 文件 | 影响类型 | 修改内容 |
|------|----------|----------|
| `src/adapters/standalone.ts` | 函数定义 | 重命名 7 个函数 |
| `src/core/types.ts` | 类型定义 | 重命名 2 个接口 |
| `src/core/index.ts` | 导出 | 更新导出语句 |
| `src/adapters/index.ts` | 导出 | 更新导出语句 |
| `src/tools/index.ts` | 导出 | 更新导出语句 |
| `src/index.ts` | 导出 | 更新导出语句 |

### 3.2 测试文件

| 文件 | 影响类型 | 修改内容 |
|------|----------|----------|
| `tests/setup.ts` | 导入 | 更新导入语句 |
| `tests/read.test.ts` | 使用 | 通过 setup.ts 间接影响 |
| `tests/write.test.ts` | 使用 | 通过 setup.ts 间接影响 |
| `tests/edit.test.ts` | 使用 | 通过 setup.ts 间接影响 |
| `tests/grep.test.ts` | 使用 | 通过 setup.ts 间接影响 |
| `tests/find.test.ts` | 使用 | 通过 setup.ts 间接影响 |
| `tests/integration.test.ts` | 使用 | 通过 setup.ts 间接影响 |

### 3.3 文档文件

| 文件 | 影响类型 | 修改内容 |
|------|----------|----------|
| `docs/tools-overview.md` | 引用 | 更新函数名和类型名引用 |
| `docs/read-tool.md` | 引用 | 更新函数名和类型名引用 |
| `docs/write-tool.md` | 引用 | 更新函数名和类型名引用 |
| `docs/edit-tool.md` | 引用 | 更新函数名和类型名引用 |
| `docs/grep-tool.md` | 引用 | 更新函数名和类型名引用 |
| `docs/find-tool.md` | 引用 | 更新函数名和类型名引用 |
| `docs/superpowers/specs/2026-07-03-tools-documentation-design.md` | 引用 | 更新函数名引用 |
| `AGENTS.md` | 引用 | 更新架构说明 |

## 4. 实施步骤

### 4.1 阶段一：核心类型重命名

1. **修改 `src/core/types.ts`**：
   - 将 `ToolDefinition` 重命名为 `GenericToolDefinition`
   - 将 `FlexibleToolDefinition` 重命名为 `ToolDefinition`
   - 更新所有内部引用

2. **更新 `src/core/index.ts`**：
   - 更新导出语句

### 4.2 阶段二：适配器函数重命名

1. **修改 `src/adapters/standalone.ts`**：
   - 重命名 7 个工厂函数
   - 更新 `createStandaloneToolFactory` 内部引用
   - 更新 JSDoc 注释

2. **更新 `src/adapters/index.ts`**：
   - 确认导出语句（可能无需修改，因为使用 `export *`）

### 4.3 阶段三：测试更新

1. **修改 `tests/setup.ts`**：
   - 更新导入语句
   - 更新 `getTool` 函数中的调用

2. **运行测试**：
   - `npm test` 确保所有测试通过

### 4.4 阶段四：文档更新

1. **更新工具文档**：
   - `docs/tools-overview.md`
   - `docs/read-tool.md`
   - `docs/write-tool.md`
   - `docs/edit-tool.md`
   - `docs/grep-tool.md`
   - `docs/find-tool.md`

2. **更新设计文档**：
   - `docs/superpowers/specs/2026-07-03-tools-documentation-design.md`

3. **更新项目文档**：
   - `AGENTS.md`

### 4.5 阶段五：版本发布

1. **更新版本号**：
   - `package.json`：更新主版本号（如 1.x.x → 2.0.0）

2. **更新 CHANGELOG**（如有）：
   - 记录破坏性变更

## 5. 向后兼容性

### 5.1 破坏性变更
- 所有公共 API 函数名变更
- 所有公共 API 类型名变更
- 现有代码需要更新导入和使用

### 5.2 迁移指南
用户需要：
1. 更新所有导入语句
2. 更新所有函数调用
3. 更新所有类型引用

**示例迁移**：
```typescript
// 旧代码
import { createStandaloneReadTool, FlexibleToolDefinition } from "@pi-agent/fs-tool";
const tool: FlexibleToolDefinition = createStandaloneReadTool(cwd);

// 新代码
import { createReadTool, ToolDefinition } from "@pi-agent/fs-tool";
const tool: ToolDefinition = createReadTool(cwd);
```

## 6. 风险评估

### 6.1 低风险
- 纯粹的重命名，不改变功能逻辑
- TypeScript 编译器会捕获所有遗漏的更新
- 测试覆盖确保功能正确性

### 6.2 缓解措施
- 使用全局搜索替换确保完整性
- 运行完整测试套件
- 代码审查确认所有变更

## 7. 验收标准

### 7.1 代码质量
- [ ] 所有 TypeScript 类型检查通过
- [ ] 所有测试通过
- [ ] 无 ESLint/Biome 警告

### 7.2 文档完整性
- [ ] 所有文档更新为新名称
- [ ] 无残留的旧名称引用
- [ ] 迁移指南清晰

### 7.3 API 一致性
- [ ] 所有函数名遵循新命名规范
- [ ] 所有类型名遵循新命名规范
- [ ] 导出语句正确
