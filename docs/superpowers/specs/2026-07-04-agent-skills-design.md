# deepCode Agent Skills 功能设计

## 概述

为 deepCode agent 增加 skills 支持。Skill 是存放在本地的 Markdown 指令文件，为 LLM 提供特定领域的专业知识和工作流程指导。采用 **全局元数据注入 + LLM 按需读取** 模式，和 pi-agent 对齐。

## Skill 格式

每个 skill 是一个目录，目录下包含 `SKILL.md`，格式为 **YAML frontmatter + Markdown 正文**：

```markdown
---
description: 当用户需要处理 PDF 文件时使用此技能
---

# PDF 处理

## 工具
使用 bash 执行 pdftotext 命令提取文本...

## 流程
1. 先用 pdftotext 提取文本
2. 分析文本内容...
```

### Frontmatter 字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `description` | **是** | - | 简短描述，告诉 LLM 何时使用此 skill（建议 ≤ 200 token）。缺失则整个 skill 被跳过 |
| `name` | 否 | 父目录名 | Skill 名称 |
| `disable-model-invocation` | 否 | `false` | 设为 `true` 时，skill 不注入 system prompt，仅可通过 `/skill:<name>` 显式调用 |

### 设计原则

- **纯提示型**：skill 不注册自定义工具，LLM 通过已有的 bash/fs 工具执行 skill 中描述的操作
- **最小依赖**：仅需解析 YAML frontmatter + Markdown 正文，无需额外依赖库

## 目录结构

扫描以下两个路径，子目录即为 skill：

```
~/.deepcode/skills/          ← 用户级（跨项目共享）
  ├── pdf/
  │   ├── SKILL.md
  │   └── scripts/           ← 可选，skill 引用的脚本
  ├── data-analysis/
  │   ├── SKILL.md
  │   └── references/        ← 可选，参考文档
  └── ...

.cwd/.deepcode/skills/       ← 项目级（仅当前项目）
  └── code-review/
      ├── SKILL.md
      └── references/
```

### 发现规则

- 递归扫描子目录，找到 `SKILL.md` 即视为 skill 根
- 找到 `SKILL.md` 的目录不再继续递归（避免将 skill 的子目录误解析为新 skill）
- 忽略 `.` 开头目录和 `node_modules`
- 目录不存在时静默跳过

### 优先级

- 项目级覆盖全局级：同名 skill 以项目级为准
- 同一目录下无加载顺序保证

## 加载流程

```
Agent 启动
  │
  ├─ 1. 扫描 ~/.deepcode/skills/ → 收集 SkillMeta[]
  ├─ 2. 扫描 .cwd/.deepcode/skills/ → 收集 SkillMeta[]（同名覆盖全局）
  │
  ├─ 3. 解析每个 SKILL.md 的 frontmatter，提取 name + description + disable-model-invocation
  │     （不加载正文内容，降低启动开销）
  │
  ├─ 4. 过滤 disable-model-invocation=true 的 skill，其余格式化为 XML 块，注入 system prompt
  │
  └─ 5. LLM 在 system prompt 中看到可用的 skill 列表
         → 任务匹配时，使用 read 工具自主读取 SKILL.md 正文
```

### System Prompt 注入格式

```
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory.

<available_skills>
  <skill>
    <name>pdf</name>
    <description>当用户需要处理 PDF 文件时使用此技能</description>
    <location>/home/user/.deepcode/skills/pdf/SKILL.md</location>
  </skill>
  <skill>
    <name>code-review</name>
    <description>代码审查技能，帮助审查代码质量和规范</description>
    <location>/project/.deepcode/skills/code-review/SKILL.md</location>
  </skill>
</available_skills>
```

## LLM 交互流程

```
用户: "帮我审查这段代码"
  │
  ├─ LLM 在 system prompt 中看到 <available_skills>，发现 code-review 匹配
  │
  ├─ LLM 调用工具: read("/project/.deepcode/skills/code-review/SKILL.md")
  │   → 获取 skill 全文
  │
  ├─ LLM 按照 skill 指令，调用 bash/fs 工具执行审查
  │
  └─ 返回审查结果给用户
```

**显式调用：** 用户可以通过 `/skill:code-review` 直接展开 skill 内容作为 user 消息：

```xml
<skill name="code-review" location="/project/.deepcode/skills/code-review/SKILL.md">
References are relative to /project/.deepcode/skills/code-review.

(完整的 SKILL.md 内容)
</skill>
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `/skills` | 列出所有可用 skill（名称 + 描述 + 来源，disabled 的 skill 标注 `[manual]`） |
| `/skill:<name>` | 显式调用名为 `<name>` 的 skill（将 SKILL.md 全文作为 user 消息发送，disabled 的 skill 也可调用） |

## 代码架构

### 新增模块

```
packages/agent/src/
  ├── skills.ts         ← 新增：SkillManager
  ├── index.ts          ← Agent（已有）
  ├── coordinator.ts    ← ConversationCoordinator（已有）
  ├── session.ts        ← SessionManager（已有）
  └── cli.ts            ← CLI 入口（已有，需改）
```

### SkillManager 接口

```typescript
/** Skill 元数据（不含正文） */
interface SkillMeta {
  name: string;                    // skill 名称
  description: string;             // 简短描述
  location: string;                // SKILL.md 绝对路径
  source: 'user' | 'project';
  disableModelInvocation: boolean; // 是否对 LLM 隐藏
}

class SkillManager {
  /**
   * @param userSkillsDir   - 用户级目录，默认 ~/.deepcode/skills
   * @param projectSkillsDir - 项目级目录，默认 cwd/.deepcode/skills
   */
  constructor(userSkillsDir?: string, projectSkillsDir?: string);

  /** 扫描并加载所有 skill 元数据（启动时调用一次） */
  async loadSkills(): Promise<SkillMeta[]>;

  /** 获取所有已加载的 skill */
  getSkills(): SkillMeta[];

  /** 按名称查找（含 disable-model-invocation 的 skill 也可查找） */
  getSkill(name: string): SkillMeta | undefined;

  /** 格式化 skills 列表为 system prompt XML 片段（仅含 disableModelInvocation=false 的 skill） */
  formatSkillsForSystemPrompt(): string;

  /** 读取 skill 完整内容（按需） */
  async readSkillContent(name: string): Promise<string>;
}
```

### 集成点

- **cli.ts 启动阶段**：`skillManager.loadSkills()` → `formatSkillsForSystemPrompt()` → 将结果追加到 Agent 的 `systemPrompt`
- **cli.ts 命令处理**：新增 `/skills` 和 `/skill:<name>` 命令
- **Agent 不需要改动**：LLM 通过已有的 `read` 工具（fs-tool）自行加载 skill 内容，Agent 的 ReAct 循环无感知

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| skill 目录不存在 | 静默跳过，不影响 agent 启动 |
| `SKILL.md` 缺少 `description` | 跳过该 skill，输出 `[Skills] Skipping <name>: missing description` 到 stderr |
| `SKILL.md` 设置 `disable-model-invocation: true` | 正常加载，但不注入 system prompt。仅可通过 `/skill:<name>` 调用 |
| frontmatter 解析失败 | 跳过该 skill，输出 `[Skills] Failed to parse <path>: <error>` 到 stderr |
| 同名冲突（项目级 vs 用户级） | 项目级覆盖，输出 info 级别日志 |
| `/skill:name` 不存在 | 输出 `Skill not found: <name>` |
| skill 内容读取失败（readSkillContent） | 抛出异常，由调用方处理 |

## 第一阶段范围

- [ ] `SkillManager` 类实现（扫描、解析 frontmatter、格式化 system prompt 片段）
- [ ] CLI 集成：启动时加载 skills，注入 system prompt
- [ ] CLI 集成：`/skills` 命令
- [ ] CLI 集成：`/skill:<name>` 命令
- [ ] 单元测试：SkillManager
- [ ] 手动集成测试：创建示例 skill 并验证 LLM 可按需读取
