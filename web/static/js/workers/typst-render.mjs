// Deterministic renderer: ResumeStructured → house Typst source.
// Paired with typst-client.mjs (which compiles the source to PDF).

const HOUSE_PREAMBLE = `// Generated from an imported CV — edit freely.

#set page(paper: "us-letter", margin: (x: 0.5in, y: 0.4in))
#set text(font: "Libertinus Serif", size: 11pt)
#set par(justify: true, leading: 0.65em)
#show link: set text(blue)

// Section heading: small-caps title with a thin rule underneath.
#let sectionTitle(title) = [
  #v(-2pt)
  #text(size: 13pt)[#smallcaps(title)]
  #v(-11pt)
  #line(length: 100%, stroke: 0.6pt)
  #v(-4pt)
]

// Education entry: school + location on one row, degree + dates on the next.
#let eduEntry(school, location, degree, dates) = [
  #grid(
    columns: (1fr, auto),
    [*#school*], align(right)[#location]
  )
  #v(-4pt)
  #grid(
    columns: (1fr, auto),
    emph[#degree], align(right)[#emph[#dates]]
  )
  #v(-4pt)
]

// Experience entry: company + location, then title (optionally " · division") + dates.
// Optional url wraps the company name in a link.
#let expEntry(company, location, jobtitle, division, dates, url: none) = [
  #grid(
    columns: (1fr, auto),
    [*#if url != none { link(url)[#company] } else { company }*],
    align(right)[#location]
  )
  #v(-4pt)
  #grid(
    columns: (1fr, auto),
    emph[#jobtitle #if division != "" [#sym.dot.c #division]],
    align(right)[#emph[#dates]]
  )
]

// Bulleted item with a bold lead-in ("- *Lead*: description"). When lead
// is empty, drops the bold prefix and colon.
#let rItem(lead, desc) = [
  #if lead != "" [
    - *#lead*: #desc
  ] else [
    - #desc
  ]
]
`;

// Escape for content inside Typst string literals ("...").
export const escapeTypst = (raw) => String(raw ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"');

// Escape for content inside `[...]` markup blocks.
const escapeInBrackets = (raw) => String(raw ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/#/g, '\\#')
  .replace(/@/g, '\\@')
  .replace(/</g, '\\<')
  .replace(/>/g, '\\>');

const linkOrPlain = (label, url) => {
  const safeLabel = escapeInBrackets(label);
  if (!url) return safeLabel;
  return `#link("${escapeTypst(url)}")[${safeLabel}]`;
};

const sectionBanner = (label) => `// ===================== ${label.toUpperCase()} =====================`;

const renderContact = (contact) => {
  if (!contact || !contact.name) return '';
  const parts = [];
  if (contact.email) {
    parts.push(`#link("mailto:${escapeTypst(contact.email)}")[${escapeInBrackets(contact.email)}]`);
  }
  for (const link of contact.links || []) {
    if (link.url) parts.push(linkOrPlain(link.label || link.url, link.url));
  }
  if (contact.phone) parts.push(escapeInBrackets(contact.phone));
  if (contact.location) parts.push(escapeInBrackets(contact.location));
  const contactLine = parts.length
    ? parts.join(' #h(4pt) | #h(4pt) ')
    : '';
  return `${sectionBanner('Heading')}
#align(center)[
  #text(size: 16pt, weight: "bold")[${escapeInBrackets(contact.name)}] \\
  #v(1pt)
  ${contactLine}
]
`;
};

const renderEducation = (education) => {
  if (!education || !education.length) return '';
  const rows = education.map((entry) =>
    `#eduEntry(\n  "${escapeTypst(entry.school)}", "${escapeTypst(entry.location || '')}",\n  "${escapeTypst(entry.degree || '')}",\n  "${escapeTypst(entry.dates || '')}")`,
  ).join('\n\n');
  return `${sectionBanner('Education')}
#sectionTitle("Education")

${rows}
`;
};

const renderSkills = (skills) => {
  if (!skills || !skills.length) return '';
  const lines = skills.map((group) => {
    const label = escapeInBrackets(group.label || '');
    const items = (group.items || []).map(escapeInBrackets).join(', ');
    return `*${label}*: ${items}`;
  }).join(' \\\n');
  return `${sectionBanner('Technical Skills')}
#sectionTitle("Technical Skills")

${lines}
`;
};

const renderExperience = (experience) => {
  if (!experience || !experience.length) return '';
  const blocks = experience.map((entry) => {
    const urlArg = entry.url ? `, url: "${escapeTypst(entry.url)}"` : '';
    const header = `#expEntry(\n  "${escapeTypst(entry.company)}", "${escapeTypst(entry.location || '')}",\n  "${escapeTypst(entry.title || '')}", "${escapeTypst(entry.division || '')}",\n  "${escapeTypst(entry.dates || '')}"${urlArg})`;
    const bullets = (entry.bullets || []).map((bullet) =>
      `#rItem("${escapeTypst(bullet.lead_in || '')}",\n  "${escapeTypst(bullet.description || '')}")`,
    ).join('\n');
    return bullets ? `${header}\n${bullets}` : header;
  }).join('\n\n');
  return `${sectionBanner('Work Experience')}
#sectionTitle("Work Experience")

${blocks}
`;
};

const renderNamedEntries = (entries, sectionLabel) => {
  if (!entries || !entries.length) return '';
  const blocks = entries.map((entry) => {
    const nameContent = entry.url
      ? `#link("${escapeTypst(entry.url)}")[${escapeInBrackets(entry.name)}]`
      : escapeInBrackets(entry.name);
    const lead = entry.subtitle
      ? `[${nameContent} --- ${escapeInBrackets(entry.subtitle)}]`
      : `[${nameContent}]`;
    return `#rItem(${lead},\n  "${escapeTypst(entry.description || '')}")`;
  }).join('\n');
  return `${sectionBanner(sectionLabel)}
#sectionTitle("${escapeTypst(sectionLabel)}")

${blocks}
`;
};

// structuredToTypst → full .typ source string. Empty sections are omitted.
export const structuredToTypst = (resume) => {
  const structured = resume || {};
  const body = [
    renderContact(structured.contact),
    renderEducation(structured.education),
    renderSkills(structured.skills),
    renderExperience(structured.experience),
    renderNamedEntries(structured.projects, 'Projects'),
    renderNamedEntries(structured.activities, 'Interests & Activities'),
  ].filter(Boolean).join('\n');
  return `${HOUSE_PREAMBLE}\n${body}`;
};
