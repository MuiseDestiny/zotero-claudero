import {
  getAcademicSkillRecords,
  getAcademicSkillStore,
  saveAcademicSkillOverride,
  validateAcademicSkill,
  type AcademicSkill,
  type AcademicSkillRecord,
} from "./academicSkills";

/** Commit a draft without undoing changes made while its editor was open. */
export function saveAcademicSkillEdit(
  original: AcademicSkillRecord,
  raw: string,
): AcademicSkill {
  const parsed: unknown = JSON.parse(raw);
  const error = validateAcademicSkill(parsed);
  if (error) throw new Error(error);
  const skill = parsed as AcademicSkill;
  if (skill.id !== original.id)
    throw new Error("Keep the skill id unchanged when editing.");

  const store = getAcademicSkillStore();
  if (store.validationError) throw new Error(store.validationError);
  const current = getAcademicSkillRecords(store).find(
    (record) => record.id === original.id,
  );
  if (!current)
    throw new Error(
      "This workflow was deleted. Copy your draft before closing the editor.",
    );
  const content = (record: AcademicSkillRecord) =>
    JSON.stringify(record.validationError ? record.rawStored : record.skill);
  if (content(current) !== content(original)) {
    throw new Error(
      "This workflow changed elsewhere. Copy your draft and reopen the editor before saving.",
    );
  }
  // Enabling/disabling is independent of editing the workflow content.
  saveAcademicSkillOverride(skill, current.enabled, store);
  return skill;
}
