import { assert } from "chai";
import MarkdownIt from "markdown-it";
import katex from "katex";
import { markdownItKatex } from "../src/shared/markdownKatexPlugin";
import { normalizeMarkdownStrongSpacing } from "../src/shared/markdownNormalization";

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

  it("repairs spaces placed before closing bold markers", function () {
    const source = "- **研究问题： **能否利用卫星数据？";
    const normalized = normalizeMarkdownStrongSpacing(source);
    const html = renderer.render(normalized);

    assert.equal(normalized, "- **研究问题：** 能否利用卫星数据？");
    assert.include(html, "<strong>研究问题：</strong> 能否利用卫星数据？");
  });

  it("does not rewrite bold-like text inside code", function () {
    const source = ["`**inline **`", "", "```text", "**fenced **", "```"].join(
      "\n",
    );

    assert.equal(normalizeMarkdownStrongSpacing(source), source);
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

  it("does not inherit trusted rendering from polluted Object.prototype", function () {
    const names = ["trust", "default", "processor"];
    const originals = names.map((name) =>
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    );
    const attack = String.raw`\href{javascript:alert(1)}{unsafe}\includegraphics{https://example.invalid/private.png}`;
    let html = "";
    try {
      // GHSA-238p-pmpm-9mq7 also affects inherited setting metadata.
      for (const name of names) {
        Object.defineProperty(Object.prototype, name, {
          value: name === "processor" ? () => true : true,
          configurable: true,
          writable: true,
        });
      }
      html = renderer.render(`$${attack}$\n\n$$\n${attack}\n$$`);
    } finally {
      names.forEach((name, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(Object.prototype, name, original);
        else Reflect.deleteProperty(Object.prototype, name);
      });
    }
    assert.include(html, 'class="katex"');
    assert.include(html, 'class="katex-block"');
    assert.notMatch(html, /<a\b|<img\b/i);
    assert.notMatch(html, /href\s*=\s*["']javascript:/i);
  });

  it("ignores inherited trust on a renderer options object", function () {
    const options = Object.assign(Object.create({ trust: true }), {
      throwOnError: false,
    });
    const html = katex.renderToString(
      String.raw`\href{javascript:alert(1)}{unsafe}`,
      options,
    );
    assert.notMatch(html, /<a\b/i);
  });

  it("does not treat inherited macros as defined namespace entries", function () {
    const macros = Object.create({ "\\clauderoPollutedMacro": "POLLUTED" });
    const html = katex.renderToString(String.raw`\clauderoPollutedMacro`, {
      macros,
      throwOnError: false,
    });
    assert.notInclude(html, "POLLUTED");
    assert.include(html, "\\clauderoPollutedMacro");
    assert.isFalse(Object.hasOwn(macros, "\\clauderoPollutedMacro"));
  });

  it("escapes invalid math in error output", function () {
    const html = renderer.render("$\\invalid{<img src=x onerror=alert(1)>}$");
    assert.notMatch(html, /<img\b/i);
    assert.notMatch(html, /<[^>]+\sonerror\s*=/i);
  });
});
