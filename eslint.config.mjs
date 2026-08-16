// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      files: ["scripts/**/*.mjs"],
      languageOptions: {
        globals: Object.fromEntries(
          [
            "AbortController",
            "TextDecoder",
            "clearTimeout",
            "console",
            "fetch",
            "performance",
            "process",
            "setTimeout",
          ].map((name) => [name, "readonly"]),
        ),
      },
    },
    {
      files: ["test/**/*.ts"],
      rules: {
        "mocha/no-setup-in-describe": "off",
      },
    },
    {
      files: ["typings/**/*.d.ts"],
      rules: {
        "no-var": "off",
      },
    },
    {
      files: ["src/helper/runtime/codexCompatibility.ts"],
      rules: {
        "no-control-regex": "off",
      },
    },
  ],
});
