import { describe, expect, it } from 'vitest';
import { structuredToTypst } from './profile-import-typst.mjs';

describe('structuredToTypst', () => {
  it('emits the house preamble even for an empty payload', () => {
    const out = structuredToTypst({});
    expect(out).toContain('#set page(paper: "us-letter"');
    expect(out).toContain('#let sectionTitle(');
    expect(out).toContain('#let eduEntry(');
    expect(out).toContain('#let expEntry(');
    expect(out).toContain('#let rItem(');
  });

  it('omits sections that have no data', () => {
    const out = structuredToTypst({ contact: {} });
    expect(out).not.toContain('#sectionTitle("Education")');
    expect(out).not.toContain('#sectionTitle("Work Experience")');
    expect(out).not.toContain('#sectionTitle("Projects")');
  });

  it('renders a centered heading block with mailto + labeled links', () => {
    const out = structuredToTypst({
      contact: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        location: 'London, UK',
        links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/ada' }],
      },
    });
    expect(out).toContain('#align(center)');
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('#link("mailto:ada@example.com")');
    expect(out).toContain('#link("https://linkedin.com/in/ada")[LinkedIn]');
    expect(out).toContain('London, UK');
    // Sections are separated by the pipe glyph joiner.
    expect(out).toContain(' #h(4pt) | #h(4pt) ');
  });

  it('prepends a section banner comment for each rendered section', () => {
    const out = structuredToTypst({
      contact: { name: 'X' },
      education: [{ school: 'MIT' }],
      skills: [{ label: 'Languages', items: ['Go'] }],
      experience: [{ company: 'Acme' }],
      projects: [{ name: 'Pantry' }],
      activities: [{ name: 'Volunteering' }],
    });
    expect(out).toContain('// ===================== HEADING =====================');
    expect(out).toContain('// ===================== EDUCATION =====================');
    expect(out).toContain('// ===================== TECHNICAL SKILLS =====================');
    expect(out).toContain('// ===================== WORK EXPERIENCE =====================');
    expect(out).toContain('// ===================== PROJECTS =====================');
    expect(out).toContain('// ===================== INTERESTS & ACTIVITIES =====================');
  });

  it('escapes only backslash and quote inside string args', () => {
    // Inside "..." string literals, `# @ < >` are literal characters and
    // must NOT be escaped — that would corrupt emails and URLs.
    const out = structuredToTypst({
      contact: { name: 'X' },
      education: [{ school: 'A"B\\C', location: '#@<>', degree: '', dates: '' }],
    });
    expect(out).toContain('"A\\"B\\\\C", "#@<>"');
  });

  it('escapes # @ < > inside bracketed markup content', () => {
    // Inside [...] markup blocks, `# @ < >` are all special.
    const out = structuredToTypst({
      contact: { name: 'X' },
      projects: [{ name: 'A#B@C<D>', description: '' }],
    });
    expect(out).toContain('[A\\#B\\@C\\<D\\>]');
  });

  it('renders skills as bold-labeled lines joined by hard line-break', () => {
    const out = structuredToTypst({
      contact: { name: 'X' },
      skills: [
        { label: 'Languages', items: ['Go', 'Rust'] },
        { label: 'Tools', items: ['Datadog'] },
      ],
    });
    expect(out).toContain('*Languages*: Go, Rust \\\n*Tools*: Datadog');
  });

  it('renders experience with a header + rItem per bullet', () => {
    const out = structuredToTypst({
      contact: { name: 'X' },
      experience: [{
        company: 'Acme',
        location: 'SF',
        title: 'Engineer',
        division: 'Payments',
        dates: '2020–2024',
        bullets: [
          { lead_in: 'Search', description: 'Introduced Elasticsearch.' },
          { lead_in: '', description: 'Shipped feature flags.' },
        ],
      }],
    });
    expect(out).toContain('#expEntry(\n  "Acme", "SF",\n  "Engineer", "Payments",\n  "2020–2024")');
    expect(out).toContain('#rItem("Search",\n  "Introduced Elasticsearch.")');
    expect(out).toContain('#rItem("",\n  "Shipped feature flags.")');
  });

  it('links project names when a URL is given, plain-text otherwise', () => {
    const out = structuredToTypst({
      contact: { name: 'X' },
      projects: [
        { name: 'Pantry', url: 'https://github.com/x/pantry', subtitle: 'Lead (2021)', description: 'PWA app.' },
        { name: 'Career Planner', description: 'Go webapp.' },
      ],
    });
    expect(out).toContain('#rItem([#link("https://github.com/x/pantry")[Pantry] --- Lead (2021)],\n  "PWA app.")');
    expect(out).toContain('#rItem([Career Planner],\n  "Go webapp.")');
  });

  it('handles null / undefined inputs safely', () => {
    expect(() => structuredToTypst(null)).not.toThrow();
    expect(() => structuredToTypst(undefined)).not.toThrow();
    const out = structuredToTypst(null);
    expect(out).toContain('#set page');
  });
});
