import { assert } from "chai";
import {
  academicSkillHash,
  BUILTIN_ACADEMIC_SKILLS,
  compileAcademicSkillPrompt,
  getAcademicSkillRecords,
  importAcademicSkillFromText,
  matchAcademicSkillIntent,
  parseAcademicSkillStore,
  resolveAcademicSkillContextStatus,
  serializeAcademicSkillStore,
  type AcademicSkillStore,
} from "../src/modules/academicSkills";
import type { ClauderoSelectionContext } from "../src/modules/zoteroContext";

function emptyContext(): ClauderoSelectionContext {
  return {
    generatedAt: "2026-07-08T00:00:00.000Z",
    selectedType: "library",
    selectedTabID: "tab-1",
    items: [],
    selectedText: "",
    selectedAnnotations: [],
  };
}

describe("academic skills", function () {
  it("exposes built-in academic workflows as enabled skills", function () {
    const records = getAcademicSkillRecords(parseAcademicSkillStore(""));
    assert.includeMembers(
      records.map((record) => record.id),
      ["summarize-paper", "extract-methods", "literature-matrix"],
    );
    assert.isTrue(records.every((record) => record.enabled));
    assert.isTrue(records.every((record) => record.status === "builtin"));
  });

  it("detects modified built-ins and update availability by hash", function () {
    const builtin = BUILTIN_ACADEMIC_SKILLS[0]!;
    const oldHash = "old-builtin-hash";
    const modified = {
      ...builtin,
      description: `${builtin.description} Custom local preference.`,
    };
    const store: AcademicSkillStore = {
      version: 1,
      skills: {
        [builtin.id]: {
          id: builtin.id,
          enabled: true,
          basedOnBuiltinHash: oldHash,
          skill: modified,
          updatedAt: 1,
        },
      },
    };

    const record = getAcademicSkillRecords(store).find(
      (item) => item.id === builtin.id,
    );

    assert.equal(record?.status, "update-available");
    assert.isTrue(record?.modified);
    assert.isTrue(record?.updateAvailable);
    assert.notEqual(record?.effectiveHash, academicSkillHash(builtin));
  });

  it("imports Agent Skill markdown into a disabled-safe academic skill shape", function () {
    const imported = importAcademicSkillFromText(`---
name: claim-checker
description: Verify whether claims are supported by selected papers.
---

Check each claim against available evidence. Return unsupported claims first.`);

    assert.equal(imported.id, "claim-checker");
    assert.equal(imported.source?.type, "agent-skill");
    assert.isFalse(imported.toolPolicy.allowZoteroWrite);
    assert.include(imported.promptTemplate.task, "unsupported claims");
  });

  it("matches natural-language academic intents without requiring a button", function () {
    const match = matchAcademicSkillIntent(
      "帮我对比这几篇文章的方法和样本，做一个文献矩阵",
      BUILTIN_ACADEMIC_SKILLS,
    );

    assert.equal(match?.skill.id, "literature-matrix");
    assert.isAtLeast(match?.confidence || 0, 0.55);
  });

  it("reports missing context and compiles a workflow prompt", function () {
    const skill = BUILTIN_ACADEMIC_SKILLS.find(
      (item) => item.id === "literature-matrix",
    )!;
    const match = {
      skill,
      confidence: 0.9,
      matchedTerms: ["文献矩阵"],
      reason: "test",
    };
    const status = resolveAcademicSkillContextStatus(skill, emptyContext());
    const prompt = compileAcademicSkillPrompt({
      userPrompt: "做一个文献矩阵",
      match,
      contextStatus: status,
    });

    assert.include(status.missing.join("\n"), "at least two Zotero items");
    assert.include(prompt, '<claudero_academic_skill id="literature-matrix"');
    assert.include(prompt, "Output contract:");
  });

  it("round-trips the academic skill store", function () {
    const store: AcademicSkillStore = {
      version: 1,
      skills: {},
    };
    assert.deepEqual(
      parseAcademicSkillStore(serializeAcademicSkillStore(store)),
      store,
    );
  });
});
