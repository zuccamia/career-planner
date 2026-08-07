// Typst-résumé build + preview + save flow for the résumé import view.
// Deterministic renderer (`structuredToTypst`) takes a
// profile.ResumeStructured payload from the extract-structured-resume-from-md
// RPC and emits the house Typst résumé — single-column US-Letter, Libertinus
// Serif, small-caps section headings with a rule. Users can edit the
// generated source further on the Resumes tab.

import { CLS } from '../ui/classes.mjs';
import { button, helpText, inlineError, setInlineError, subheadTitle } from '../ui/components.mjs';
import { t, currentLocale } from '../i18n.mjs';
import { toast } from '../ui/toast.mjs';
import { extractStructuredResumeFromMd } from '../rpc.mjs';
import { createResume } from '../entities/resumes.mjs';
import { getOverview } from '../entities/profile-overview.mjs';
import { compileTypstToPdf } from '../workers/typst-client.mjs';

// House template preamble: page/text settings + reusable helpers. Kept in
// one triple-backtick string so the generated .typ file starts with a
// self-contained header a reader can skim before the résumé body.
const HOUSE_PREAMBLE = `// Generated from an imported CV — edit freely.

#set page(paper: "us-letter", margin: (x: 0.5in, y: 0.4in))
#set text(font: "Libertinus Serif", size: 11pt)
#set par(justify: true, leading: 0.59em)

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
#let expEntry(company, location, jobtitle, division, dates) = [
  #grid(
    columns: (1fr, auto),
    [*#company*], align(right)[#location]
  )
  #v(-4pt)
  #grid(
    columns: (1fr, auto),
    emph[#jobtitle #if division != "" [#sym.dot.c #division]], align(right)[#emph[#dates]]
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

// escapeTypst escapes for content that goes inside Typst string literals
// (`"..."`). Only backslash and double-quote are syntactic there — the
// broader `#/@/</>` set is only special inside `[...]` markup blocks, not
// inside strings, so escaping them here would corrupt URLs and emails.
const escapeTypst = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"');

// escapeInBrackets escapes for content that goes inside `[...]` markup
// blocks — `#`, `@`, `<`, `>` are all special there.
const escapeInBrackets = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/#/g, '\\#')
  .replace(/@/g, '\\@')
  .replace(/</g, '\\<')
  .replace(/>/g, '\\>');

// Emit a #link("url")[label] form. Falls back to plain label when url is
// missing so the caller can hand every "linkable" name through here.
const linkOrPlain = (label, url) => {
  const safeLabel = escapeInBrackets(label);
  if (!url) return safeLabel;
  return `#link("${escapeTypst(url)}")[${safeLabel}]`;
};

// sectionBanner is the block-comment banner that marks each major section
// in the generated .typ file. Uppercases the label and pads it with `=`
// runners on both sides so section boundaries are easy to eyeball when
// editing the Typst source later.
const sectionBanner = (label) => `// ===================== ${label.toUpperCase()} =====================`;

const renderContact = (contact) => {
  if (!contact || !contact.name) return '';
  const parts = [];
  if (contact.email) {
    parts.push(`#link("mailto:${escapeTypst(contact.email)}")[${escapeInBrackets(contact.email)}]`);
  }
  for (const l of contact.links || []) {
    if (l.url) parts.push(linkOrPlain(l.label || l.url, l.url));
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
  const rows = education.map((e) =>
    `#eduEntry(\n  "${escapeTypst(e.school)}", "${escapeTypst(e.location || '')}",\n  "${escapeTypst(e.degree || '')}",\n  "${escapeTypst(e.dates || '')}")`,
  ).join('\n\n');
  return `${sectionBanner('Education')}
#sectionTitle("Education")

${rows}
`;
};

const renderSkills = (skills) => {
  if (!skills || !skills.length) return '';
  const lines = skills.map((g) => {
    const label = escapeInBrackets(g.label || '');
    const items = (g.items || []).map(escapeInBrackets).join(', ');
    return `*${label}*: ${items}`;
  }).join(' \\\n');
  return `${sectionBanner('Technical Skills')}
#sectionTitle("Technical Skills")

${lines}
`;
};

const renderExperience = (experience) => {
  if (!experience || !experience.length) return '';
  const blocks = experience.map((e) => {
    const header = `#expEntry(\n  "${escapeTypst(e.company)}", "${escapeTypst(e.location || '')}",\n  "${escapeTypst(e.title || '')}", "${escapeTypst(e.division || '')}",\n  "${escapeTypst(e.dates || '')}")`;
    const bullets = (e.bullets || []).map((b) =>
      `#rItem("${escapeTypst(b.lead_in || '')}",\n  "${escapeTypst(b.description || '')}")`,
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
  const blocks = entries.map((e) => {
    const nameContent = e.url
      ? `#link("${escapeTypst(e.url)}")[${escapeInBrackets(e.name)}]`
      : escapeInBrackets(e.name);
    const lead = e.subtitle
      ? `[${nameContent} --- ${escapeInBrackets(e.subtitle)}]`
      : `[${nameContent}]`;
    return `#rItem(${lead},\n  "${escapeTypst(e.description || '')}")`;
  }).join('\n');
  return `${sectionBanner(sectionLabel)}
#sectionTitle("${escapeTypst(sectionLabel)}")

${blocks}
`;
};

// structuredToTypst turns the ResumeStructured payload into a full .typ
// source string. Sections with no data are omitted rather than emitted as
// empty headings.
export const structuredToTypst = (resume) => {
  const r = resume || {};
  const body = [
    renderContact(r.contact),
    renderEducation(r.education),
    renderSkills(r.skills),
    renderExperience(r.experience),
    renderNamedEntries(r.projects, 'Projects'),
    renderNamedEntries(r.activities, 'Interests & Activities'),
  ].filter(Boolean).join('\n');
  return `${HOUSE_PREAMBLE}\n${body}`;
};

// ---------- build + preview + save flow ----------

// Working payload during the review step. Mutable so pdfUrl can be revoked
// on rebuild without threading the reference through every callsite.
let typstState = null;

const setTypstStatus = (visible) => {
  const el = document.getElementById('ri-typst-status');
  if (el) el.classList.toggle('hidden', !visible);
};
const setTypstError = (msg) => setInlineError('ri-typst-error', msg);

const compileAndRenderPreview = async () => {
  const srcEl = document.getElementById('ri-typst-source');
  const frame = document.getElementById('ri-typst-preview');
  const rebuildBtn = document.getElementById('ri-typst-rebuild');
  if (!srcEl || !frame) return;
  setInlineError('ri-typst-compile-error', '');
  if (rebuildBtn) rebuildBtn.disabled = true;
  try {
    const { pdf } = await compileTypstToPdf(srcEl.value);
    if (typstState?.pdfUrl) URL.revokeObjectURL(typstState.pdfUrl);
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    typstState.pdfUrl = url;
    frame.src = url;
  } catch (err) {
    setInlineError('ri-typst-compile-error', t('profile_import.typst.error.compile', { error: err?.message || String(err) }));
  } finally {
    if (rebuildBtn) rebuildBtn.disabled = false;
  }
};

const saveTypstResume = async (onExit) => {
  const srcEl = document.getElementById('ri-typst-source');
  if (!srcEl || !typstState) return;
  const btn = document.getElementById('ri-typst-save');
  setInlineError('ri-typst-save-error', '');
  if (btn) btn.disabled = true;
  try {
    await createResume({
      title: typstState.title,
      format: 'typ',
      body: srcEl.value,
    });
    toast(t('profile_import.typst.saved', { title: typstState.title }), 'ok');
    if (typstState.pdfUrl) URL.revokeObjectURL(typstState.pdfUrl);
    onExit?.('resumes');
  } catch (err) {
    setInlineError('ri-typst-save-error', t('profile_import.typst.error.generic', { error: err?.message || String(err) }));
  } finally {
    if (btn) btn.disabled = false;
  }
};

const renderTypstReview = (source, title, onExit) => {
  const el = document.getElementById('ri-typst-review');
  if (!el) return;
  typstState = { source, title, pdfUrl: null };
  el.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        ${subheadTitle(t('profile_import.typst.review.title'))}
        ${helpText(t('profile_import.typst.review.hint'))}
      </div>
      <div class="${CLS.formRow} shrink-0">
        ${button({ id: 'ri-typst-rebuild', variant: 'secondaryCompact', icon: 'document', label: t('profile_import.typst.rebuild') })}
        ${button({ id: 'ri-typst-save', variant: 'primaryCompact', icon: 'check', label: t('profile_import.typst.save') })}
      </div>
    </div>
    ${inlineError({ id: 'ri-typst-compile-error' })}
    ${inlineError({ id: 'ri-typst-save-error' })}
    <div class="${CLS.gridTwoCol} gap-4">
      <textarea id="ri-typst-source" spellcheck="false"
                class="${CLS.textarea} ${CLS.codeText} min-h-[60vh] max-h-[80vh] resize-y"></textarea>
      <iframe id="ri-typst-preview" title="Typst preview"
              class="min-h-[60vh] w-full rounded-2xl border border-line bg-surface"></iframe>
    </div>`;
  document.getElementById('ri-typst-source').value = source;
  el.classList.remove('hidden');
  document.getElementById('ri-typst-rebuild')?.addEventListener('click', () => compileAndRenderPreview());
  document.getElementById('ri-typst-save')?.addEventListener('click', () => saveTypstResume(onExit));
  compileAndRenderPreview();
};

const runTypstBuild = async (onExit) => {
  const md = document.getElementById('ri-markdown')?.value?.trim();
  if (!md) {
    setTypstError(t('profile_import.error.unsupported'));
    return;
  }
  setTypstError('');
  const btn = document.getElementById('ri-typst-build');
  if (btn) btn.disabled = true;
  setTypstStatus(true);
  try {
    const [structured, existingOverview] = await Promise.all([
      extractStructuredResumeFromMd(md, currentLocale()),
      getOverview(),
    ]);
    const source = structuredToTypst(structured || {});
    // Title precedence: name the LLM pulled from the CV → the name already
    // on the profile → localized "Imported CV" fallback.
    const namePart = (structured?.contact?.name?.trim()) || (existingOverview?.name?.trim());
    const title = namePart ? `${namePart} — CV` : t('profile_import.typst.default_title');
    renderTypstReview(source, title, onExit);
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('no_llm_configured') || msg.includes('setup')) {
      setTypstError(t('profile_import.typst.error.no_llm'));
    } else {
      setTypstError(t('profile_import.typst.error.generic', { error: msg }));
    }
  } finally {
    setTypstStatus(false);
    if (btn) btn.disabled = false;
  }
};

export const wireTypstBuild = (onExit) => {
  const btn = document.getElementById('ri-typst-build');
  if (!btn) return;
  btn.addEventListener('click', () => runTypstBuild(onExit));
};
