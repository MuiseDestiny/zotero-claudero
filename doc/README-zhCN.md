# Claudero

[English](../README.md) | [简体中文](README-zhCN.md)

Claudero 是一个 Zotero 插件，将三种 agent 运行时集成到 Zotero 工作区：
**Claude Code**、**Codex** 和 **DeepSeek Harness**。它面向需要读取 Zotero
条目、PDF 阅读器状态、批注、笔记和本地附件的科研对话。

插件会启动本地 Node.js helper，并将请求交给 Zotero 首选项中选择的 provider
CLI：

```text
Zotero 面板 -> 本地 helper -> provider 适配器 -> Claude / Codex / DeepSeek
```

## 支持的平台

Claudero 面向 **Zotero 7 及更高版本**（当前 manifest 接受 Zotero 7 到 10），
支持 Zotero 所支持的桌面操作系统：

| 主机系统 | Claude Code               | Codex           | DeepSeek Harness     |
| -------- | ------------------------- | --------------- | -------------------- |
| macOS    | 原生 CLI                  | 原生 CLI        | 原生 `dsh`           |
| Windows  | 原生 CLI 或可执行文件路径 | 原生 CLI 或 WSL | 原生 `dsh.cmd`/`dsh` |
| Linux    | 原生 CLI                  | 原生 CLI        | 原生 `dsh`           |

三个操作系统使用同一个插件构建包。插件会从常见目录自动发现 CLI，也可以在
首选项中按设备覆盖路径。Windows 上可以让 Codex 运行在 WSL 中；将安装方式
设置为 **WSL**，并按需填写发行版名称。

### 运行环境要求

- Zotero 7 或更高版本。
- Node.js 20 或更高版本用于本地 helper，推荐使用 Node.js LTS。
- 可访问 provider 服务的网络和有效凭据。
- 选定 provider 对应的 CLI；DeepSeek 可以直接从 Claudero 的缺少 CLI 警告中安装。
- DeepSeek Harness `0.1.0-rc.6` 需要 Node.js 24 API。Claudero 会自动查找兼容
  的 Node；也可以在 DeepSeek 环境变量中设置 `DSH_NODE_PATH` 覆盖自动选择。

## 安装

### 安装发布包

从项目 Releases 下载适合你的 Zotero 版本的 `.xpi`，然后在 Zotero 中打开
**工具 -> 插件 -> 齿轮菜单 -> 从文件安装插件**。如 Zotero 提示，请重启 Zotero。

### 从源码构建

```bash
git clone https://github.com/MuiseDestiny/zotero-claudero.git
cd zotero-claudero
npm install
npm run build
```

生产构建包位于 `.scaffold/build/claudero.xpi`，可使用上面的 Zotero 插件安装器
安装。

开发时，`npm start` 会启动脚手架服务器，并用开发构建启动 Zotero。先复制
`.env.example` 为 `.env`，按需设置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 和
`ZOTERO_PLUGIN_PROFILE_PATH`。

## 选择 Provider

打开 **Zotero 首选项 -> Claudero**，选择默认 provider。每个 provider 都有独立的
CLI 路径和环境变量面板。路径留空时使用自动发现，也可以填写绝对路径。

### Claude Code

按照 Claude Code CLI 的官方流程安装并认证，或者在 Claude provider 环境中设置：

```dotenv
ANTHROPIC_API_KEY=...
# 可选：
# ANTHROPIC_BASE_URL=https://your-compatible-endpoint.example
```

Claude 集成支持流式响应、provider 原生会话、图片附件、Zotero MCP 工具、计划
模式、provider 命令、compact、分叉、回滚、权限询问，以及 Claude 模型和 effort
控制。

### Codex

按照 Codex CLI 的官方流程安装并认证，或者配置 API 兼容环境：

```dotenv
OPENAI_API_KEY=...
# 可选：
# OPENAI_BASE_URL=https://your-compatible-endpoint.example
# OPENAI_MODEL=...
```

Windows 用户可在 Codex 首选项中选择 **Native** 或 **WSL**。Codex 集成支持流式
响应、原生 thread、图片附件、Zotero MCP 工具、计划模式、分叉、回滚、compact、
权限询问和按模型提供的 reasoning effort。安全模式可选 **Workspace write** 或
**Read only**。

### DeepSeek Harness

DeepSeek 通过官方 headless 命令 `dsh --profile headless` 接入。目前属于开发者
预览集成，不提供交互式登录命令。

在 DeepSeek provider 环境中设置：

```dotenv
DEEPSEEK_API_KEY=...
# 可选：
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DSH_MODEL=deepseek-v4-flash
# DSH_HOME=/path/to/.dsh
# DSH_NODE_PATH=/path/to/node24
```

也可以手动安装：

```bash
npm install -g @deepseek-ai/dsh@latest
```

或者直接在 Claudero 中选择 DeepSeek 并发送请求。若找不到 `dsh`，Claudero 会
显示 **Install DeepSeek Harness** 按钮。该按钮会在 macOS、Windows 和 Linux
上将托管副本安装到 `~/.claudero/deepseek`，然后保存发现的 CLI 路径。安装需要
用户点击确认，Claudero 不会静默安装软件包。`dsh web` 只会打开浏览器界面，不能
代替 Claudero 所需的 CLI。

DeepSeek 支持文本对话以及 `deepseek-v4-flash`、`deepseek-v4-pro` 模型。目前不
支持图片附件、Zotero MCP、provider slash command、计划审批、分叉、回滚、compact
或 provider 原生会话恢复。每轮 headless 请求都是独立进程，因此由 Claudero
自行重放可见对话历史。每次重放最近 16 条非空消息，Zotero 重启后重新打开保存的
会话也会重放历史。

## 功能

### Zotero 感知的科研对话

对话输入框可以使用：

- 当前选中的文库条目和集合。
- 条目元数据、作者、摘要、标签、子笔记和附件路径。
- 当前 PDF 附件和阅读器选区。
- 选中的文本和 Zotero 批注（包括页码信息）。
- 可用的本地 PDF 文件和 Zotero 全文缓存。

当前上下文会自动附加。Claude 和 Codex 可以在上下文缺失或过期时通过 Zotero
工具获取更完整的数据。DeepSeek 会收到序列化后的上下文和重放文本，但当前集成
没有 Zotero MCP 工具桥。

### 证据和引用

Claude 和 Codex 可以使用内置 Zotero MCP 证据工具：

- 搜索论文并返回编号证据。
- 定位并验证精确引文。
- 将文档地图展开为相关页码范围。
- 使用渲染后的 PDF 页面检查图和表。
- 验证主张并发现相互矛盾的证据。

回答中的证据标记会变成低干扰的可点击链接，打开对应的 Zotero PDF 页面、批注
或条目。DeepSeek 仍可以根据 prompt 和重放文本回答，但在当前集成中没有 MCP
证据桥。

### 学术工作流和 Skills

普通自然语言请求在合适时会路由到内置工作流：

- 总结论文。
- 提取研究方法。
- 构建文献矩阵。
- 验证引用。

Skill 可以声明所需的 Zotero 上下文、输出格式和工具策略。导入的 `SKILL.md`、
MCP prompt、Markdown 和 JSON skill 默认禁用，审核后才会启用。学术 skill 默认
只读 Zotero，不允许联网搜索或执行脚本，除非用户明确修改策略。

### 对话和交互

- 流式回答、思考块、工具卡片和用量活动信息。
- 持久化对话历史，重启 Zotero 后自动重新打开。
- provider 无法原生恢复会话时，自动重放跨 provider 历史。
- 编辑用户消息、重试、复制、搜索、重命名和删除对话。
- provider 专属模型和 reasoning effort 控制。
- 交互式工具操作的权限对话框。
- 用户可选择将最终回答插入 Zotero 笔记。
- Helper 健康状态、运行时状态、诊断信息和事件 trace 导出。

## 首选项

General 面板包含跨 provider 的设置：

- **Default provider**：Claude、Codex 或 DeepSeek Harness。
- **Node.js path**：留空自动发现，或填写绝对路径。
- **Workspace path**：provider 进程的工作目录。留空使用
  `<Zotero profile>/claudero/workspace`。
- **Helper port**：本地 Node helper 使用的 HTTP 端口，默认 `38660`。
- **Proxy**：可选的 HTTP/HTTPS 网络代理。
- **Environment variables**：每行一个 `KEY=VALUE`。provider 专属变量通常应
  填在对应 provider 面板。

MCP 面板可以启用内置 Zotero server，并配置外部 stdio 或 HTTP/SSE MCP server。
Skills 面板用于管理内置和导入的学术 skill。Diagnostics 面板可以刷新运行时状态、
导出诊断信息和重启 provider 服务。

输入框权限模式包括 **Auto**、**Ask permissions**、**Accept edits**、**Plan**、
**Don't ask** 和 **Bypass permissions**。实际可用模式和工具操作仍受所选 provider
能力限制。

不要将 API key 或其他密钥提交到仓库。优先使用 provider 环境变量面板或 provider
自己的凭据存储。

## 安全模型

插件 UI 与本地 helper 只通过 loopback 通信。Provider 工具受当前权限模式和 provider
安全设置约束。学术工作流默认只读；修改 Zotero 的工具需要用户批准，支持的修改会
记录到 undo 栈。回答会先显示在面板中，用户再决定是否插入为笔记。

漏洞报告和安全边界参见 [SECURITY.md](../SECURITY.md)，Provider 数据流、本地存储和
诊断导出说明参见 [PRIVACY.md](../PRIVACY.md)。

## 故障排查

### 找不到 Provider CLI

将路径留空并重新打开面板以触发自动发现，或在 provider 面板填写绝对路径。DeepSeek
可以点击警告卡中的 **Install DeepSeek Harness**，安装完成后重试。

### DeepSeek 报 Node.js 兼容性错误

安装 Node.js 24 或更高版本；如果不在标准路径，将其可执行文件设置到
`DSH_NODE_PATH`。`dsh web` 与 Claudero 使用的 headless CLI 无关。

### 认证或网络错误

检查 provider 的 API key/登录状态、base URL、代理和 Diagnostics 面板。环境变量会
传给 provider 子进程，修改后可能需要重启 provider runtime。

### PDF 证据不完整

在 Zotero Reader 中打开附件，并确认 Zotero 已建立索引。检查图表时保持 PDF 打开，
这样才能使用页面渲染能力。

## 开发和验证

```bash
npm install
npm run check:release
npm test
npm run lint:check
npm run audit:all
npm run test:runtime
npm run test:helper:mock
npm run test:evidence:ci
```

Helper smoke test 用于检查本地 HTTP 协议，可以针对当前机器上已安装的 provider
运行：

```bash
npm run test:helper:quick
npm run test:helper -- --providers deepseek
```

`npm test` 会运行 Zotero 浏览器测试，因此需要本机的 Zotero 程序和测试 profile。
mock helper 测试不需要 provider 登录。正式发布前应完整运行 CI，并在干净的 Zotero
profile 中安装生成的 XPI 做一次启动和对话验收。

完整的自动与人工发布门槛见
[docs/release-checklist.md](../docs/release-checklist.md)。

更多架构信息请阅读
[doc/agent-architecture.md](agent-architecture.md)，其中介绍 provider 适配器、
helper 协议、事件 trace、学术 skills 和 MCP 架构。

## 许可证

Claudero 使用 [AGPL-3.0-or-later](../LICENSE) 许可证。
