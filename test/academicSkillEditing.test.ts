import { assert } from "chai";
import {
  BUILTIN_ACADEMIC_SKILLS,
  deleteCustomAcademicSkill,
  getAcademicSkillRecords,
  saveAcademicSkillOverride,
  setAcademicSkillEnabled,
} from "../src/modules/academicSkills";
import { saveAcademicSkillEdit } from "../src/modules/academicSkillEditing";
import { getPref, setPref, clearPref } from "../src/utils/prefs";

describe("academic workflow editing", function () {
  let previous: ReturnType<typeof getPref<"academicSkills">>;
  const skill = { ...BUILTIN_ACADEMIC_SKILLS[0]!, id: "editing-fixture" };
  const record = () =>
    getAcademicSkillRecords().find((entry) => entry.id === skill.id)!;

  beforeEach(function () {
    previous = getPref("academicSkills");
    setPref("academicSkills", "");
    saveAcademicSkillOverride(skill);
  });

  afterEach(function () {
    if (previous === undefined) clearPref("academicSkills");
    else setPref("academicSkills", previous);
  });

  it("preserves enablement changes made while a draft is open", function () {
    const original = record();
    setAcademicSkillEnabled(skill.id, false);
    saveAcademicSkillEdit(
      original,
      JSON.stringify({ ...skill, title: "Edited title" }),
    );
    assert.equal(record().skill.title, "Edited title");
    assert.isFalse(record().enabled);
  });

  it("rejects deleted workflows and conflicting edits without overwriting storage", function () {
    const original = record();
    saveAcademicSkillOverride({ ...skill, title: "Newer edit" });
    const newer = getPref("academicSkills");
    assert.throws(
      () => saveAcademicSkillEdit(original, JSON.stringify(skill)),
      /changed elsewhere/,
    );
    assert.equal(getPref("academicSkills"), newer);
    deleteCustomAcademicSkill(skill.id);
    const deleted = getPref("academicSkills");
    assert.throws(
      () => saveAcademicSkillEdit(original, JSON.stringify(skill)),
      /deleted/,
    );
    assert.equal(getPref("academicSkills"), deleted);
  });

  it("rejects invalid drafts and changed IDs without modifying saved data", function () {
    const original = record();
    const saved = getPref("academicSkills");
    for (const draft of [
      "{",
      "{}",
      JSON.stringify({ ...skill, id: "new-id" }),
    ]) {
      assert.throws(() => saveAcademicSkillEdit(original, draft));
      assert.equal(getPref("academicSkills"), saved);
    }
  });

  it("repairs an invalid stored workflow while keeping it disabled", function () {
    setPref(
      "academicSkills",
      JSON.stringify({
        version: 1,
        skills: {
          [skill.id]: {
            id: skill.id,
            enabled: true,
            skill: { ...skill, toolPolicy: null },
            updatedAt: 1,
          },
        },
      }),
    );
    const original = record();
    assert.isString(original.validationError);
    saveAcademicSkillEdit(original, JSON.stringify(skill));
    assert.isUndefined(record().validationError);
    assert.isFalse(record().enabled);
  });
});
