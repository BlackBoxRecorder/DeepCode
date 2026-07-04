# ADR-0002: MCP 协议集成作为外部工具扩展机制

采用 MCP（Model Context Protocol）作为唯一的外部工具集成入口，而非自建工具 SDK 或插件 API。原因：(1) MCP 是开放标准，Claude Code、VS Code 等工具已采用，工具生态可直接复用；(2) 通过 stdio 和 HTTP/SSE 两种传输覆盖本地和远程工具场景；(3) 每个服务器对应一个 kebab-case 名称，工具名以 `{server}_{tool}` 格式前缀化防止命名冲突。MCP 配置格式（`mcp.json`）与 Claude Code 兼容，允许用户直接复用已有的 MCP 配置。
