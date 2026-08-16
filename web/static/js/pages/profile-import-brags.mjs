// Brag-extraction flow for the résumé import view. The main orchestrator
// (profile-import.mjs) owns the shell HTML — the button, spinner, and
// #ri-brags-review section container. This module owns the extraction call,
// the review-panel render, edits read-back, and the apply-to-DB step.

import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { button, emptyState, helpText, hintLink, inlineError, inlineWarning, setInlineError, subheadTitle } from '../ui/components.mjs';
import { t, currentLocale } from '../i18n.mjs';
import { toast } from '../ui/toast.mjs';
import { extractBragsFromResume } from '../rpc.mjs';
import { urlFor } from '../host.mjs';
import { listBragEntries, createBragEntry } from '../entities/brag-entries.mjs';
import { listCompanies } from '../entities/companies.mjs';
import {
  getCachedExtraction, setCachedExtraction,
  filterDuplicatesAgainst, findClosestExisting,
  chunkMarkdownBySections, chunkSnippet, mapWithConcurrency, retryOnRateLimit, isRateLimitError,
} from './profile-import-helpers.mjs';

// At most 2 chunks in flight. Higher throughput would risk tripping BYOK
// provider rate limits (Ollama Cloud, MiniMax, free-tier keys). The local
// server-side path bypasses its own rate limiter for loopback callers.
const CHUNK_CONCURRENCY = 2;

const setBragsStatus = (visible, label = '') => {
  const el = document.getElementById('ri-brags-status');
  if (el) el.classList.toggle('hidden', !visible);
  const labelEl = document.getElementById('ri-brags-status-label');
  if (labelEl) labelEl.textContent = label || t('profile_import.brags.status.generating');
};
const setBragsError = (msg) => setInlineError('ri-brags-error', msg);

// Preselect a company row from an LLM-suggested `company` name by exact
// (case-insensitive) match. Returns '' if no match — leaves the select on
// "— none —".
const findCompanyIdByHint = (hint, companies) => {
  const norm = (hint || '').trim().toLowerCase();
  if (!norm) return '';
  const match = (companies || []).find((c) => (c.official_name || '').trim().toLowerCase() === norm);
  return match ? String(match.id) : '';
};

// Card for one candidate brag: checkbox + editable title/body/impact plus
// editable company (dropdown) and year, with read-only confidence + similarity
// hint. `idx` identifies the card in the DOM so applySelected can read edits.
const candidateCardHtml = (candidate, idx, similar, companies) => {
  const tags = (candidate.tags || []).map((tg) =>
    `<span class="${CLS.tagPill}">${escapeHtml(tg)}</span>`,
  ).join('');
  const meta = [];
  if (typeof candidate.confidence === 'number') meta.push(`<span class="${CLS.metaText}">${escapeHtml(t('profile_import.brags.field.confidence'))}: ${candidate.confidence.toFixed(2)}</span>`);
  const hint = similar?.match
    ? inlineWarning({ message: t('profile_import.brags.similar_to', { title: similar.match.title || '' }) })
    : '';
  const selectedCompanyId = findCompanyIdByHint(candidate.company, companies);
  const companyOptions = [
    `<option value="">${escapeHtml(t('profile_import.brags.company.none'))}</option>`,
    ...(companies || []).map((c) =>
      `<option value="${c.id}"${String(c.id) === selectedCompanyId ? ' selected' : ''}>${escapeHtml(c.official_name)}</option>`,
    ),
  ].join('');
  const yearValue = candidate.entry_year ? String(candidate.entry_year) : '';
  return `
    <article class="${CLS.card}" data-brag-idx="${idx}">
      <label class="${CLS.responsiveRow}">
        <input type="checkbox" data-brag-select${similar?.match ? '' : ' checked'} class="${CLS.checkbox}">
        <input type="text" data-brag-field="title" value="${escapeHtml(candidate.title)}"
               class="${CLS.input} font-semibold" aria-label="${escapeHtml(t('profile_import.brags.field.title'))}">
      </label>
      <textarea data-brag-field="body" spellcheck="false"
                class="${CLS.textarea} min-h-[4rem]" aria-label="${escapeHtml(t('profile_import.brags.field.body'))}">${escapeHtml(candidate.body)}</textarea>
      <input type="text" data-brag-field="impact" value="${escapeHtml(candidate.impact || '')}"
             placeholder="${escapeHtml(t('profile.brags.field.impact.label'))}"
             class="${CLS.input}" aria-label="${escapeHtml(t('profile.brags.field.impact.label'))}">
      <div class="${CLS.gridTwoCol} gap-4">
        <label class="space-y-1">
          <span class="${CLS.label}">${escapeHtml(t('profile.brags.field.company.label'))}</span>
          <select data-brag-field="company_id" class="${CLS.select}">${companyOptions}</select>
          ${hintLink({
            prefix: t('applications.field.company.help_prefix'),
            href: urlFor('companies?new=1'),
            linkLabel: t('applications.field.company.help_link'),
          })}
        </label>
        <label class="space-y-1">
          <span class="${CLS.label}">${escapeHtml(t('profile.brags.field.year.label'))}</span>
          <input type="number" data-brag-field="entry_year" value="${escapeHtml(yearValue)}"
                 min="1970" step="1" class="${CLS.input}">
        </label>
      </div>
      ${tags ? `<div class="${CLS.chipRow}">${tags}</div>` : ''}
      ${meta.length ? `<div class="${CLS.chipRow}">${meta.join('')}</div>` : ''}
      ${hint}
    </article>`;
};

const renderReview = (candidates, existing, companies, onExit) => {
  const el = document.getElementById('ri-brags-review');
  if (!el) return;
  if (!candidates.length) {
    el.innerHTML = emptyState({ message: t('profile_import.brags.empty') });
    el.classList.remove('hidden');
    return;
  }
  const cards = candidates.map((c, i) => candidateCardHtml(c, i, findClosestExisting(c, existing), companies)).join('');
  el.innerHTML = `
    <div class="space-y-2">
      ${subheadTitle(t('profile_import.brags.title'))}
      ${helpText(t('profile_import.brags.hint'))}
    </div>
    <div class="space-y-3">${cards}</div>
    <div class="space-y-2">
      ${inlineError({ id: 'ri-brags-apply-error' })}
      ${button({ id: 'ri-brags-apply', variant: 'primary', icon: 'check', label: t('profile_import.brags.apply') })}
    </div>`;
  el.classList.remove('hidden');
  document.getElementById('ri-brags-apply')?.addEventListener('click', () => applySelected(candidates, existing, onExit));
};

const readCandidateEdits = (candidates) => {
  const el = document.getElementById('ri-brags-review');
  if (!el) return [];
  const cards = el.querySelectorAll('[data-brag-idx]');
  const kept = [];
  for (const card of cards) {
    if (!card.querySelector('[data-brag-select]')?.checked) continue;
    const idx = Number(card.dataset.bragIdx);
    const orig = candidates[idx] || {};
    const companySel = card.querySelector('[data-brag-field="company_id"]')?.value || '';
    const yearRaw = (card.querySelector('[data-brag-field="entry_year"]')?.value || '').trim();
    kept.push({
      ...orig,
      title: card.querySelector('[data-brag-field="title"]')?.value?.trim() || '',
      body: card.querySelector('[data-brag-field="body"]')?.value?.trim() || '',
      impact: card.querySelector('[data-brag-field="impact"]')?.value?.trim() || '',
      company_id: companySel ? Number(companySel) : null,
      entry_year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    });
  }
  return kept;
};

const applySelected = async (candidates, existing, onExit) => {
  const btn = document.getElementById('ri-brags-apply');
  const edited = readCandidateEdits(candidates).filter((c) => c.title);
  if (!edited.length) {
    setInlineError('ri-brags-apply-error', t('profile_import.brags.apply.none_selected'));
    return;
  }
  setInlineError('ri-brags-apply-error', '');
  if (btn) btn.disabled = true;

  const { keep, skipped } = filterDuplicatesAgainst(edited, existing);
  let added = 0;
  let failed = 0;
  const errorMessages = new Set();
  for (const c of keep) {
    try {
      await createBragEntry({
        title: c.title,
        body: c.body,
        impact: c.impact,
        tags: c.tags || [],
        company_id: c.company_id,
        entry_year: c.entry_year,
      });
      added++;
    } catch (err) {
      failed++;
      errorMessages.add(err?.message || String(err));
    }
  }
  if (btn) btn.disabled = false;

  if (failed > 0) {
    const total = keep.length;
    const summary = added === 0
      ? t('profile_import.brags.apply.all_failed')
      : t('profile_import.brags.apply.some_failed', { failed, total });
    const details = [...errorMessages].join(' · ');
    setInlineError('ri-brags-apply-error', `${summary} — ${details}`);
    return;
  }
  toast(t('profile_import.brags.apply.summary', { added }), 'ok');
  onExit?.('brag');
};

const runBragExtraction = async (onExit) => {
  const md = document.getElementById('ri-markdown')?.value?.trim();
  if (!md) {
    setBragsError(t('profile_import.error.unsupported'));
    return;
  }
  setBragsError('');
  const locale = currentLocale();
  const [existing, companies] = await Promise.all([listBragEntries(), listCompanies()]);
  let brags = getCachedExtraction(md, locale);
  if (!brags) {
    setBragsStatus(true);
    try {
      // Multi-page CVs fan out into per-section LLM calls so the model
      // attends to every bullet; small CVs stay a single call. Concurrency
      // is capped and each call retries once on a rate-limit error — BYOK
      // providers tolerate small bursts but not unbounded parallelism.
      const chunks = chunkMarkdownBySections(md);
      // Show per-chunk progress when there's more than one call — user
      // knows the request is progressing and can spot which section was
      // last dispatched to the LLM. Static label for the single-call case.
      let done = 0;
      const showProgress = chunks.length > 1;
      const reportStart = (chunk) => {
        if (!showProgress) return;
        setBragsStatus(true, t('profile_import.brags.status.chunk_progress', {
          done, total: chunks.length, snippet: chunkSnippet(chunk),
        }));
      };
      const reportDone = () => {
        if (!showProgress) return;
        done += 1;
      };
      const results = await mapWithConcurrency(
        chunks, CHUNK_CONCURRENCY,
        async (chunk) => {
          reportStart(chunk);
          const r = await retryOnRateLimit(() => extractBragsFromResume(chunk, locale));
          reportDone();
          return r;
        },
      );
      brags = results.flatMap((r) => r?.brags || []);
      setCachedExtraction(md, locale, brags);
    } catch (err) {
      setBragsStatus(false);
      const msg = err?.message || String(err);
      if (msg.includes('no_llm_configured') || msg.includes('setup')) {
        setBragsError(t('profile_import.brags.error.no_llm'));
      } else if (isRateLimitError(err)) {
        setBragsError(`${t('profile_import.brags.error.rate_limit')} — ${msg}`);
      } else {
        setBragsError(t('profile_import.brags.error.generic', { error: msg }));
      }
      return;
    }
    setBragsStatus(false);
  }
  renderReview(brags, existing, companies, onExit);
};

export const wireBragsExtract = (onExit) => {
  const btn = document.getElementById('ri-brags-extract');
  if (!btn) return;
  btn.addEventListener('click', () => runBragExtraction(onExit));
};
