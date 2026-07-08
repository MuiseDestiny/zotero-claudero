declare module "markdown-it-katex" {
  import type MarkdownIt from "markdown-it";

  interface MarkdownItKatexOptions {
    throwOnError?: boolean;
    errorColor?: string;
  }

  const markdownItKatex: MarkdownIt.PluginWithOptions<MarkdownItKatexOptions>;
  export default markdownItKatex;
}
