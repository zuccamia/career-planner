// Main-thread controller for the résumé extraction Web Worker. Spawns the
// worker lazily on first call, converts DOCX HTML → Markdown via turndown
// (which needs the main-thread DOMParser), enforces a wall-clock timeout,
// and surfaces a stable { kind, markdown, warnings } shape.
//
// Vendored dependency:
//   /static/vendor/turndown/turndown.esm.js
//   Bump turndown and re-download lib/turndown.browser.es.js from
//   https://cdn.jsdelivr.net/npm/turndown/lib/turndown.browser.es.js

import { STATIC_ROOT } from '../host.mjs';

const WORKER_URL = `${STATIC_ROOT}js/workers/extract-worker.mjs`;
const TURNDOWN_URL = `${STATIC_ROOT}vendor/turndown/turndown.esm.js`;
const DEFAULT_TIMEOUT_MS = 30_000;

let worker = null;
let nextId = 1;
const pending = new Map();

const ensureWorker = () => {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type: 'module' });
  worker.addEventListener('message', (event) => {
    const { id } = event.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (event.data.ok) entry.resolve(event.data);
    else entry.reject(new Error(event.data.error || 'extract_failed'));
  });
  worker.addEventListener('error', (event) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(event.message || 'worker_error'));
    }
    pending.clear();
    worker = null;
  });
  return worker;
};

let turndownPromise = null;
const getTurndown = () => {
  if (turndownPromise) return turndownPromise;
  turndownPromise = (async () => {
    const mod = await import(TURNDOWN_URL);
    const TurndownService = mod.default || mod.TurndownService;
    if (typeof TurndownService !== 'function') {
      throw new Error('turndown module missing TurndownService export');
    }
    return new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
    });
  })();
  return turndownPromise;
};

const postToWorker = (bytes, timeoutMs) =>
  new Promise((resolve, reject) => {
    const w = ensureWorker();
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      if (worker) {
        worker.terminate();
        worker = null;
      }
      reject(new Error('extract_timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, bytes }, [bytes.buffer]);
  });

// extractResume(bytes, { timeoutMs }) → { kind, markdown, warnings }
// bytes must be a Uint8Array. Throws on unsupported format, timeout, or
// parser failure.
export const extractResume = async (bytes, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const reply = await postToWorker(bytes, timeoutMs);
  if (reply.kind === 'pdf') {
    return { kind: 'pdf', markdown: reply.markdown, warnings: reply.warnings || [] };
  }
  if (reply.kind === 'docx') {
    const turndown = await getTurndown();
    const markdown = turndown.turndown(reply.html || '').trim();
    return { kind: 'docx', markdown, warnings: reply.warnings || [] };
  }
  throw new Error(`unexpected_kind:${reply.kind}`);
};
