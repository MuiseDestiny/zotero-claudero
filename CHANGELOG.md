# Changelog

## 0.1.0-rc.1

First release candidate for Zotero 7 through 10. This is a preview build;
DeepSeek Harness support is experimental.

### Features

- Claude Code, Codex, and DeepSeek Harness inside Zotero.
- Paper conversations with PDF, annotation, evidence, and citation tools.
- Local conversation history, permissions, MCP tools, and academic skills.
- macOS, Windows, and Linux executable discovery, including Codex WSL support.
- User-facing English and Simplified Chinese documentation, including how the
  plugin works, privacy, and AI-assisted development.

### Fixes

- Resolve required Web APIs in windowless Zotero environments so secure helper
  tokens and request cancellation initialize correctly without a main window.
- Preserve missing MCP executable errors on Windows instead of reporting only
  a closed connection, and canonicalize Windows workspace paths in runtime tests.
- Resolve all reported dependency advisories, including MCP SDK OAuth,
  proxy-addr, markdown-it linkification, KaTeX prototype pollution, ip-address,
  and development-only brace expansion dependencies.
- Pin the patched KaTeX renderer across the Markdown plugin, synchronize its
  packaged stylesheet/fonts/license, and verify asset consistency at release.
- Require dependency audits to pass at every severity level and add KaTeX
  prototype-pollution regression coverage.
- Stabilize MCP connection tests with the official SDK, including process failures,
  Streamable HTTP, legacy SSE, timeouts, and paginated tool lists.
- Start and authenticate the local helper before settings requests.
- Preserve explicit proxies and correctly parse quoted environment variables.
- Fix cleared CLI paths, device-specific configuration, NVM discovery, Linux home
  detection, and WSL detection without overwriting manual edits.
- Apply workspace changes to the next persistent request.
- Improve preferences with accessible scrolling tabs, responsive fields, Reader
  theme colors, setup guidance, and complete localization.
- Separate HTTP and SSE configuration, preserve quoted command arguments, and
  protect existing MCP settings from malformed JSON and duplicate names.

This release requires a local Node.js 20+ runtime and the provider CLI selected
in Preferences. DeepSeek Harness requires Node.js 24+.

### 简体中文

- 首个候选版本：在 Zotero 中使用 Claude Code、Codex 和 DeepSeek Harness。
- 支持论文问答、PDF 证据、批注、引用跳转、本地对话历史、权限和学术工作流。
- 完善服务自动检测、设置页、MCP 连接和会话恢复，修复全部已报告的依赖漏洞。
- 重写面向用户的中英 README，排除内部开发文档、本机配置和临时产物。
- 需要 Node.js 20+ 和对应服务程序；DeepSeek 为实验性集成，需要 Node.js 24+。
