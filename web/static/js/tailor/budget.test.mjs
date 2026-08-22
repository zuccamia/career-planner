import { describe, expect, it } from 'vitest';
import { exceedsOnePage } from './budget.mjs';

describe('exceedsOnePage', () => {
  const base = {
    experience: [
      { company: 'A', bullets: [{ description: 'b1' }, { description: 'b2' }] },
      { company: 'B', bullets: [{ description: 'b3' }] },
    ],
    skills: [{ label: 'lang', items: ['Go'] }, { label: 'infra', items: ['K8s'] }],
  };

  it('returns false when the tailored output stays within base counts', () => {
    const tailored = {
      experience: [
        { company: 'A', bullets: [{ description: 'x' }, { description: 'y' }] },
        { company: 'B', bullets: [{ description: 'z' }] },
      ],
      skills: [{ label: 'lang', items: ['Go'] }, { label: 'infra', items: ['K8s'] }],
    };
    expect(exceedsOnePage(tailored, base)).toBe(false);
  });

  it('flags overflow on extra roles, extra bullets, or extra skill groups', () => {
    expect(exceedsOnePage({ experience: [...base.experience, { company: 'C', bullets: [] }], skills: base.skills }, base)).toBe(true);
    expect(exceedsOnePage({
      experience: [{ company: 'A', bullets: [{ description: 'x' }, { description: 'y' }, { description: 'extra' }] }, base.experience[1]],
      skills: base.skills,
    }, base)).toBe(true);
    expect(exceedsOnePage({ experience: base.experience, skills: [...base.skills, { label: 'extra', items: [] }] }, base)).toBe(true);
  });

  it('flags overflow on extra projects or activities', () => {
    const baseWithSide = { ...base, projects: [{ name: 'p1' }], activities: [{ name: 'a1' }] };
    expect(exceedsOnePage({ ...baseWithSide, projects: [{ name: 'p1' }, { name: 'p2' }] }, baseWithSide)).toBe(true);
    expect(exceedsOnePage({ ...baseWithSide, activities: [{ name: 'a1' }, { name: 'a2' }] }, baseWithSide)).toBe(true);
  });
});
