// Multi-step progress indicator. Renders a small ordered list into a target
// element and updates the icon per step as it moves through running → done or
// running → failed. Used by any UI that triggers a multi-step async op
// (LLM calls, dossier building, JD extraction).
//
// Not a determinate progress bar — LLM latency is unpredictable and BYOK
// calls don't stream today, so a percentage would be dishonest. A step list
// is honest and lets the user see which stage is slow.

import { icon } from './icons.mjs';
import { escapeHtml } from './dom.mjs';
import { t } from '../i18n.mjs';

const STATES = {
  running: { color: 'text-brand', glyph: '<span class="inline-block h-3.5 w-3.5 animate-pulse rounded-full bg-brand"></span>' },
  done:    { color: 'text-status-win', glyph: icon('check', 4) },
  failed:  { color: 'text-status-out', glyph: icon('close', 4) },
  pending: { color: 'text-ink-faint', glyph: '<span class="inline-block h-3.5 w-3.5 rounded-full border border-line-strong"></span>' },
};

const renderStep = (name, s) => {
  const state = STATES[s.state] || STATES.pending;
  const label = s.labelKey ? t(s.labelKey) : name;
  const suffix = s.state === 'failed' && s.error
    ? `<span class="text-xs text-status-out">— ${escapeHtml(s.error)}</span>`
    : '';
  const hint = s.hintKey
    ? `<span class="mt-0.5 block text-xs text-ink-faint">↳ ${escapeHtml(t(s.hintKey))}</span>`
    : '';
  return `
    <li class="flex items-start gap-2 text-sm ${state.color}">
      <span class="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center">${state.glyph}</span>
      <div class="min-w-0 flex-1">
        <span>${escapeHtml(label)}</span>
        ${suffix}
        ${hint}
      </div>
    </li>`;
};

// createProgress mounts a progress panel into `el`. Returns a small controller.
// Call start(name, labelKey) as each step begins, then complete(name) or
// fail(name, err) as it resolves. reset() clears the panel between runs.
export const createProgress = (el) => {
  const steps = new Map(); // name -> { labelKey, state, error }

  const paint = () => {
    if (!steps.size) {
      el.innerHTML = '';
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const rows = Array.from(steps.entries()).map(([name, s]) => renderStep(name, s)).join('');
    el.innerHTML = `<ul class="space-y-1.5" aria-live="polite">${rows}</ul>`;
  };

  return {
    start(name, labelKey) {
      steps.set(name, { labelKey, state: 'running' });
      paint();
    },
    complete(name) {
      const s = steps.get(name);
      if (!s) return;
      s.state = 'done';
      paint();
    },
    fail(name, err) {
      const s = steps.get(name);
      if (!s) return;
      s.state = 'failed';
      s.error = err && (err.message || String(err));
      paint();
    },
    reset() {
      steps.clear();
      paint();
    },
    // Return a callback shaped for rpc.mjs — { name, status, error?, hintKey? }
    // where status is 'running' | 'done' | 'failed' | 'skipped'. hintKey (if
    // set on the initial 'running' event) renders as a small sub-line under
    // the step label.
    asCallback(labelResolver) {
      return ({ name, status, error, hintKey }) => {
        const labelKey = (labelResolver && labelResolver(name)) || `progress.step.${name}`;
        if (status === 'running') { steps.set(name, { labelKey, hintKey, state: 'running' }); }
        else if (status === 'done') { const s = steps.get(name); if (s) s.state = 'done'; }
        else if (status === 'failed') { const s = steps.get(name); if (s) { s.state = 'failed'; s.error = error; } }
        else if (status === 'skipped') { steps.delete(name); }
        paint();
      };
    },
  };
};

// stepped wraps an async block with running/done/failed emissions on
// onStep. Shared by rpc.mjs and discover-client.mjs so every pipeline
// speaks the same event contract to createProgress. Opts:
//   hintKey  — sub-label rendered under the running step
//   emptyIf  — (out) => bool; when true, emit 'skipped' (row hides) instead
//              of 'done'. Use so a step that runs cleanly but produces no
//              usable output doesn't leave a misleading green check.
// Legacy: passing a string as the 4th arg is treated as hintKey.
export const stepped = async (onStep, name, fn, opts = {}) => {
  const { hintKey, emptyIf } = typeof opts === 'string' ? { hintKey: opts } : opts;
  onStep({ name, status: 'running', hintKey });
  try {
    const out = await fn();
    onStep({ name, status: emptyIf?.(out) ? 'skipped' : 'done' });
    return out;
  } catch (err) {
    onStep({ name, status: 'failed', error: err && (err.message || String(err)) });
    throw err;
  }
};

// noopStep lets pipeline functions accept a nullable onStep without
// littering call sites with guards.
export const noopStep = () => {};
