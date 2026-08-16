// Dashboard "Discover openings" slide-over. Runs the discovery pipeline
// (LLM signal extraction → per-ATS-host search → ATS extraction → LLM
// rank) and shows up to RECOMMENDATION_LIMIT recommendations. Results are
// ephemeral — Save promotes to a real application, Dismiss remembers the
// URL so future Runs skip it.
//
// This module drives the UI; the pipeline itself is dispatched by
// discover-client.mjs. When the server isn't wired up
// /api/discover/server-status reports unavailable and the dashboard button
// surfaces a DIY hint instead.

import { getOverview } from '../entities/profile-overview.mjs';
import { listCompanies, findCompanyByName, createCompany } from '../entities/companies.mjs';
import { listApplications, createApplication } from '../entities/applications.mjs';
import { listBragEntries } from '../entities/brag-entries.mjs';
import { listSparks } from '../entities/career-sparks.mjs';
import { CLS } from '../ui/classes.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { badge, button, emptyState, helpText, panelTitle, inlineError, setInlineError } from '../ui/components.mjs';
import { urlFor } from '../host.mjs';
import { openSlideOver, closeSlideOver } from '../ui/slide_over.mjs';
import { createProgress } from '../ui/progress.mjs';
import { toast } from '../ui/toast.mjs';
import { icon } from '../ui/icons.mjs';
import { discover } from '../discover-client.mjs';
import { hostOf } from '../fetch-helpers.mjs';
import { idbGet, idbSet } from '../storage/idb.mjs';
import { currentLocale, t } from '../i18n.mjs';
import { relativeAge } from '../ui/format.mjs';

const PANEL_ID = 'discover-panel';

// Recommendations requested per Run. Server enforces its own default when
// the field is missing; sending it keeps intent visible on the wire.
const RECOMMENDATION_LIMIT = 10;

// Cap brag titles sent to the LLM — matches the server-side cap and keeps
// the payload small for users with long brag sheets.
const MAX_BRAG_TITLES = 20;

// User-dismissed recs — URLs the user explicitly chose to hide via the
// per-card "Don't show again" button, sent as exclude_urls so future Runs
// skip them. No TTL: dismissal is a deliberate act, unlike the old
// shown-tracking which expired. Cap is a storage-safety bound only.
const DISMISSED_URLS_KEY = 'discover-dismissed-urls';
const DISMISSED_URLS_MAX = 500;

const loadDismissedURLs = async () => {
  const raw = await idbGet(DISMISSED_URLS_KEY).catch(() => null);
  return Array.isArray(raw) ? raw.filter(u => typeof u === 'string' && u) : [];
};

const addDismissedURL = async (url) => {
  if (!url) return;
  const existing = await loadDismissedURLs();
  if (existing.includes(url)) return;
  const merged = [url, ...existing].slice(0, DISMISSED_URLS_MAX);
  await idbSet(DISMISSED_URLS_KEY, merged);
};

let latestRecs = [];      // preserved across panel close/reopen
let progressCtrl = null;  // createProgress controller for the current panel

// orElse resolves p and returns fallback on rejection. Useful for parallel
// data fetches where a single missing table shouldn't sink the whole load.
const orElse = (p, fallback) => p.catch(() => fallback);

// Postings older than STALE_DAYS get a muted "Posted X ago" style so users
// can visually deprioritize even when the ATS lied about freshness.
const STALE_DAYS = 30;

const isStalePostedAt = (isoDate) => {
  if (!isoDate) return false;
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then) || then <= 0) return false;
  return Date.now() - then > STALE_DAYS * 86_400_000;
};

const recommendationMetaHtml = (rec) => {
  const parts = [];
  const age = relativeAge(rec?.posted_at || '');
  if (age) {
    const cls = isStalePostedAt(rec?.posted_at) ? ` class="${CLS.placeholder}"` : '';
    parts.push(`<span${cls}>${escapeHtml(t('discover.result.posted_age', { age }))}</span>`);
  }
  if (rec?.provider) {
    parts.push(`<span>${escapeHtml(t('discover.result.provider', { provider: rec.provider }))}</span>`);
  }
  return parts.length ? `<div class="${CLS.metaChipRow}">${parts.join('')}</div>` : '';
};

// -------- data collection --------

// buildRequest reads the user's local state into the shape the discover
// endpoint expects. Errors from any lookup (empty DB, unmigrated schema)
// degrade to an empty section rather than crashing.
const buildRequest = async () => {
  const [overview, companies, apps, brags, sparks, dismissed] = await Promise.all([
    orElse(getOverview(), null),
    orElse(listCompanies(), []),
    orElse(listApplications(), []),
    orElse(listBragEntries(), []),
    orElse(listSparks(), []),
    loadDismissedURLs(),
  ]);

  return {
    profile: {
      headline: overview?.headline || '',
      summary: overview?.summary || '',
      skills: (overview?.skills || []).map(s => s?.name).filter(Boolean),
      locations: overview?.locations || [],
      employment_type: overview?.looking_for || 'open',
    },
    // Server-side SeedCompany only reads `name`. Extra fields would be
    // dropped by the JSON decoder — send just what's used.
    companies: (companies || [])
      .map(c => ({ name: c.official_name }))
      .filter(c => c.name),
    applications: (apps || []).map(a => ({ job_url: a.job_posting_url || '' })),
    // URLs the user explicitly dismissed via "Don't show again".
    exclude_urls: dismissed,
    // Sorted DESC by entry_year then updated_at in the entity; slice takes
    // the most recent titles.
    brag_titles: (brags || []).slice(0, MAX_BRAG_TITLES).map(b => b.title).filter(Boolean),
    career_sparks: (sparks || []).map(s => s.body).filter(Boolean),
    locale: currentLocale(),
    limit: RECOMMENDATION_LIMIT,
  };
};

// -------- render --------

const shellHtml = () => `
  <div class="${CLS.slideOverBody}">
    <div class="${CLS.panelHeadRow}">
      <div class="space-y-1">
        ${panelTitle(t('discover.panel.title'))}
        ${helpText(t('discover.panel.tagline'))}
      </div>
      <div class="${CLS.headActions}">
        ${button({ id: 'btn-discover-run', variant: 'primaryCompact', icon: 'search', label: t('discover.action.run') })}
        ${button({ id: 'btn-discover-close', variant: 'icon', icon: 'close', iconOnly: true, ariaLabel: t('discover.panel.close_aria') })}
      </div>
    </div>
    ${inlineError({ id: 'discover-error' })}
    <div id="discover-progress" class="hidden"></div>
    <div id="discover-results" class="space-y-3">
      ${emptyState({ message: t('discover.state.idle') })}
    </div>
  </div>
`;

// Below this score the ranker signaled a stretch/mismatch. We surface the
// posting anyway (the user asked to see everything) but flag it so a low
// score doesn't get mistaken for a strong recommendation. Mirrors the
// discover-rank prompt's "0–20 for a clear mismatch, 40 for a stretch"
// scale — anything below 40 is worse than a stretch.
const LOW_CONFIDENCE_THRESHOLD = 40;

const cardHtml = (rec, idx) => {
  const host = hostOf(rec.url);
  const score = Number.isFinite(rec.match_score) ? rec.match_score : 0;
  const lowConfidence = score < LOW_CONFIDENCE_THRESHOLD;
  const lowConfidenceBadge = lowConfidence
    ? badge({ color: 'brass', size: 'xs', label: t('discover.low_confidence') })
    : '';
  return `
    <article class="${CLS.card}" data-discover-idx="${idx}">
      <div class="${CLS.cardHeadRow}">
        <div class="${CLS.textCol}">
          <h3 class="${CLS.cardTitle}">${escapeHtml(rec.title)}</h3>
          <p class="${CLS.bodyText}">${escapeHtml(rec.company || '—')}${host ? ` · <span class="${CLS.metaText}">${escapeHtml(host)}</span>` : ''}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${lowConfidenceBadge}
          <span class="${CLS.tagPill}">${escapeHtml(t('discover.match_score', { n: score }))}</span>
        </div>
      </div>
      ${rec.rationale ? `<p class="${CLS.bodyText}">${escapeHtml(rec.rationale)}</p>` : ''}
      ${recommendationMetaHtml(rec)}
      <div class="${CLS.actionRowEnd}">
        ${button({ variant: 'linkMuted', icon: 'eyeSlash', iconOnly: true, ariaLabel: t('discover.action.dismiss'), dataset: { 'discover-dismiss': String(idx) } })}
        <a class="${CLS.btnSecondaryCompact}" href="${escapeHtml(rec.url)}" target="_blank" rel="noreferrer noopener">
          ${icon('link')}<span>${escapeHtml(t('discover.action.open'))}</span>
        </a>
        ${button({ variant: 'primaryCompact', icon: 'check', label: t('discover.action.save'), dataset: { 'discover-save': String(idx) } })}
      </div>
    </article>`;
};

// paintResults renders latestRecs into the results slot. Safe to call on
// panel reopen so the user doesn't lose their last set to an accidental Esc.
// diagnostic is the specific "why zero recs" string from the pipeline;
// falsy means "empty with no explanation" → show the actionable setup hint.
// Only reached with empty latestRecs from renderResults (post-run); reopens
// with an empty state don't touch this branch — the shell's idle text stays.
const paintResults = (diagnostic) => {
  const results = document.getElementById('discover-results');
  if (!results) return;
  if (latestRecs.length === 0) {
    results.innerHTML = diagnostic
      ? emptyState({ message: diagnostic })
      : emptyState({ hint: {
          prefix: t('discover.state.empty.prefix'),
          href: urlFor('companies?new=1'),
          linkLabel: t('discover.state.empty.link'),
          suffix: t('discover.state.empty.suffix'),
        } });
    return;
  }
  results.innerHTML = latestRecs.map((r, i) => cardHtml(r, i)).join('');
  results.querySelectorAll('button[data-discover-save]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rec = latestRecs[Number(btn.dataset.discoverSave)];
      if (rec) saveAsApplication(rec, btn);
    });
  });
  results.querySelectorAll('button[data-discover-dismiss]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rec = latestRecs[Number(btn.dataset.discoverDismiss)];
      if (rec) dismissRec(rec);
    });
  });
  const runBtn = document.getElementById('btn-discover-run');
  if (runBtn) runBtn.querySelector('span').textContent = t('discover.action.rerun');
};

const renderResults = (resp) => {
  progressCtrl?.reset();
  latestRecs = resp?.recommendations || [];
  paintResults(resp?.diagnostics?.[0] || '');
};

// dismissRec adds the URL to the persistent dismissed set and removes it
// from the current view. Fire-and-forget on storage failure. When the
// user dismisses the last visible rec we show a dedicated diagnostic
// rather than the setup-hint empty state (which would be misleading —
// setup is fine, they just cleared the list).
const dismissRec = (rec) => {
  addDismissedURL(rec.url).catch(() => {});
  latestRecs = latestRecs.filter(r => r.url !== rec.url);
  paintResults(latestRecs.length === 0 ? t('discover.diagnostic.all_dismissed') : '');
  toast(t('discover.toast.dismissed'), 'ok');
};

// -------- actions --------

const saveAsApplication = async (rec, btn) => {
  btn.disabled = true;
  try {
    const name = (rec.company || '').trim();
    if (!name) {
      setInlineError('discover-error', t('discover.saved.error', { err: t('discover.saved.error.missing_company') }));
      btn.disabled = false;
      return;
    }
    const existing = await findCompanyByName(name);
    const companyID = existing?.id ?? await createCompany({
      official_name: name,
      // Server resolved the board during Discover; pre-fill ats_url +
      // ats_provider so the new company row lands with real dossier hints.
      ats_url: rec.board_url || '',
      ats_provider: rec.provider || '',
    });
    await createApplication({
      company_id: companyID,
      role_title: rec.title,
      job_posting_url: rec.url,
      status: 'lead',
      notes: rec.rationale || '',
    });
    toast(t('discover.saved.toast'), 'ok');
    // Swap the label to "Saved"; the button already renders a check icon,
    // so no separate glyph is needed.
    const label = btn.querySelector('span');
    if (label) label.textContent = t('discover.action.saved');
  } catch (err) {
    btn.disabled = false;
    setInlineError('discover-error', t('discover.saved.error', { err: err.message || String(err) }));
  }
};

const STEP_LABEL_KEYS = {
  expand:      'discover.step.expand',
  search:      'discover.step.search',
  extract:     'discover.step.extract',
  rank:        'discover.step.rank',
  server_run:  'discover.step.server_run',
};

const handleRunClick = async () => {
  setInlineError('discover-error', '');
  const runBtn = document.getElementById('btn-discover-run');
  if (runBtn) runBtn.disabled = true;
  progressCtrl?.reset();
  const onStep = progressCtrl?.asCallback((name) => STEP_LABEL_KEYS[name]) || (() => {});

  try {
    const resp = await discover(await buildRequest(), { onStep });
    renderResults(resp || {});
  } catch (err) {
    setInlineError('discover-error', t('discover.error.run_failed', { err: err.message || String(err) }));
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
};

// -------- entrypoint --------

// ensurePanel returns the discover-panel element, creating it lazily when
// the current page didn't render one. The panel lives outside <main> so it
// isn't wiped when a page mount replaces #app's innerHTML.
const ensurePanel = () => {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = 'hidden';
  document.body.appendChild(panel);
  return panel;
};

export const openDiscoverPanel = (triggerEl = null) => {
  const panel = ensurePanel();
  panel.innerHTML = shellHtml();
  progressCtrl = createProgress(document.getElementById('discover-progress'));
  if (latestRecs.length) paintResults();
  openSlideOver({
    panelId: PANEL_ID,
    trigger: triggerEl,
    onClose: () => { progressCtrl = null; },
  });
  document.getElementById('btn-discover-close')?.addEventListener('click', () => closeSlideOver(PANEL_ID));
  document.getElementById('btn-discover-run')?.addEventListener('click', () => handleRunClick());
};
