// Companies page: list + inline editor for create/edit/delete + LLM-assisted
// lookup. Applications reference companies via a dropdown, so this is where
// the "look up canonical company details" affordance lives.

import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  findCompanyByName, updateCompanyDossier,
} from '../entities/companies.mjs';
import { countApplicationsByCompany, listApplicationsByCompany, topStatusByCompany, headlineStatus } from '../entities/applications.mjs';
import { countPeopleByCompany, listPeopleByCompanyID } from '../entities/people.mjs';
import { guessCompanyCandidate, buildDossier } from '../rpc.mjs';
import { escapeHtml, formatDate } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { toast } from '../ui/toast.mjs';
import { button, badge, bulletList, dossierLabel, emptyDash, emptyState, faintSpan, fileRow, fileStamp, helpText, inlineError, setInlineError, inlineNote, setInlineNote, narrativeText, pageHeader, panelTitle, sectionTitle, setPageCount } from '../ui/components.mjs';
import { outputLanguageSelect, readOutputLanguage } from '../ui/output_language.mjs';
import { rememberPanelAnchor, mountInlinePanel, restoreAllPanels } from '../ui/panels.mjs';
import { openSlideOver, closeSlideOver, isSlideOverOpen } from '../ui/slide_over.mjs';
import { relativeAge, initials } from '../ui/format.mjs';
import { collectionListPanel, collectionRowsHtml } from '../ui/collection_list.mjs';
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

    <section class="${CLS.pageHeadRow}">
      ${pageHeader({ page: 'companies', title: t('page.companies.title'), countId: 'companies-count' })}
      ${button({ id: 'btn-new', variant: 'primaryCompact', icon: 'plus', label: t('companies.action.new'), ariaLabel: t('companies.aria.add') })}
    </section>

    <section id="editor-panel" class="hidden"></section>
    <section id="dossier-panel" class="hidden"></section>

    ${collectionListPanel({
      searchId: 'companies-search',
      searchPlaceholder: t('companies.search.placeholder'),
    })}
  </div>
`;

const editorHtml = (company) => {
  const isNew = !company;
  const c = company || {};
  return `
    <div class="${CLS.card}">
      <form id="editor-form" class="space-y-5">
        <div class="${CLS.formHeadRow}">
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
          ${helpText(t('companies.field.official_name.help'))}
        </div>

        <div class="${CLS.grid2x2}">
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

// Six headline statuses → BADGE_COLORS key. Companies with no applications
// render no pill.
const HEADLINE_BADGE = {
  lead:      'indigo',
  applied:   'blue',
  interview: 'amber',
  offer:     'emerald',
  rejected:  'rose',
  ghosted:   'slate',
  withdrawn: 'slate',
};

const statusPill = (headline) => {
  if (!headline) return '';
  const color = HEADLINE_BADGE[headline] || 'slate';
  return badge({ color, size: 'xs', label: t(`applications.status.headline.${headline}`) });
};

const updatedLabel = (updatedAt) => {
  if (!updatedAt) return t('companies.list.never_updated');
  return t('companies.list.updated', { date: formatDate(updatedAt) });
};

const rowMeta = (c, roleCount, peopleCount) => {
  const roles = t(roleCount === 1 ? 'companies.list.role_one' : 'companies.list.role_many', { n: roleCount });
  const people = t(peopleCount === 1 ? 'companies.list.person_one' : 'companies.list.person_many', { n: peopleCount });
  return `${roles}  ·  ${people}  ·  ${updatedLabel(c.updated_at)}`;
};

const companyFileRow = (c, roleCount, peopleCount, headline) => fileRow({
  id: c.id,
  jsClass: 'js-open',
  ariaLabel: t('companies.aria.open', { name: c.official_name }),
  title: c.official_name,
  pill: statusPill(headline),
  meta: rowMeta(c, roleCount, peopleCount),
});

// ---------- state + handlers ----------
let editorMode = null;
let filterState = { query: '' };
let cachedCompanies = [];
let cachedAppCounts = new Map();
let cachedPeopleCounts = new Map();
let cachedTopStatuses = new Map();

const applyFilters = () => {
  const q = filterState.query.trim().toLowerCase();
  if (!q) return cachedCompanies;
  return cachedCompanies.filter(c => c.official_name.toLowerCase().includes(q));
};

const rowsForCompanies = (companies) => companies.map(c => {
  const roleCount = cachedAppCounts.get(c.id) || 0;
  const peopleCount = cachedPeopleCounts.get(c.id) || 0;
  const headline = headlineStatus(cachedTopStatuses.get(c.id)) || (roleCount === 0 ? 'lead' : null);
  return companyFileRow(c, roleCount, peopleCount, headline);
});

const renderList = () => {
  const filtered = applyFilters();
  restoreAllPanels(PANEL_IDS);
  document.getElementById('list-content').innerHTML = collectionRowsHtml({
    rows: rowsForCompanies(filtered),
    emptyMessage: t('companies.list.empty'),
  });
  if (editorMode && editorMode !== 'new') mountInlinePanel('editor-panel', editorMode.id);
  setPageCount('companies-count', filtered.length, n =>
    t(n === 1 ? 'companies.list.count_one' : 'companies.list.count_many', { n }));
  wireListHandlers();
};

const wireListHandlers = () => {
  document.querySelectorAll('.js-open').forEach(btn =>
    btn.addEventListener('click', () => openDossier(Number(btn.dataset.id), btn)));
};

const refreshList = async () => {
  const [companies, peopleCounts, appCounts, topStatuses] = await Promise.all([
    listCompanies(),
    countPeopleByCompany(),
    countApplicationsByCompany(),
    topStatusByCompany(),
  ]);
  cachedCompanies = companies;
  cachedAppCounts = appCounts;
  cachedPeopleCounts = peopleCounts;
  cachedTopStatuses = topStatuses;
  renderList();
  refreshSidebarCounts().catch(() => {});
};

const deleteCompanyFromList = async (companyID, companyName, errorID = 'list-error') => {
  if (!confirm(t('companies.confirm.delete', { name: companyName }))) return;
  setInlineError(errorID, '');
  try {
    await deleteCompany(companyID);
    // Close any open panels for this company.
    if (editorMode && editorMode !== 'new' && editorMode.id === companyID) closeEditor();
    if (openDossierCompany && openDossierCompany.id === companyID) closeDossier();
    toast(t('companies.toast.deleted'), 'ok');
    await refreshList();
  } catch (err) {
    setInlineError(errorID, t('companies.error.delete_linked', { err: err.message }));
  }
};

// ---------- dossier panel ----------
const chip = (v) => badge({ label: v, color: 'slate', size: 'xs', weight: 'medium', classes: 'whitespace-nowrap' });


const chipRow = (items) => items?.length
  ? `<div class="${CLS.chipRowStable}">${items.map(chip).join('')}</div>`
  : emptyDash();

const stackGroup = (label, items) => items?.length
  ? `<div class="grid gap-2">
       ${dossierLabel(escapeHtml(label))}
       ${chipRow(items)}
     </div>` : '';

const kvRow = (label, value) => value
  ? `<dt class="${CLS.kvLabel}">${escapeHtml(label)}</dt>
     <dd class="text-sm text-ink">${value}</dd>`
  : '';

const linkOrDash = (url) => url
  ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 break-all text-brand hover:underline">${escapeHtml(url)}</a>`
  : faintSpan('—');

const applicationsSectionHtml = (apps, companyID) => {
  if (!apps.length) return '';
  const rows = apps.map(a => {
    const headline = headlineStatus(a.status);
    const statusText = statusPill(headline)
      ? t(`applications.status.headline.${headline}`)
      : (a.status || '');
    const ageKey = a.status === 'lead'
      ? 'companies.dossier.applications.added'
      : 'companies.dossier.applications.applied';
    const meta = `${statusText} · ${t(ageKey, { age: relativeAge(a.created_at) })}`;
    return `
      <div class="${CLS.staticRow}">
        <div class="${CLS.flexTextCol}">
          <p class="${CLS.rowTitle}">${escapeHtml(a.role_title)}</p>
          <p class="${CLS.fileRowMeta}">${escapeHtml(meta)}</p>
        </div>
      </div>`;
  }).join('');
  const viewLink = `<a href="/local/applications?company_id=${companyID}" class="${CLS.linkAction}">${t('common.action.view')}</a>`;
  return `
    <section class="space-y-2">
      <div class="${CLS.sectionHead}">
        ${sectionTitle(t('companies.dossier.applications.heading'))}
        ${viewLink}
      </div>
      <div class="${CLS.divider}">${rows}</div>
    </section>`;
};

const peopleSectionHtml = (people, companyID) => {
  if (!people.length) return '';
  const rows = people.map(p => `
    <div class="${CLS.staticRow}">
      <div class="${CLS.avatarBadge}">${escapeHtml(initials(p.full_name))}</div>
      <div class="min-w-0 flex-1 space-y-0.5">
        <p class="${CLS.rowTitle}">${escapeHtml(p.full_name)}</p>
        ${p.title ? `<p class="${CLS.fileRowMeta}">${escapeHtml(p.title)}</p>` : ''}
      </div>
    </div>`).join('');
  const viewLink = `<a href="/local/people?company_id=${companyID}" class="${CLS.linkAction}">${t('common.action.view')}</a>`;
  return `
    <section class="space-y-2">
      <div class="${CLS.sectionHead}">
        ${sectionTitle(t('companies.dossier.people.heading'))}
        ${viewLink}
      </div>
      <div class="${CLS.divider}">${rows}</div>
    </section>`;
};

const kvCell = (label, value) => `
  <div class="grid gap-1">
    <p class="${CLS.kvLabel}">${escapeHtml(label)}</p>
    <div class="text-sm text-ink">${value}</div>
  </div>`;

const dossierKvHtml = (company) => {
  const atsHtml = company.ats_provider
    ? badge({ label: company.ats_provider, color: 'blue', size: 'xs', classes: 'w-fit' })
    : faintSpan('—');
  return `
    <div class="${CLS.grid2x2}">
      ${kvCell(t('companies.field.website.label'), linkOrDash(company.website))}
      ${kvCell(t('companies.field.blog.label'), linkOrDash(company.blog_url))}
      ${kvCell(t('companies.field.ats_url.label'), linkOrDash(company.ats_url))}
      ${kvCell(t('companies.field.ats_provider.label'), atsHtml)}
    </div>`;
};

const dossierHtml = (company, { editing = false, apps = [], people = [] } = {}) => {
  const isEmpty = !company.dossier_updated_at;
  const stacks = company.major_tech_stacks || {};
  const hasAnyStack = ['languages', 'frontend', 'backend', 'infrastructure', 'data', 'tooling']
    .some(k => (stacks[k] || []).length);
  return `
    <div class="${CLS.slideOverBody}">
      <header class="${CLS.panelHeadRow}">
        <div class="${CLS.textCol}">
          ${fileStamp('company', company.id)}
          ${panelTitle(company.official_name, company.website
            ? `<a href="${escapeHtml(company.website)}" target="_blank" rel="noopener noreferrer" class="hover:text-brand hover:underline">${escapeHtml(company.official_name)}</a>`
            : '')}
        </div>
        <div class="${CLS.headActions}">
          ${button({ id: 'btn-dossier-edit', variant: 'icon', icon: 'edit', iconOnly: true, ariaLabel: t('companies.aria.edit') })}
          ${button({ id: 'btn-dossier-delete', variant: 'dangerIcon', icon: 'trash', iconOnly: true, ariaLabel: t('companies.aria.delete', { name: company.official_name }) })}
          ${button({ id: 'btn-dossier-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('common.action.close') })}
        </div>
      </header>

      ${editing ? editorHtml(company) : dossierKvHtml(company)}

      ${editing ? '' : `${applicationsSectionHtml(apps, company.id)}${peopleSectionHtml(people, company.id)}`}

      <section class="${CLS.subCard}">
        <div class="${CLS.cardHeadRow}">
          <div class="space-y-1">
            <p class="${CLS.eyebrow}">${t('companies.dossier.eyebrow', { name: escapeHtml(company.official_name) })}</p>
            <p class="${CLS.helpText}">
              ${isEmpty ? t('companies.dossier.empty') :
                t('companies.dossier.last_built', { date: formatDate(company.dossier_updated_at) })}
            </p>
          </div>
          <div class="${CLS.chipRowInline}">
            ${outputLanguageSelect('out-lang-dossier')}
            ${button({ id: 'btn-dossier-build', icon: 'sparkles', label: isEmpty ? t('companies.action.build_dossier') : t('companies.action.rebuild_dossier') })}
          </div>
        </div>

        ${inlineError({ id: 'dossier-error' })}
        ${inlineNote({ id: 'dossier-note' })}
        <div id="dossier-progress" class="hidden"></div>

      ${isEmpty ? '' : `
        <div class="grid gap-6">
          ${company.company_summary ? `
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.summary'))}
              ${narrativeText(company.company_summary)}
            </div>` : ''}

          ${company.what_the_company_does ? `
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.what'))}
              ${narrativeText(company.what_the_company_does)}
            </div>` : ''}

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.customers'))}
              ${chipRow(company.target_customers)}
            </div>
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.product_areas'))}
              ${chipRow(company.product_areas)}
            </div>
          </div>

          <div class="grid gap-1">
            ${dossierLabel(t('companies.dossier.business_model'))}
            ${company.business_model_clues?.length ? bulletList(company.business_model_clues) : emptyDash()}
          </div>

          <div class="grid gap-6 sm:grid-cols-2 items-start">
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.launches'))}
              ${company.recent_product_launches?.length ? bulletList(company.recent_product_launches) : emptyDash()}
            </div>
            <div class="grid gap-1">
              ${dossierLabel(t('companies.dossier.culture'))}
              ${company.company_culture_notes?.length ? bulletList(company.company_culture_notes) : emptyDash()}
            </div>
          </div>

          <div class="grid gap-1">
            ${dossierLabel(t('companies.dossier.internships'))}
            ${company.has_internships
              ? `<p class="${CLS.bodyText}">
                   <span class="font-medium">${t('companies.dossier.internships_yes')}</span>
                   ${company.internship_seasons?.length ? ` ${t('companies.dossier.internships_seasons', { seasons: company.internship_seasons.map(s => escapeHtml(localizeSeason(s))).join(', ') })}` : ''}
                 </p>
                 ${company.internship_summary ? `${narrativeText(company.internship_summary)}` : ''}`
              : `${helpText(t('companies.dossier.internships_no'))}`}
          </div>

          ${hasAnyStack ? `
            <div class="grid gap-4">
              ${dossierLabel(t('companies.dossier.tech_stacks'))}
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
      </section>
    </div>
  `;
};

let openDossierCompany = null;
let openDossierTrigger = null;
let companyEditing = false;

const closeDossier = () => {
  if (isSlideOverOpen('dossier-panel')) {
    closeSlideOver('dossier-panel');
    return;
  }
  openDossierCompany = null;
  openDossierTrigger = null;
  const panel = document.getElementById('dossier-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
};

const renderCompanyPanel = async () => {
  if (!openDossierCompany) return;
  const panel = document.getElementById('dossier-panel');
  const [fresh, apps, people] = await Promise.all([
    getCompany(openDossierCompany.id),
    listApplicationsByCompany(openDossierCompany.id),
    listPeopleByCompanyID(openDossierCompany.id),
  ]);
  if (fresh) openDossierCompany = fresh;
  panel.innerHTML = dossierHtml(openDossierCompany, { editing: companyEditing, apps, people });
  wireDossier();
  if (companyEditing) {
    wireEditor({
      onCancel: () => {
        companyEditing = false;
        editorMode = null;
        renderCompanyPanel();
      },
      onSaved: async () => {
        companyEditing = false;
        editorMode = null;
        await refreshList();
        await renderCompanyPanel();
      },
    });
  }
};

const openDossier = async (companyID, triggerEl = null) => {
  closeEditor();
  const company = await getCompany(companyID);
  if (!company) {
    toast(t('companies.error.not_found', { id: companyID }), 'error');
    return;
  }
  openDossierCompany = company;
  openDossierTrigger = triggerEl;
  await renderCompanyPanel();
  openSlideOver({
    panelId: 'dossier-panel',
    trigger: triggerEl,
    onClose: () => {
      openDossierCompany = null;
      openDossierTrigger = null;
      companyEditing = false;
      editorMode = null;
    },
  });
};

const wireDossier = () => {
  document.getElementById('btn-dossier-close').addEventListener('click', closeDossier);
  document.getElementById('btn-dossier-edit')?.addEventListener('click', () => {
    if (!openDossierCompany) return;
    companyEditing = true;
    editorMode = { id: openDossierCompany.id };
    renderCompanyPanel();
  });
  document.getElementById('btn-dossier-delete')?.addEventListener('click', () => {
    if (!openDossierCompany) return;
    const { id, official_name } = openDossierCompany;
    deleteCompanyFromList(id, official_name, 'dossier-error');
  });

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
      await renderCompanyPanel();
      // renderCompanyPanel re-renders the panel; re-apply the note after paint.
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

const wireEditor = ({ onCancel, onSaved } = {}) => {
  const cancelFn = onCancel || closeEditor;
  const savedFn = onSaved || (async () => { closeEditor(); await refreshList(); });
  const form = document.getElementById('editor-form');
  document.getElementById('btn-cancel').addEventListener('click', cancelFn);

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
      await savedFn();
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
  document.getElementById('companies-search').addEventListener('input', (e) => {
    filterState.query = e.target.value;
    renderList();
  });
  await refreshList();

  // Auto-open the new-company editor if arriving via a quick-action link.
  const params = new URLSearchParams(location.search);
  if (params.get('new') === '1') openEditor('new');
};
