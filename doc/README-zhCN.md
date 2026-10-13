# Claudero

[English](../README.md) | [简体中文](README-zhCN.md)

**Zotero 内的 AI 科研助手，由 Claude Code、Codex 和 DeepSeek Harness 驱动。**

在 Zotero 中直接提问、比较文献、分析批注，并从回答跳回原文。

## 功能

- 阅读选中的论文、元数据、笔记、PDF 选区和批注。
- 获取原文证据、定位引文、检查图表，并通过链接跳转到对应的 Zotero 来源。
- 使用学术工作流总结论文、提取方法、整理文献矩阵和检查引用。
- 保存与重开对话、编辑或重试消息，将回答插入 Zotero 笔记。
- 选择模型、推理强度、权限模式和外部 MCP 工具。

## 安装与使用

Claudero 支持 macOS、Windows 和 Linux 上的 **Zotero 7–10**。

1. 从 [GitHub Releases](https://github.com/MuiseDestiny/zotero-claudero/releases)
   下载 `claudero.xpi`。
2. 在 Zotero 中打开 **工具 -> 插件 -> 齿轮菜单 -> 从文件安装插件**，选择 XPI。
3. 安装 **Node.js 20+** 和下表中的至少一种服务程序。推荐 Node.js 24 LTS；
   DeepSeek 需要 Node.js 24+。
4. 打开 **Zotero 首选项 -> Claudero**，选择服务，在 **查看检测详情** 中完成配置。
   插件会自动发现已有程序，多数用户可以将程序路径留空。
5. 选中论文或打开 PDF，打开 Claudero 面板并提问。

| 服务             | 所需程序        | 身份验证                            |
| ---------------- | --------------- | ----------------------------------- |
| Claude           | Claude Code CLI | 已有 CLI 登录或 `ANTHROPIC_API_KEY` |
| Codex            | Codex CLI       | 已有 CLI 登录或 `OPENAI_API_KEY`    |
| DeepSeek Harness | `dsh`           | 已有 dsh 凭据或 `DEEPSEEK_API_KEY`  |

Claude Code 和 Codex 请按各自官方流程安装并完成认证。DeepSeek 未安装时，可以
点击 Claudero 中的 **Install DeepSeek Harness**，也可以执行
`npm install -g @deepseek-ai/dsh@latest`。DeepSeek 集成属于实验性功能。

Windows 上也可以在 WSL 中运行 Codex：在设置中选择 **WSL**，并在所选发行版内登录。

模型权限、额度和费用取决于所选服务。Claudero 不附赠服务凭据或模型访问权限。

## 工作原理

Claudero 通过独立的本地 Node.js Helper，将 Zotero 连接到本机安装的 Agent
运行时。它不训练模型，也不运营独立的 AI 后端。

```text
Zotero：你的问题 + 当前选中的科研上下文
    -> 本地 Node.js Helper
        -> Claude Agent SDK -> Claude Code
        -> Codex app-server
        -> DeepSeek Harness headless CLI
    -> 配置的 AI 服务

Claude / Codex -> Zotero MCP 工具 -> 文库、阅读器和证据
```

发送问题时，插件从当前选区和 PDF 阅读器收集轻量上下文，而不是自动上传整个文库。
Claude 和 Codex 可以通过 **MCP（模型上下文协议）** 工具进一步获取条目信息、
笔记、批注和 PDF 证据。

论文问答工具返回原文段落和位置。长文档可以按章节或页码范围展开；图表问题可以
使用渲染后的 PDF 页面。回答中的来源链接会打开对应的 Zotero 条目、批注或 PDF
页面，方便核对，但不保证模型的解释正确。

学术 Skill 将常见请求组织为结构化工作流，例如论文总结和文献矩阵。
导入的 Skill 默认禁用，审核后再启用。

对话保存在本地。Claude 和 Codex 在可用时续接原生会话；DeepSeek 每轮重放近期
对话文本。中断后可以主动选择从已保存历史重试，但重试不会撤销已经完成的工具操作。

## 服务差异

| 能力              | Claude       | Codex          | DeepSeek Harness |
| ----------------- | ------------ | -------------- | ---------------- |
| 文本对话          | 支持         | 支持           | 支持             |
| 实时流式回答      | 支持         | 支持           | 仅最终回答       |
| 图片输入          | 支持         | 支持           | 不支持           |
| Zotero / 外部 MCP | 支持         | 支持           | 不支持           |
| 计划模式          | 支持         | 支持           | 不支持           |
| 会话续接          | 原生 session | 原生 thread    | 重放近期文本     |
| 分叉对话          | 历史重放     | 原生分叉或重放 | 不支持           |
| 压缩上下文        | 支持         | 支持           | 不支持           |
| 服务原生斜杠命令  | 支持         | 不支持         | 不支持           |
| 推理强度          | 支持         | 取决于模型     | 不支持           |

## 设置

多数用户只需选择服务。**高级设置** 提供以下可选配置：

- **程序路径：** 留空自动发现；自定义安装可填写绝对路径。
- **工作目录：** Agent 的工作目录，留空使用 `<Zotero profile>/claudero/workspace`。
- **代理：** 留空继承进程环境，或填写用于服务连接的 HTTP/HTTPS 代理。
- **环境变量：** 在对应服务设置中每行填写一个 `KEY=VALUE`，服务变量覆盖通用变量。

**MCP** 管理 Zotero 和外部工具；**Skills** 管理学术工作流；
**Diagnostics / 诊断** 显示连接状态并提供服务重启入口。

## 隐私与权限

Helper 在本地运行，但所选服务可能将问题、论文文本、笔记、对话历史和图片
发送到配置的远程 API。外部 MCP 服务会接收对应的工具参数。Claudero 不加入产品遥测。

内置 Zotero 写入工具需要批准，或沿用你明确选择记住的匹配批准。
授予访问前，请检查文件、脚本和外部工具权限。对话历史保存在
`<Zotero profile>/claudero`；设置中填写的 API key 保存在 Zotero 首选项中，
可用时优先使用服务原生的凭据存储。

详见 [隐私说明](../PRIVACY.md) 和 [安全说明](../SECURITY.md)。

## 关于 AI 辅助开发

Claudero 采用 AI 辅助开发，包括代码编写、重构、测试和文档。
AI 辅助不替代维护者责任与人工审查。重要科研回答请对照原论文核验。

## 许可证

[AGPL-3.0-or-later](../LICENSE)。
