// Companies page: list + inline editor for create/edit/delete + LLM-assisted
// lookup. Applications reference companies via a dropdown, so this is where
// the "look up canonical company details" affordance lives.

import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  findCompanyByName, countEngineeringBlogsByCompany,
} from '../entities/companies.mjs';
import { countApplicationsByCompany } from '../entities/applications.mjs';
import { countPeopleByCompany } from '../entities/people.mjs';
import {
  getLatestDossierByCompanyID, upsertDossierByCompanyID,
  deleteDossiersByCompanyID, listLatestDossiersByCompany,
} from '../entities/dossiers.mjs';
import { guessCompanyCandidate, buildDossier } from '../rpc.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, emptyState, inlineError, setInlineError, pageHeader, setPageCount } from '../ui/components.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';

const PANEL_IDS = ['editor-panel', 'dossier-panel'];

// ---------- markup ----------
const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      ${pageHeader({ title: 'Companies', countId: 'companies-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: 'Company', ariaLabel: 'Add company' })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="dossier-panel" class="hidden"></section>

    <section id="list-panel" class="${CLS.card}">
      ${inlineError({ id: 'list-error' })}
      <div id="list-content"></div>
    </section>
  </div>
`;

const editorHtml = (company) => {
  const isNew = !company;
  const c = company || {};
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="flex items-baseline justify-between">
          <p class="${CLS.eyebrow}">${isNew ? 'New company' : 'Edit'}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? 'Create company' : 'Save changes' })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Cancel' })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}

        <div class="grid gap-2">
          <label class="${CLS.label}" for="official_name">Official name</label>
          <div class="flex gap-2">
            <input id="official_name" name="official_name" type="text" required
                   value="${escapeHtml(c.official_name)}" placeholder="e.g. Stripe"
                   class="${CLS.input}">
            ${button({ id: 'btn-lookup', variant: 'secondaryCompact', icon: 'search', label: 'Look up', extraClass: 'whitespace-nowrap' })}
          </div>
          <p class="text-xs text-slate-500">Look up asks the LLM to guess website, tech blog, and ATS details based on the name. Only empty fields are filled — anything you've already typed is preserved.</p>
        </div>

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="website">Website</label>
            <input id="website" name="website" type="url" value="${escapeHtml(c.website)}"
                   placeholder="https://…" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="tech_blog_url">Tech blog URL</label>
            <input id="tech_blog_url" name="tech_blog_url" type="url" value="${escapeHtml(c.tech_blog_url)}"
                   placeholder="https://…" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="ats_url">ATS URL</label>
            <input id="ats_url" name="ats_url" type="url" value="${escapeHtml(c.ats_url)}"
                   placeholder="https://…" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="ats_provider">ATS provider</label>
            <input id="ats_provider" name="ats_provider" type="text" value="${escapeHtml(c.ats_provider)}"
                   placeholder="e.g. Greenhouse, Lever" class="${CLS.input}">
          </div>
        </div>

      </form>
    </div>
  `;
};

// Small icons used on the card header line — website (via linked name) and
// tech-blog (rss feed glyph).
const techBlogIconLink = (url) => url
  ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Tech blog" aria-label="Tech blog"
        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-blue-700 transition">
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5a15 15 0 0 1 15 15M4.5 10.5a9 9 0 0 1 9 9M6 18.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
      </svg>
    </a>`
  : '';

const internshipsPill = () =>
  badge({ color: 'emerald', size: 'xs', icon: 'shieldCheck', label: 'Internships' });

// Small count pills mirror the legacy Go company_index card: engineering-blog
// notes (blue), people (emerald), applications (amber). Rendered even when
// zero so the row layout stays consistent across companies. When href is set
// the pill is wrapped in an anchor so users can jump straight to the filtered
// list; the anchor stops propagation so the surrounding card click (if any)
// doesn't fire.
const countPill = (color, iconName, n, href, title) => {
  const pill = badge({ color, size: 'xs', icon: iconName, label: String(n) });
  if (!href) return pill;
  return `<a href="${href}" title="${escapeHtml(title)}"
             class="inline-flex transition hover:brightness-95 hover:ring-2 hover:ring-offset-1 hover:ring-slate-300 rounded-full">${pill}</a>`;
};

const listHtml = (companies, dossiers, blogCounts, peopleCounts, appCounts) => {
  if (!companies.length) {
    return emptyState({ message: 'No companies yet.' });
  }
  return `
    <ul class="space-y-3">
      ${companies.map(c => {
        const dossier = dossiers.get(c.id);
        const nameHtml = c.website
          ? `<a href="${escapeHtml(c.website)}" target="_blank" rel="noopener noreferrer"
                class="font-semibold text-slate-900 hover:text-blue-700 hover:underline">${escapeHtml(c.official_name)}</a>`
          : `<span class="font-semibold text-slate-900">${escapeHtml(c.official_name)}</span>`;
        return `
          <li data-panel-row="${c.id}">
            <div class="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 transition hover:border-blue-200 hover:bg-blue-50/40">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div class="space-y-2 min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    ${nameHtml}
                    ${techBlogIconLink(c.tech_blog_url)}
                    ${countPill('blue',    'clipboardList', blogCounts.get(c.id)   || 0, '', 'Engineering blog notes')}
                    ${countPill('emerald', 'people',        peopleCounts.get(c.id) || 0, `/local/people?company_id=${c.id}`,       `People at ${c.official_name}`)}
                    ${countPill('amber',   'applications',  appCounts.get(c.id)    || 0, `/local/applications?company_id=${c.id}`, `Applications at ${c.official_name}`)}
                  </div>
                  ${dossier?.has_internships ? `<div>${internshipsPill()}</div>` : ''}
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-sm text-slate-500">Updated ${formatDate(c.updated_at)}</span>
                  ${button({ variant: 'secondaryCompact', label: 'Research', extraClass: 'js-research', dataset: { id: c.id } })}
                  ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: 'Edit company', extraClass: 'js-edit', dataset: { id: c.id } })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: `Delete ${c.official_name}`, extraClass: 'js-delete', dataset: { id: c.id, name: c.official_name } })}
                </div>
              </div>
            </div>
          </li>`;
      }).join('')}
    </ul>`;
};

// ---------- state + handlers ----------
let editorMode = null;

const refreshList = async () => {
  const [companies, dossiers, blogCounts, peopleCounts, appCounts] = await Promise.all([
    listCompanies(),
    listLatestDossiersByCompany(),
    countEngineeringBlogsByCompany(),
    countPeopleByCompany(),
    countApplicationsByCompany(),
  ]);
  // Move panels back to their anchors before wiping list-content so their
  // DOM (and any in-progress form input) survives the re-render.
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML = listHtml(companies, dossiers, blogCounts, peopleCounts, appCounts);
  // Reattach any open panel to its (possibly re-rendered) row.
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  if (openDossierCompany) mountInlinePanel('dossier-panel', openDossierCompany.id);
  setPageCount('companies-count', companies.length, n => `${n} compan${n === 1 ? 'y' : 'ies'} tracked locally.`);
  refreshSidebarCounts().catch(() => {});
  document.querySelectorAll('.js-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor({ id: Number(btn.dataset.id) })));
  document.querySelectorAll('.js-research').forEach(btn =>
    btn.addEventListener('click', () => openDossier(Number(btn.dataset.id))));
  document.querySelectorAll('.js-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteCompanyFromList(Number(btn.dataset.id), btn.dataset.name)));
};

const deleteCompanyFromList = async (companyID, companyName) => {
  if (!confirm(`Delete "${companyName}"? This also removes its dossier. Applications linked to this company will block the delete.`)) return;
  setInlineError('list-error', '');
  try {
    // Manually cascade the one-to-one dossier — the FK doesn't have ON DELETE
    // CASCADE, so SQLite would refuse the company delete if a dossier row
    // still points at it.
    await deleteDossiersByCompanyID(companyID);
    await deleteCompany(companyID);
    // Close any open panels for this company.
    if (editorMode && editorMode !== 'new' && editorMode.id === companyID) closeEditor();
    if (openDossierCompany && openDossierCompany.id === companyID) closeDossier();
    toast('Company deleted', 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', `Delete failed: ${err.message}. Delete linked applications first.`);
  }
};

// ---------- dossier panel ----------
const chip = (v) => badge({ label: v, color: 'slate', size: 'xs', weight: 'medium' });

const bulletList = (items) => items?.length
  ? `<ul class="list-disc pl-5 space-y-1 text-sm text-slate-700">${items.map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul>`
  : '<p class="text-sm text-slate-400 italic">—</p>';

const chipRow = (items) => items?.length
  ? `<div class="flex flex-wrap gap-2">${items.map(chip).join('')}</div>`
  : '<p class="text-sm text-slate-400 italic">—</p>';

const stackGroup = (label, items) => items?.length
  ? `<div class="grid gap-2">
       <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${escapeHtml(label)}</p>
       ${chipRow(items)}
     </div>` : '';

const dossierHtml = (company, dossier) => {
  const isEmpty = !dossier;
  const d = dossier || {};
  const stacks = d.major_tech_stacks || {};
  const hasAnyStack = ['languages', 'frontend', 'backend', 'infrastructure', 'data', 'tooling']
    .some(k => (stacks[k] || []).length);
  return `
    <div class="${CLS.card}">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">Research — ${escapeHtml(company.official_name)}</p>
          <p class="text-xs text-slate-500">
            ${isEmpty ? 'No dossier yet. Build one to have the LLM research this company.' :
              `Last built ${formatDate(d.updated_at || d.created_at)}. Status: ${escapeHtml(d.status || 'completed')}.`}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${button({ id: 'btn-dossier-build', icon: 'sparkles', label: isEmpty ? 'Build dossier' : 'Rebuild' })}
          ${button({ id: 'btn-dossier-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: 'Close' })}
        </div>
      </div>

      ${inlineError({ id: 'dossier-error' })}

      ${isEmpty ? '' : `
        <div class="grid gap-6">
          ${(d.careers_url || company.ats_provider) ? `
            <div class="grid gap-4 sm:grid-cols-2 items-start">
              <div class="grid gap-1">
                <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Careers</p>
                ${d.careers_url
                  ? `<a href="${escapeHtml(d.careers_url)}" target="_blank" rel="noopener noreferrer"
                        class="text-sm text-blue-700 underline hover:text-blue-800 break-all">${escapeHtml(d.careers_url)}</a>`
                  : '<span class="text-sm text-slate-400 italic">—</span>'}
              </div>
              <div class="grid gap-1">
                <p class="text-xs font-medium uppercase tracking-wide text-slate-500">ATS provider</p>
                ${company.ats_provider
                  ? badge({ label: company.ats_provider, color: 'blue', size: 'xs', classes: 'w-fit' })
                  : '<span class="text-sm text-slate-400 italic">—</span>'}
              </div>
            </div>` : ''}

          ${d.company_summary ? `
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Summary</p>
              <p class="text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(d.company_summary)}</p>
            </div>` : ''}

          ${d.what_the_company_does ? `
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">What the company does</p>
              <p class="text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(d.what_the_company_does)}</p>
            </div>` : ''}

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Target customers</p>
              ${chipRow(d.target_customers)}
            </div>
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Product areas</p>
              ${chipRow(d.product_areas)}
            </div>
          </div>

          <div class="grid gap-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Business model clues</p>
            ${bulletList(d.business_model_clues)}
          </div>

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Recent launches</p>
              ${bulletList(d.recent_product_launches)}
            </div>
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Culture notes</p>
              ${bulletList(d.company_culture_notes)}
            </div>
          </div>

          <div class="grid gap-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Internships</p>
            ${d.has_internships
              ? `<p class="text-sm text-slate-700">
                   <span class="font-medium">Yes.</span>
                   ${d.internship_seasons?.length ? ` Seasons: ${d.internship_seasons.map(s => escapeHtml(s)).join(', ')}.` : ''}
                 </p>
                 ${d.internship_summary ? `<p class="text-sm text-slate-600 whitespace-pre-wrap">${escapeHtml(d.internship_summary)}</p>` : ''}`
              : `<p class="text-sm text-slate-500">No evidence of internships.</p>`}
          </div>

          ${hasAnyStack ? `
            <div class="grid gap-4">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Tech stacks</p>
              <div class="grid gap-4 sm:grid-cols-2">
                ${stackGroup('Languages', stacks.languages)}
                ${stackGroup('Frontend', stacks.frontend)}
                ${stackGroup('Backend', stacks.backend)}
                ${stackGroup('Infrastructure', stacks.infrastructure)}
                ${stackGroup('Data', stacks.data)}
                ${stackGroup('Tooling', stacks.tooling)}
              </div>
            </div>` : ''}

        </div>
      `}
    </div>
  `;
};

let openDossierCompany = null;

const closeDossier = () => {
  openDossierCompany = null;
  mountInlinePanel('dossier-panel', null);
  const panel = document.getElementById('dossier-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const renderDossier = async () => {
  if (!openDossierCompany) return;
  const panel = document.getElementById('dossier-panel');
  const dossier = await getLatestDossierByCompanyID(openDossierCompany.id);
  panel.innerHTML = dossierHtml(openDossierCompany, dossier);
  wireDossier();
};

const openDossier = async (companyID) => {
  // Editor panel and dossier panel are mutually exclusive to keep focus clear.
  closeEditor();
  const company = await getCompany(companyID);
  if (!company) {
    toast(`Company #${companyID} not found`, 'error');
    return;
  }
  openDossierCompany = company;
  const panel = document.getElementById('dossier-panel');
  panel.classList.remove('hidden');
  await renderDossier();
  mountInlinePanel('dossier-panel', companyID);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const wireDossier = () => {
  document.getElementById('btn-dossier-close').addEventListener('click', closeDossier);

  const buildBtn = document.getElementById('btn-dossier-build');
  buildBtn.addEventListener('click', async () => {
    if (!openDossierCompany) return;
    buildBtn.disabled = true;
    const originalHTML = buildBtn.innerHTML;
    buildBtn.innerHTML = '<span>Building…</span>';
    setInlineError('dossier-error', '');
    try {
      const c = openDossierCompany;
      const generated = await buildDossier({
        official_name: c.official_name,
        website: c.website,
        ats_url: c.ats_url,
        ats_provider: c.ats_provider,
      });
      await upsertDossierByCompanyID({ ...generated, company_id: c.id });
      const reason = (generated?.reasoning || '').trim();
      toast(reason ? `Dossier built. ${reason}` : 'Dossier built', 'ok');
      await renderDossier();
    } catch (err) {
      setInlineError('dossier-error', `Build failed: ${err.message}`);
      buildBtn.disabled = false;
      buildBtn.innerHTML = originalHTML;
    }
  });

};

const openEditor = async (mode) => {
  closeDossier();
  editorMode = mode;
  const panel = document.getElementById('editor-panel');
  panel.classList.remove('hidden');

  let company = null;
  if (mode !== 'new') {
    company = await getCompany(mode.id);
    if (!company) {
      toast(`Company #${mode.id} not found`, 'error');
      closeEditor();
      return;
    }
  }
  panel.innerHTML = editorHtml(company);
  wireEditor();

  // "New" flow keeps the panel at its default anchor (no card to pin to).
  mountInlinePanel('editor-panel', mode === 'new' ? null : mode.id);
  panel.querySelector('input[name="official_name"]')?.focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const closeEditor = () => {
  editorMode = null;
  mountInlinePanel('editor-panel', null);
  const panel = document.getElementById('editor-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
};

const readForm = (form) => {
  const fd = new FormData(form);
  return {
    official_name: (fd.get('official_name') || '').toString().trim(),
    website: (fd.get('website') || '').toString().trim(),
    tech_blog_url: (fd.get('tech_blog_url') || '').toString().trim(),
    ats_url: (fd.get('ats_url') || '').toString().trim(),
    ats_provider: (fd.get('ats_provider') || '').toString().trim(),
  };
};

const applyCandidate = (cand) => {
  const set = (name, val, { overwrite = false } = {}) => {
    const el = document.querySelector(`[name="${name}"]`);
    if (!el || !val) return;
    // Prefer LLM value when the field is empty; otherwise keep what the user typed.
    // Exception: official_name is overwritten so a quick partial name gets replaced
    // with the canonical official name returned by the LLM.
    if (overwrite || !el.value.trim()) el.value = val;
  };
  set('official_name', cand.official_name, { overwrite: true });
  set('website', cand.website);
  set('tech_blog_url', cand.tech_blog_url);
  set('ats_url', cand.ats_url);
  set('ats_provider', cand.ats_provider);
};

const wireEditor = () => {
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', closeEditor);

  const officialInput = document.getElementById('official_name');
  const lookupBtn = document.getElementById('btn-lookup');
  lookupBtn.addEventListener('click', async () => {
    setInlineError('editor-error', '');
    const name = officialInput.value.trim();
    if (!name) {
      setInlineError('editor-error', 'Type a company name to look up');
      officialInput.focus();
      return;
    }
    lookupBtn.disabled = true;
    const originalHTML = lookupBtn.innerHTML;
    lookupBtn.innerHTML = '<span>Looking up…</span>';
    try {
      const res = await guessCompanyCandidate(name);
      if (res.warning) setInlineError('editor-error', `LLM warning: ${res.warning}`);
      applyCandidate(res.candidate);
      const reason = (res.candidate?.reasoning || '').trim();
      toast(reason ? `Filled empty fields. ${reason}` : 'Filled empty fields with LLM guess.', 'ok');
    } catch (err) {
      setInlineError('editor-error', `Look up failed: ${err.message}`);
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.innerHTML = originalHTML;
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setInlineError('editor-error', '');
    const data = readForm(form);
    if (!data.official_name) {
      setInlineError('editor-error', 'Official name is required');
      return;
    }
    try {
      if (editorMode === 'new') {
        // Guard against creating a duplicate by name — case-insensitive.
        const existing = await findCompanyByName(data.official_name);
        if (existing) {
          setInlineError('editor-error', `Company "${data.official_name}" already exists (#${existing.id})`);
          return;
        }
        const id = await createCompany(data);
        toast(`Created company #${id}`, 'ok');
      } else {
        await updateCompany(editorMode.id, data);
        toast('Company saved', 'ok');
      }
      closeEditor();
      await refreshList();
    } catch (err) {
      setInlineError('editor-error', `Save failed: ${err.message}`);
    }
  });
};

// ---------- entrypoint ----------
export const mountCompanies = async (root) => {
  root.innerHTML = shellHtml();
  PANEL_IDS.forEach(rememberPanelAnchor);
  document.getElementById('btn-new').addEventListener('click', () => openEditor('new'));
  await refreshList();

  // Auto-open the new-company editor if arriving via a quick-action link.
  const params = new URLSearchParams(location.search);
  if (params.get('new') === '1') openEditor('new');
};
