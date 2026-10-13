import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref, clearPref } from "../src/utils/prefs";
import { parseManagedMcpServers } from "../src/modules/mcpSettings";
import { getAcademicSkillRecords } from "../src/modules/academicSkills";
import {
  getProviderCliPath,
  setProviderCliPath,
} from "../src/modules/providerRegistry";

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
    const previousDetection = getPref("autoDetectedPaths");
    const previousNode = getPref("nodePath");
    const previousMcp = getPref("mcpServers");
    const previousProvider = getPref("provider");
    const previousConfigs = getPref("providerConfigs");
    const previousClaudePath = getPref("claudePath");
    const previousSkills = getPref("academicSkills");
    setPref("academicSkills", "");
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
      for (let attempt = 0; attempt < 100 && setup.disabled; attempt++) {
        await Zotero.Promise.delay(50);
      }
      assert.isFalse(
        setup.disabled,
        "Local detection finishes without a click",
      );
      assert.lengthOf(
        root!.querySelectorAll(
          "#claudero-pref-setup-details .claudero-pref-setup-row",
        ),
        3,
        "Opening preferences checks local programs and explains unverified authentication",
      );
      const authRow = root!.querySelector(
        "#claudero-pref-setup-details .claudero-pref-setup-row:last-child",
      )!;
      assert.isTrue(authRow.classList.contains("info"));
      for (const button of root!.querySelectorAll<HTMLButtonElement>(
        "#claudero-pref-setup-details button",
      )) {
        assert.equal(button.type, "button");
        assert.isNotEmpty(button.textContent?.trim());
        assert.notInclude(button.textContent, "pref-setup-action-");
      }
      assert.notInclude(
        root!.textContent,
        "claudero-pref-detect-",
        "Dynamic detection messages must load their localization resource",
      );
      assert.notExists(
        root!.querySelector("#zotero-prefpane-claudero-helperPort"),
      );
      assert.notExists(root!.querySelector("#claudero-pref-host-key"));
      const provider = root!.querySelector<HTMLElement & { value: string }>(
        "#zotero-prefpane-claudero-provider",
      )!;
      provider.value = "codex";
      setPref("provider", "codex");
      const command = prefs.document.createEvent("Event");
      command.initEvent("command", true, false);
      provider.querySelector('menuitem[value="codex"]')!.dispatchEvent(command);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          root!
            .querySelector("#claudero-pref-setup-details")!
            .textContent?.includes("codex CLI")
        )
          break;
        await Zotero.Promise.delay(50);
      }
      assert.include(
        root!.querySelector("#claudero-pref-setup-details")!.textContent,
        "codex CLI",
        "Choosing a provider refreshes detection automatically",
      );
      const card = root!.querySelector<HTMLElement>(".claudero-pref-card")!;
      assert.equal(prefs.getComputedStyle(card).borderTopStyle, "solid");
      const node = root!.querySelector<HTMLInputElement>(
        "#zotero-prefpane-claudero-nodePath",
      )!;
      const advanced = root!.querySelector<HTMLDetailsElement>(
        "#claudero-pref-general-advanced",
      )!;
      assert.isFalse(advanced.open);
      const workspace = root!.querySelector<HTMLInputElement>(
        "#zotero-prefpane-claudero-workspacePath",
      )!;
      assert.equal(workspace.closest("details"), advanced);
      assert.equal(workspace.getBoundingClientRect().width, 0);
      for (const provider of ["claude", "codex", "deepseek"]) {
        const environment = root!.querySelector<HTMLTextAreaElement>(
          `#claudero-pref-${provider}-env`,
        )!;
        assert.equal(
          environment.closest("details")?.id,
          `claudero-pref-${provider}-advanced`,
          "Provider environment variables are optional advanced overrides",
        );
      }
      assert.equal(node.getBoundingClientRect().width, 0);
      advanced.querySelector<HTMLElement>("summary")!.click();
      assert.isTrue(advanced.open);
      for (
        let attempt = 0;
        attempt < 100 && !node.getBoundingClientRect().width;
        attempt++
      ) {
        await Zotero.Promise.delay(50);
      }
      assert.isAbove(node.getBoundingClientRect().width, 0);
      const claudePath = root!.querySelector<HTMLInputElement>(
        "#claudero-pref-claude-path",
      )!;
      claudePath.value = "";
      setProviderCliPath("claude", "/detected/claude");
      const blur = prefs.document.createEvent("Event");
      blur.initEvent("blur", false, false);
      claudePath.dispatchEvent(blur);
      assert.equal(
        getProviderCliPath("claude"),
        "/detected/claude",
        "Unedited blur must not overwrite a detected path",
      );
      claudePath.value = "/manual/claude";
      const pathChange = prefs.document.createEvent("Event");
      pathChange.initEvent("change", true, false);
      claudePath.dispatchEvent(pathChange);
      assert.equal(
        getProviderCliPath("claude"),
        "/manual/claude",
        "Explicit edits still save immediately",
      );
      root!
        .querySelector<HTMLButtonElement>("#claudero-pref-tab-codex")!
        .click();
      assert.isFalse(
        root!.querySelector<HTMLElement>("#claudero-pref-panel-codex")!.hidden,
      );
      const wslOption = root!.querySelector<HTMLElement>(
        '#claudero-pref-codex-installation menuitem[value="wsl"]',
      );
      assert.exists(wslOption);
      assert.equal(
        Boolean((wslOption as HTMLElement & { disabled?: boolean }).disabled),
        !Zotero.isWin,
      );
      const codexAdvanced = root!.querySelector<HTMLDetailsElement>(
        "#claudero-pref-codex-advanced",
      )!;
      assert.isFalse(codexAdvanced.open);
      codexAdvanced.open = true;
      const installationRow = root!.querySelector<HTMLElement>(
        "#claudero-pref-codex-installation-row",
      )!;
      assert.equal(installationRow.hidden, !Zotero.isWin);
      if (!Zotero.isWin) {
        assert.equal(prefs.getComputedStyle(installationRow).display, "none");
        assert.isTrue(
          root!.querySelector<HTMLElement>(
            "#claudero-pref-codex-wsl-distro-row",
          )!.hidden,
        );
      }
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
      const mcpAdvanced = mcpPanel.querySelector<HTMLDetailsElement>(
        "#claudero-pref-mcp-advanced",
      )!;
      assert.isFalse(mcpAdvanced.open);
      assert.equal(editor.getBoundingClientRect().width, 0);
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
        const list = mcpPanel.querySelector<HTMLElement>(
          "#claudero-pref-mcp-list",
        )!;
        const firstCard = list.firstElementChild;
        for (let i = 0; i < 5; i++) {
          editor.value += " ";
          const input = prefs.document.createEvent("Event");
          input.initEvent("input", true, false);
          editor.dispatchEvent(input);
        }
        assert.strictEqual(
          list.firstElementChild,
          firstCard,
          "Typing does not rebuild all cards for every keystroke",
        );
        assert.isTrue(
          list.hasAttribute("inert"),
          "Old card actions wait for the current JSON",
        );
        await Zotero.Promise.delay(200);
        assert.notStrictEqual(list.firstElementChild, firstCard);
        assert.isFalse(list.hasAttribute("inert"));
        answers = ["fixture-http", "http://127.0.0.1:9999/new"];
        mcpPanel
          .querySelector<HTMLButtonElement>("#claudero-pref-mcp-add-http")!
          .click();
        assert.lengthOf(alerts, 1);
        assert.equal(getPref("mcpServers"), saved);
        editor.value = "{";
        const change = prefs.document.createEvent("Event");
        change.initEvent("change", true, false);
        editor.dispatchEvent(change);
        assert.isTrue(
          mcpAdvanced.open,
          "Invalid JSON stays visible for repair",
        );
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
      root!
        .querySelector<HTMLButtonElement>("#claudero-pref-tab-skills")!
        .click();
      const skills = root!.querySelector<HTMLElement>(
        "#claudero-pref-panel-skills",
      )!;
      const editSkill = () =>
        skills.querySelector<HTMLButtonElement>(
          '[data-skill-edit="summarize-paper"]',
        )!;
      editSkill().click();
      const draft = skills.querySelector<HTMLTextAreaElement>(
        ".claudero-pref-skill-editor textarea",
      )!;
      assert.exists(
        draft,
        "Editing works inside the packaged preferences pane",
      );
      assert.isAbove(draft.getBoundingClientRect().width, 0);
      const originalDraft = draft.value;
      const savedSkills = getPref("academicSkills");
      draft.value = "{";
      skills.querySelector<HTMLButtonElement>("[data-skill-save]")!.click();
      assert.equal(
        draft.value,
        "{",
        "Invalid drafts remain available to repair",
      );
      assert.equal(getPref("academicSkills"), savedSkills);
      assert.isNotEmpty(
        skills.querySelector(".claudero-pref-skill-editor [role=status]")!
          .textContent,
      );
      editSkill().click();
      assert.lengthOf(
        skills.querySelectorAll(".claudero-pref-skill-editor"),
        1,
      );
      assert.equal(draft.value, "{", "Reopening an editor preserves the draft");
      const editedSkill = JSON.parse(originalDraft);
      editedSkill.title = "Edited workflow fixture";
      draft.value = JSON.stringify(editedSkill);
      // Toggling the list must preserve both the open draft and its new state.
      editSkill()
        .closest(".claudero-pref-skill-actions")!
        .querySelector<HTMLButtonElement>("button")!
        .click();
      assert.isTrue(draft.isConnected);
      skills.querySelector<HTMLButtonElement>("[data-skill-save]")!.click();
      assert.notExists(skills.querySelector(".claudero-pref-skill-editor"));
      const editedRecord = getAcademicSkillRecords().find(
        (entry) => entry.id === editedSkill.id,
      )!;
      assert.equal(editedRecord.skill.title, editedSkill.title);
      assert.isFalse(
        editedRecord.enabled,
        "Saving must not re-enable a disabled workflow",
      );
      editSkill().click();
      skills.querySelector<HTMLTextAreaElement>(
        ".claudero-pref-skill-editor textarea",
      )!.value = "cancelled draft";
      const beforeCancel = getPref("academicSkills");
      skills.querySelector<HTMLButtonElement>("[data-skill-cancel]")!.click();
      assert.notExists(skills.querySelector(".claudero-pref-skill-editor"));
      assert.equal(getPref("academicSkills"), beforeCancel);
    } finally {
      prefs.close();
      if (previousPanel === undefined) clearPref("settingsProvider");
      else setPref("settingsProvider", previousPanel);
      if (previousCheck === undefined) clearPref("setupChecked");
      else setPref("setupChecked", previousCheck);
      if (previousDetection === undefined) clearPref("autoDetectedPaths");
      else setPref("autoDetectedPaths", previousDetection);
      if (previousNode === undefined) clearPref("nodePath");
      else setPref("nodePath", previousNode);
      if (previousMcp === undefined) clearPref("mcpServers");
      else setPref("mcpServers", previousMcp);
      if (previousProvider === undefined) clearPref("provider");
      else setPref("provider", previousProvider);
      if (previousConfigs === undefined) clearPref("providerConfigs");
      else setPref("providerConfigs", previousConfigs);
      if (previousClaudePath === undefined) clearPref("claudePath");
      else setPref("claudePath", previousClaudePath);
      if (previousSkills === undefined) clearPref("academicSkills");
      else setPref("academicSkills", previousSkills);
    }
  });
});
