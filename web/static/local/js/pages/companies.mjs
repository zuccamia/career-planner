// Companies page: list + inline editor for create/edit/delete + LLM-assisted
// lookup. Applications reference companies via a dropdown, so this is where
// the "look up canonical company details" affordance lives.

import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  findCompanyByName, updateCompanyDossier,
} from '../entities/companies.mjs';
import { countApplicationsByCompany } from '../entities/applications.mjs';
import { countPeopleByCompany } from '../entities/people.mjs';
import { guessCompanyCandidate, buildDossier } from '../rpc.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, emptyState, inlineError, setInlineError, inlineNote, setInlineNote, pageHeader, setPageCount } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { outputLanguageSelect, readOutputLanguage } from '../ui/output_language.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { refreshSidebarCounts } from '../ui/sidebar_counts.mjs';
import { createProgress } from '../ui/progress.mjs';
import { t } from '../i18n.mjs';

const PANEL_IDS = ['editor-panel', 'dossier-panel'];

// LLM writes canonical English season names (Spring/Summer/Fall/Winter) — see
// internal/dossiers/prompts_*.go. Locale-map at render so the DB stays
// consistent across users.
const SEASON_KEY = {
  spring: 'companies.dossier.season.spring',
  summer: 'companies.dossier.season.summer',
  fall: 'companies.dossier.season.fall',
  autumn: 'companies.dossier.season.fall',
  winter: 'companies.dossier.season.winter',
};
const localizeSeason = (raw) => {
  const key = SEASON_KEY[String(raw).toLowerCase().trim()];
  return key ? t(key) : String(raw);
};

// ---------- markup ----------
const shellHtml = () => `
  <div class="space-y-6">
    <div id="toast" class="hidden"></div>

    <section class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      ${pageHeader({ title: t('page.companies.title'), countId: 'companies-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: t('companies.action.new'), ariaLabel: t('companies.aria.add') })}
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
          <p class="${CLS.eyebrow}">${isNew ? t('companies.form.new_eyebrow') : t('companies.form.edit_eyebrow')}</p>
          <div class="flex items-center gap-2">
            ${button({ type: 'submit', variant: 'iconPrimary', icon: 'check', iconOnly: true, ariaLabel: isNew ? t('companies.form.aria.create') : t('common.action.save_changes') })}
            ${button({ id: 'btn-cancel', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.cancel') })}
          </div>
        </div>

        ${inlineError({ id: 'editor-error' })}
        <div id="lookup-progress" class="hidden"></div>

        <div class="grid gap-2">
          <label class="${CLS.label}" for="official_name">${t('companies.field.official_name.label')}</label>
          <div class="flex gap-2">
            <input id="official_name" name="official_name" type="text" required
                   value="${escapeHtml(c.official_name)}" placeholder="${t('companies.field.official_name.placeholder')}"
                   class="${CLS.input}">
            ${outputLanguageSelect('out-lang-company-candidate')}
            ${button({ id: 'btn-lookup', variant: 'secondaryCompact', icon: 'search', label: t('companies.action.lookup'), extraClass: 'whitespace-nowrap' })}
          </div>
          <p class="text-xs text-slate-500">${t('companies.field.official_name.help')}</p>
        </div>

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start">
          <div class="grid gap-2">
            <label class="${CLS.label}" for="website">${t('companies.field.website.label')}</label>
            <input id="website" name="website" type="url" value="${escapeHtml(c.website)}"
                   placeholder="${t('common.placeholder.url')}" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="blog_url">${t('companies.field.blog.label')}</label>
            <input id="blog_url" name="blog_url" type="url" value="${escapeHtml(c.blog_url)}"
                   placeholder="${t('common.placeholder.url')}" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="ats_url">${t('companies.field.ats_url.label')}</label>
            <input id="ats_url" name="ats_url" type="url" value="${escapeHtml(c.ats_url)}"
                   placeholder="${t('common.placeholder.url')}" class="${CLS.input}">
          </div>
          <div class="grid gap-2">
            <label class="${CLS.label}" for="ats_provider">${t('companies.field.ats_provider.label')}</label>
            <input id="ats_provider" name="ats_provider" type="text" value="${escapeHtml(c.ats_provider)}"
                   placeholder="${t('companies.field.ats_provider.placeholder')}" class="${CLS.input}">
          </div>
        </div>

      </form>
    </div>
  `;
};

// Small icons used on the card header line — website (via linked name) and
// blog (rss feed glyph).
const blogIconLink = (url) => url
  ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${t('companies.aria.blog')}" aria-label="${t('companies.aria.blog')}"
        class="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-blue-700 transition">
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5a15 15 0 0 1 15 15M4.5 10.5a9 9 0 0 1 9 9M6 18.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
      </svg>
    </a>`
  : '';

const internshipsPill = () =>
  badge({ color: 'emerald', size: 'xs', icon: 'shieldCheck', label: t('companies.list.internships_badge') });

// Small emerald icon on the card header when a dossier has been built.
// `dossier_updated_at` is the empty string on rows that have never been
// researched.
const dossierIcon = (updatedAt) => {
  if (!updatedAt) return '';
  const label = escapeHtml(t('companies.list.dossier_badge'));
  return `<span aria-label="${label}"
             class="inline-flex h-5 w-5 items-center justify-center rounded-full text-emerald-600">
      ${icon('sparkles', 4)}
    </span>`;
};

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

const listHtml = (companies, peopleCounts, appCounts) => {
  if (!companies.length) {
    return emptyState({ message: t('companies.list.empty') });
  }
  return `
    <ul class="space-y-3">
      ${companies.map(c => {
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
                    ${blogIconLink(c.blog_url)}
                    ${dossierIcon(c.dossier_updated_at)}
                    ${countPill('emerald', 'people',        peopleCounts.get(c.id) || 0, `/local/people?company_id=${c.id}`,       t('companies.list.people_title', { name: escapeHtml(c.official_name) }))}
                    ${countPill('amber',   'applications',  appCounts.get(c.id)    || 0, `/local/applications?company_id=${c.id}`, t('companies.list.applications_title', { name: escapeHtml(c.official_name) }))}
                  </div>
                  ${c.has_internships ? `<div>${internshipsPill()}</div>` : ''}
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-sm text-slate-500">${t('common.updated_at', { date: formatDate(c.updated_at) })}</span>
                  ${button({ variant: 'secondaryCompact', label: t('companies.action.research'), extraClass: 'js-research', dataset: { id: c.id } })}
                  ${button({ variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('companies.aria.edit'), extraClass: 'js-edit', dataset: { id: c.id } })}
                  ${button({ variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('companies.aria.delete', { name: c.official_name }), extraClass: 'js-delete', dataset: { id: c.id, name: c.official_name } })}
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
  const [companies, peopleCounts, appCounts] = await Promise.all([
    listCompanies(),
    countPeopleByCompany(),
    countApplicationsByCompany(),
  ]);
  // Move panels back to their anchors before wiping list-content so their
  // DOM (and any in-progress form input) survives the re-render.
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML = listHtml(companies, peopleCounts, appCounts);
  // Reattach any open panel to its (possibly re-rendered) row.
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  if (openDossierCompany) mountInlinePanel('dossier-panel', openDossierCompany.id);
  setPageCount('companies-count', companies.length, n =>
    t(n === 1 ? 'companies.list.count_one' : 'companies.list.count_many', { n }));
  refreshSidebarCounts().catch(() => {});
  document.querySelectorAll('.js-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor({ id: Number(btn.dataset.id) })));
  document.querySelectorAll('.js-research').forEach(btn =>
    btn.addEventListener('click', () => openDossier(Number(btn.dataset.id))));
  document.querySelectorAll('.js-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteCompanyFromList(Number(btn.dataset.id), btn.dataset.name)));
};

const deleteCompanyFromList = async (companyID, companyName) => {
  if (!confirm(t('companies.confirm.delete', { name: companyName }))) return;
  setInlineError('list-error', '');
  try {
    await deleteCompany(companyID);
    // Close any open panels for this company.
    if (editorMode && editorMode !== 'new' && editorMode.id === companyID) closeEditor();
    if (openDossierCompany && openDossierCompany.id === companyID) closeDossier();
    toast(t('companies.toast.deleted'), 'ok');
    await refreshList();
  } catch (err) {
    setInlineError('list-error', t('companies.error.delete_linked', { err: err.message }));
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

// The dossier is now part of the company row (see migration 003).
// dossier_updated_at is the empty string until the LLM has built one.
const dossierHtml = (company) => {
  const isEmpty = !company.dossier_updated_at;
  const stacks = company.major_tech_stacks || {};
  const hasAnyStack = ['languages', 'frontend', 'backend', 'infrastructure', 'data', 'tooling']
    .some(k => (stacks[k] || []).length);
  return `
    <div class="${CLS.card}">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="space-y-1">
          <p class="${CLS.eyebrow}">${t('companies.dossier.eyebrow', { name: escapeHtml(company.official_name) })}</p>
          <p class="text-xs text-slate-500">
            ${isEmpty ? t('companies.dossier.empty') :
              t('companies.dossier.last_built', { date: formatDate(company.dossier_updated_at) })}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${outputLanguageSelect('out-lang-dossier')}
          ${button({ id: 'btn-dossier-build', icon: 'sparkles', label: isEmpty ? t('companies.action.build_dossier') : t('companies.action.rebuild_dossier') })}
          ${button({ id: 'btn-dossier-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
        </div>
      </div>

      ${inlineError({ id: 'dossier-error' })}
      ${inlineNote({ id: 'dossier-note' })}
      <div id="dossier-progress" class="hidden"></div>

      ${isEmpty ? '' : `
        <div class="grid gap-6">
          ${(company.careers_url || company.ats_provider) ? `
            <div class="grid gap-4 sm:grid-cols-2 items-start">
              <div class="grid gap-1">
                <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.careers')}</p>
                ${company.careers_url
                  ? `<a href="${escapeHtml(company.careers_url)}" target="_blank" rel="noopener noreferrer"
                        class="text-sm text-blue-700 underline hover:text-blue-800 break-all">${escapeHtml(company.careers_url)}</a>`
                  : '<span class="text-sm text-slate-400 italic">—</span>'}
              </div>
              <div class="grid gap-1">
                <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.ats_provider')}</p>
                ${company.ats_provider
                  ? badge({ label: company.ats_provider, color: 'blue', size: 'xs', classes: 'w-fit' })
                  : '<span class="text-sm text-slate-400 italic">—</span>'}
              </div>
            </div>` : ''}

          ${company.company_summary ? `
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.summary')}</p>
              <p class="text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(company.company_summary)}</p>
            </div>` : ''}

          ${company.what_the_company_does ? `
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.what')}</p>
              <p class="text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(company.what_the_company_does)}</p>
            </div>` : ''}

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.customers')}</p>
              ${chipRow(company.target_customers)}
            </div>
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.product_areas')}</p>
              ${chipRow(company.product_areas)}
            </div>
          </div>

          <div class="grid gap-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.business_model')}</p>
            ${bulletList(company.business_model_clues)}
          </div>

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.launches')}</p>
              ${bulletList(company.recent_product_launches)}
            </div>
            <div class="grid gap-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.culture')}</p>
              ${bulletList(company.company_culture_notes)}
            </div>
          </div>

          <div class="grid gap-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.internships')}</p>
            ${company.has_internships
              ? `<p class="text-sm text-slate-700">
                   <span class="font-medium">${t('companies.dossier.internships_yes')}</span>
                   ${company.internship_seasons?.length ? ` ${t('companies.dossier.internships_seasons', { seasons: company.internship_seasons.map(s => escapeHtml(localizeSeason(s))).join(', ') })}` : ''}
                 </p>
                 ${company.internship_summary ? `<p class="text-sm text-slate-600 whitespace-pre-wrap">${escapeHtml(company.internship_summary)}</p>` : ''}`
              : `<p class="text-sm text-slate-500">${t('companies.dossier.internships_no')}</p>`}
          </div>

          ${hasAnyStack ? `
            <div class="grid gap-4">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500">${t('companies.dossier.tech_stacks')}</p>
              <div class="grid gap-4 sm:grid-cols-2">
                ${stackGroup(t('companies.dossier.stack.languages'), stacks.languages)}
                ${stackGroup(t('companies.dossier.stack.frontend'), stacks.frontend)}
                ${stackGroup(t('companies.dossier.stack.backend'), stacks.backend)}
                ${stackGroup(t('companies.dossier.stack.infrastructure'), stacks.infrastructure)}
                ${stackGroup(t('companies.dossier.stack.data'), stacks.data)}
                ${stackGroup(t('companies.dossier.stack.tooling'), stacks.tooling)}
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
  // Re-fetch so a just-built dossier's fields land on the panel.
  const fresh = await getCompany(openDossierCompany.id);
  if (fresh) openDossierCompany = fresh;
  panel.innerHTML = dossierHtml(openDossierCompany);
  wireDossier();
};

const openDossier = async (companyID) => {
  // Editor panel and dossier panel are mutually exclusive to keep focus clear.
  closeEditor();
  const company = await getCompany(companyID);
  if (!company) {
    toast(t('companies.error.not_found', { id: companyID }), 'error');
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
    setInlineNote('dossier-note', '');
    const progress = createProgress(document.getElementById('dossier-progress'));
    progress.reset();
    try {
      const c = openDossierCompany;
      const generated = await buildDossier({
        official_name: c.official_name,
        website: c.website,
        blog_url: c.blog_url,
        ats_url: c.ats_url,
        ats_provider: c.ats_provider,
      }, readOutputLanguage('out-lang-dossier'), progress.asCallback());
      await updateCompanyDossier(c.id, generated);
      const reason = (generated?.reasoning || '').trim();
      await renderDossier();
      // renderDossier re-renders the panel; re-apply the note after paint.
      // The progress panel is inside the re-rendered subtree and vanishes with it.
      setInlineNote('dossier-note', reason ? t('companies.toast.dossier_built', { reason }) : t('companies.toast.dossier_built_short'));
    } catch (err) {
      setInlineError('dossier-error', t('companies.error.build_failed', { err: err.message }));
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
      toast(t('companies.error.not_found', { id: mode.id }), 'error');
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
    blog_url: (fd.get('blog_url') || '').toString().trim(),
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
  set('blog_url', cand.blog_url);
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
      setInlineError('editor-error', t('companies.error.type_name_first'));
      officialInput.focus();
      return;
    }
    lookupBtn.disabled = true;
    const originalHTML = lookupBtn.innerHTML;
    lookupBtn.innerHTML = `<span>${t('companies.action.lookup_running')}</span>`;
    const progress = createProgress(document.getElementById('lookup-progress'));
    progress.reset();
    try {
      const res = await guessCompanyCandidate(name, readOutputLanguage('out-lang-company-candidate'), progress.asCallback());
      if (res.warning) setInlineError('editor-error', t('companies.error.llm_warning', { warning: res.warning }));
      applyCandidate(res.candidate);
      const reason = (res.candidate?.reasoning || '').trim();
      toast(reason ? t('companies.toast.lookup_filled', { reason }) : t('companies.toast.lookup_filled_short'), 'ok');
      progress.reset();
    } catch (err) {
      setInlineError('editor-error', t('companies.error.lookup_failed', { err: err.message }));
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
      setInlineError('editor-error', t('companies.error.official_name_required'));
      return;
    }
    try {
      if (editorMode === 'new') {
        // Guard against creating a duplicate by name — case-insensitive.
        const existing = await findCompanyByName(data.official_name);
        if (existing) {
          setInlineError('editor-error', t('companies.error.already_exists', { name: data.official_name, id: existing.id }));
          return;
        }
        const id = await createCompany(data);
        toast(t('companies.toast.created', { id }), 'ok');
      } else {
        await updateCompany(editorMode.id, data);
        toast(t('companies.toast.saved'), 'ok');
      }
      closeEditor();
      await refreshList();
    } catch (err) {
      setInlineError('editor-error', t('common.error.save_failed', { err: err.message }));
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
