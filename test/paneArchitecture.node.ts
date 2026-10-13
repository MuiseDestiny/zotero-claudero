import { assert } from "chai";
import fs from "node:fs";
import { createRequire as createProjectRequire } from "node:module";
import path from "node:path";

// The runtime runner bundles tests as ESM; preserve TypeScript's Node environment.
const ts: typeof import("typescript") = createProjectRequire(
  path.resolve("package.json"),
)("typescript");

describe("pane module architecture", function () {
  const dir = path.resolve("src/modules");
  const files = fs.readdirSync(dir).filter((name) => /^pane.*\.ts$/.test(name));
  const imports = new Map(
    files.map((name) => {
      const file = ts.createSourceFile(
        name,
        fs.readFileSync(path.join(dir, name), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const dependencies = file.statements
        .filter(ts.isImportDeclaration)
        .map((declaration) => {
          const clause = declaration.importClause;
          const bindings = clause?.namedBindings;
          const typeOnly =
            clause?.isTypeOnly ||
            (!clause?.name &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((element) => element.isTypeOnly));
          return {
            from: (
              declaration.moduleSpecifier as import("typescript").StringLiteral
            ).text,
            typeOnly,
          };
        });
      return [name, dependencies] as const;
    }),
  );

  it("never imports the pane controller from an extracted module", function () {
    for (const [name, dependencies] of imports) {
      assert.isFalse(
        dependencies.some((dep) => dep.from.endsWith("/clauderoPane")),
        name,
      );
    }
  });

  it("keeps runtime dependencies between pane modules acyclic", function () {
    function visit(name: string, ancestors: string[]) {
      assert.notInclude(ancestors, name, [...ancestors, name].join(" -> "));
      for (const dependency of imports.get(name) || []) {
        const target = `${path.basename(dependency.from)}.ts`;
        if (!dependency.typeOnly && imports.has(target))
          visit(target, [...ancestors, name]);
      }
    }
    for (const name of files) visit(name, []);
  });

  it("keeps rendering independent of request and conversation orchestration", function () {
    for (const name of [
      "paneContextView.ts",
      "paneImageView.ts",
      "paneMessageView.ts",
      "paneStreamingView.ts",
    ]) {
      for (const dependency of imports.get(name) || []) {
        if (!dependency.typeOnly)
          assert.notInclude(
            [
              "./claudeHelperClient",
              "./conversationController",
              "./paneConversationActions",
              "./panePromptRequest",
              "./paneSlashRequest",
              "./paneRequestServices",
            ],
            dependency.from,
            name,
          );
      }
    }
  });

  it("keeps prompt and slash execution independently injectable", function () {
    for (const [name, other] of [
      ["panePromptRequest.ts", "./paneSlashRequest"],
      ["paneSlashRequest.ts", "./panePromptRequest"],
    ]) {
      const runtimeImports = imports
        .get(name)!
        .filter((dependency) => !dependency.typeOnly)
        .map((dependency) => dependency.from);
      assert.notInclude(runtimeImports, other, name);
      assert.notInclude(runtimeImports, "./claudeHelperClient", name);
      assert.include(runtimeImports, "./paneRequestServices", name);
    }
  });

  it("keeps request transport and send function bodies out of the controller", function () {
    const file = ts.createSourceFile(
      "clauderoPane.ts",
      fs.readFileSync(path.join(dir, "clauderoPane.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement))
        assert.notInclude(
          ["sendPrompt", "sendRawSlashCommand"],
          statement.name?.text,
        );
      if (ts.isImportDeclaration(statement)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          assert.isFalse(
            bindings.elements.some(
              (element) =>
                (element.propertyName || element.name).text ===
                "queryClaudeHelper",
            ),
          );
      }
    }
  });
});
