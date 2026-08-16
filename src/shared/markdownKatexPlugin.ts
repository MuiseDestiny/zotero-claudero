import markdownItKatexImport from "@vscode/markdown-it-katex";

type MarkdownItKatexPlugin = typeof markdownItKatexImport;

const imported = markdownItKatexImport as
  | MarkdownItKatexPlugin
  | { default: MarkdownItKatexPlugin };

export const markdownItKatex: MarkdownItKatexPlugin =
  typeof imported === "function" ? imported : imported.default;
