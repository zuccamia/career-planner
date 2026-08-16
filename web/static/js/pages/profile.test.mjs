import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../i18n.mjs', () => ({
  t: (key) => key,
}));

vi.mock('../db/schema.mjs', () => ({
  SKILL_LEVELS: ['beginner', 'intermediate', 'advanced', 'expert'],
  LOOKING_FOR_VALUES: ['open', 'internship', 'new_grad', 'full_time', 'contract'],
}));

vi.mock('../entities/profile-overview.mjs', async () => {
  const actual = await vi.importActual('../entities/profile-overview.mjs');
  return {
    ...actual,
    getOverview: vi.fn(),
    updateOverview: vi.fn(),
    markOnboarded: vi.fn(),
    clearOnboarded: vi.fn(),
    getWizardProgress: vi.fn(),
  };
});

vi.mock('../entities/career-sparks.mjs', () => ({
  listSparks: vi.fn(),
  createSpark: vi.fn(),
  deleteSpark: vi.fn(),
  countSparks: vi.fn(),
}));

vi.mock('../entities/resumes.mjs', () => ({
  listResumes: vi.fn(),
  countResumes: vi.fn(),
}));

vi.mock('../entities/brag-entries.mjs', () => ({
  listBragEntries: vi.fn(),
  createBragEntry: vi.fn(),
  updateBragEntry: vi.fn(),
  deleteBragEntry: vi.fn(),
  countBragEntries: vi.fn(),
}));

vi.mock('../entities/companies.mjs', () => ({
  listCompanies: vi.fn(),
}));

vi.mock('../rpc.mjs', () => ({
  generateBragTags: vi.fn(),
}));

vi.mock('../ui/toast.mjs', () => ({
  toast: vi.fn(),
}));

vi.mock('../ui/progress.mjs', () => ({
  createProgress: vi.fn(),
}));

vi.mock('./profile_wizard.mjs', () => ({
  renderWizard: vi.fn(),
}));

vi.mock('./profile-import.mjs', () => ({
  renderImport: vi.fn(),
}));

vi.mock('./profile-resume-panel.mjs', () => ({
  openResumePanel: vi.fn(),
}));

import { skillsEditorHtml, wireSkillsEditor } from './profile.mjs';

describe('profile page skills editor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('dedupes duplicate skill adds case-insensitively in the UI', async () => {
    document.body.innerHTML = skillsEditorHtml({ mountId: 'ov-skills-editor', skills: [] });
    const onChange = vi.fn(async () => {});

    wireSkillsEditor('ov-skills-editor', [], onChange);

    const editor = document.getElementById('ov-skills-editor');
    const name = editor.querySelector('.js-skill-name');
    const years = editor.querySelector('.js-skill-years');
    const level = editor.querySelector('.js-skill-level');
    const add = editor.querySelector('.js-add-skill');

    name.value = 'Python';
    years.value = '4';
    level.value = 'advanced';
    add.click();
    await Promise.resolve();

    name.value = ' python ';
    years.value = '9';
    level.value = 'expert';
    add.click();
    await Promise.resolve();

    const pills = editor.querySelectorAll('.js-skill-pills span[data-skill-index]');
    expect(pills).toHaveLength(1);
    expect(editor.querySelector('.js-skill-pills').textContent).toContain('Python');

    expect(onChange).toHaveBeenLastCalledWith([
      { name: 'Python', years: 4, level: 'advanced' },
    ]);
  });

  it('normalizes initial skills before first render interaction', async () => {
    document.body.innerHTML = skillsEditorHtml({
      mountId: 'ov-skills-editor',
      skills: [{ name: 'Go' }],
    });
    const onChange = vi.fn(async () => {});

    wireSkillsEditor('ov-skills-editor', [
      { name: 'Go', years: 6, level: 'advanced' },
      { name: ' go ', years: 10, level: 'expert' },
    ], onChange);

    const editor = document.getElementById('ov-skills-editor');
    const name = editor.querySelector('.js-skill-name');
    const add = editor.querySelector('.js-add-skill');

    name.value = 'Go';
    add.click();
    await Promise.resolve();

    const pills = editor.querySelectorAll('.js-skill-pills span[data-skill-index]');
    expect(pills).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith([
      { name: 'Go', years: 6, level: 'advanced' },
    ]);
  });

});