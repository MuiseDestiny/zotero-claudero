# Changelog

## 0.1.0

First stable release for Zotero 7 through 10. DeepSeek Harness remains
experimental.

### Features

- Claude Code, Codex, and DeepSeek Harness inside Zotero, with paper questions,
  PDF evidence, annotation links, local conversations, MCP tools, and skills.
- Standard XPI bundles verified standalone Helpers for macOS, Windows, and Linux
  on arm64/x64. Native Claude Code and Codex no longer require a separate Node.js
  installation for the Helper or host-native Zotero MCP bridge.
- Keep the portable Node.js Helper for compatibility and Codex WSL integration.

### Fixes Since 0.1.0-rc.1

- Update Markdown rendering, schema validation, HTTP parsing, and development
  dependencies to address newly reported security advisories.
- Authenticate every local Helper route and consistently validate loopback hosts,
  origins, request bodies, and provider permissions.
- Bound and validate streaming event frames, respect response backpressure, and
  propagate cancellation without leaving requests or child processes running.
- Compare runtime configuration by semantic JSON value to avoid unnecessary
  Helper restarts and preserve explicit provider environment settings.
- Scrub known credentials from diagnostics and keep standalone runtime extraction
  atomic, integrity-checked, and permission-restricted.
- Preserve configured Node runtimes for script CLIs, DeepSeek, and custom tools.
- Register item context menus through Zotero's MenuManager when available.
- Run shared runtime regressions in both Node.js and Zotero, with cross-platform
  build verification and isolated native Helper protocol smoke tests.

### Requirements And Limitations

Install and authenticate at least one provider CLI separately. Native Claude
Code and Codex use the bundled Helper; npm/script CLIs and custom MCP servers
retain their own runtime requirements. DeepSeek Harness requires Node.js 24+,
and Codex WSL MCP requires Node.js inside WSL. Portable fallback requires
Node.js 20+. Linux standalone binaries use glibc, not musl. Model access, usage
limits, and charges depend on the chosen provider.

The standard cross-platform XPI is approximately 204 MiB because it contains six
native runtimes. Bundled runtime licenses and upstream source/build references
are included under `content/helper/licenses`; see `docs/standalone-helper.md`.

### 简体中文

- 首个正式版，兼容 Zotero 7–10；支持 Claude Code、Codex 和实验性的 DeepSeek Harness。
- 支持论文问答、PDF 证据、批注与引用跳转、本地对话历史、MCP 和学术工作流。
- 标准 XPI 内置 macOS、Windows、Linux 的 arm64/x64 Helper；原生 Claude Code 和
  Codex 无需额外安装 Node.js，仍需单独安装并认证对应服务程序。
- 加固本地通信鉴权、流式事件校验、取消与背压处理、诊断隐私和运行时完整性检查。
- npm/脚本版 CLI、自定义 MCP 和 WSL 保留各自运行依赖；DeepSeek 需要 Node.js 24+。

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
