# ADR-0004: Skills 全局元数据 + 按需读取加载策略

Skill 启动时只扫描并注入元数据（名称、描述、路径），正文内容由 LLM 通过 `read` 工具按需读取。替代方案是全量加载所有 SKILL.md 正文注入 system prompt。选择按需加载的原因：(1) 大幅降低启动开销，扫描 50 个 skill 只需读取 frontmatter 而非整个文件；(2) 减少 system prompt token 消耗，只注入元数据而非全文；(3) LLM 有足够智能决定何时需要读某个 skill 的完整内容。`disable-model-invocation` 字段进一步允许创建"手动技能"——完全不注入 system prompt，仅通过 `/skill:<name>` 命令显式触发。
