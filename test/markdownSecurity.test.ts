import { assert } from "chai";
import MarkdownIt from "markdown-it";
import { markdownItKatex } from "../src/shared/markdownKatexPlugin";

describe("Markdown and KaTeX rendering security", function () {
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
  }).use(markdownItKatex, { throwOnError: false });

  it("renders normal inline and block math", function () {
    const html = renderer.render(
      "Inline $x^2$ and block:\n\n$$\ny = mx + b\n$$",
    );
    assert.include(html, 'class="katex"');
    assert.include(html, 'class="katex-block"');
  });

  it("does not emit executable HTML or javascript links from model text", function () {
    const html = renderer.render(
      [
        '<img src=x onerror="alert(1)">',
        "",
        "$\\href{javascript:alert(1)}{unsafe}$",
        "",
        "$\\url{javascript:alert(1)}$",
      ].join("\n"),
    );
    assert.notMatch(html, /<img\b/i);
    assert.notMatch(html, /<[^>]+\sonerror\s*=/i);
    assert.notMatch(html, /href\s*=\s*["']javascript:/i);
  });

  it("escapes invalid math in error output", function () {
    const html = renderer.render("$\\invalid{<img src=x onerror=alert(1)>}$");
    assert.notMatch(html, /<img\b/i);
    assert.notMatch(html, /<[^>]+\sonerror\s*=/i);
  });
});
