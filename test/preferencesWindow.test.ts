import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref, clearPref } from "../src/utils/prefs";
import { parseManagedMcpServers } from "../src/modules/mcpSettings";

describe("preferences window integration", function () {
  this.timeout(60_000);

  it("loads the packaged pane, localization, controls and theme borders", async function () {
    const panes = (
      Zotero.PreferencePanes as unknown as {
        pluginPanes: Array<{ id: string; pluginID: string }>;
      }
    ).pluginPanes;
    const pane = panes.find((entry) => entry.pluginID === config.addonID);
    assert.exists(pane);
    const previousPanel = getPref("settingsProvider");
    const previousCheck = getPref("setupChecked");
    const previousMcp = getPref("mcpServers");
    setPref("settingsProvider", "general");
    setPref("setupChecked", true);
    const prefs = Zotero.Utilities.Internal.openPreferences(pane!.id)!;
    try {
      let root: HTMLElement | null = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        root = prefs.document.querySelector<HTMLElement>(
          ".claudero-pref-stack",
        );
        if (root?.querySelector('[role="tab"][aria-selected="true"]')) break;
        await Zotero.Promise.delay(50);
      }
      assert.exists(root, "Packaged preference pane did not load");
      const l10n = (
        prefs.document as Document & {
          l10n: {
            ready: Promise<void>;
            translateFragment: (root: Element) => Promise<void>;
          };
        }
      ).l10n;
      await l10n.ready;
      await l10n.translateFragment(root!);
      assert.equal(root!.querySelectorAll('[role="tab"]').length, 7);
      const setup = root!.querySelector<HTMLButtonElement>(
        "#claudero-pref-setup-run",
      )!;
      assert.isNotEmpty(setup.textContent?.trim());
      const card = root!.querySelector<HTMLElement>(".claudero-pref-card")!;
      assert.equal(prefs.getComputedStyle(card).borderTopStyle, "solid");
      const node = root!.querySelector<HTMLInputElement>(
        "#zotero-prefpane-claudero-nodePath",
      )!;
      for (
        let attempt = 0;
        attempt < 100 && !node.getBoundingClientRect().width;
        attempt++
      ) {
        await Zotero.Promise.delay(50);
      }
      assert.isAbove(node.getBoundingClientRect().width, 0);
      root!
        .querySelector<HTMLButtonElement>("#claudero-pref-tab-codex")!
        .click();
      assert.isFalse(
        root!.querySelector<HTMLElement>("#claudero-pref-panel-codex")!.hidden,
      );
      root!
        .querySelector<HTMLButtonElement>("#claudero-pref-tab-general")!
        .click();
      root!.querySelector<HTMLButtonElement>("#claudero-pref-tab-mcp")!.click();
      const mcpPanel = root!.querySelector<HTMLElement>(
        "#claudero-pref-panel-mcp",
      )!;
      const editor = mcpPanel.querySelector<HTMLTextAreaElement>(
        "#claudero-pref-mcp-servers",
      )!;
      editor.value = "{}";
      const originalPrompt = prefs.prompt;
      const originalAlert = prefs.alert;
      let answers: string[] = [];
      const alerts: string[] = [];
      prefs.prompt = () => answers.shift() ?? null;
      prefs.alert = (message) => alerts.push(String(message));
      try {
        for (const type of ["http", "sse"]) {
          const button = mcpPanel.querySelector<HTMLButtonElement>(
            `#claudero-pref-mcp-add-${type}`,
          )!;
          assert.exists(button, `${type} action belongs in the MCP panel`);
          assert.isNotEmpty(button.textContent?.trim());
          answers = [`fixture-${type}`, `http://127.0.0.1:3030/${type}`];
          button.click();
          assert.equal(parseManagedMcpServers()[`fixture-${type}`].type, type);
        }
        const saved = String(getPref("mcpServers"));
        answers = ["fixture-http", "http://127.0.0.1:9999/new"];
        mcpPanel
          .querySelector<HTMLButtonElement>("#claudero-pref-mcp-add-http")!
          .click();
        assert.lengthOf(alerts, 1);
        assert.equal(getPref("mcpServers"), saved);
        editor.value = "{";
        answers = ["another", "http://127.0.0.1:9999/new"];
        mcpPanel
          .querySelector<HTMLButtonElement>("#claudero-pref-mcp-add-http")!
          .click();
        assert.equal(editor.value, "{");
        assert.equal(getPref("mcpServers"), saved);
      } finally {
        prefs.prompt = originalPrompt;
        prefs.alert = originalAlert;
      }
    } finally {
      prefs.close();
      if (previousPanel === undefined) clearPref("settingsProvider");
      else setPref("settingsProvider", previousPanel);
      if (previousCheck === undefined) clearPref("setupChecked");
      else setPref("setupChecked", previousCheck);
      if (previousMcp === undefined) clearPref("mcpServers");
      else setPref("mcpServers", previousMcp);
    }
  });
});
