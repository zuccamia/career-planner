// Browser-side i18n. Consumes the same JSON bundles the Go server reads
// (internal/i18n/). Preference lives in IndexedDB; the `lang` cookie mirrors
// it so server templates render in the chosen locale on the next request.
// Missing keys fall back to the default-locale bundle, then to the key
// itself — mirrors the Go T() so partial extraction is safe.

import { idbGet, idbSet } from './storage/idb.mjs';

const COOKIE_NAME = 'lang';
const IDB_KEY = 'localePreference';

// Native display name for each supported locale. Missing entries fall back to
// the code itself. Keep in sync with manifest.supported.
const DISPLAY_NAMES = {
  en: 'English',
  vi: 'Tiếng Việt',
};

// Populated by initI18n. SUPPORTED[0] is the default locale AND the fallback
// bundle for missing keys.
export let SUPPORTED = [];
export let DEFAULT_LOCALE = '';
let active = '';
let bundle = {};
let fallback = {};

// initI18n runs once from main.mjs before any page mounts.
export const initI18n = async () => {
  await loadManifest();
  active = await resolvePreferred();
  writeCookie(active);
  bundle = await loadBundle(active);
  fallback = active === DEFAULT_LOCALE ? bundle : await loadBundle(DEFAULT_LOCALE);
  return active;
};

// t looks up key in the active bundle, falls back to the default-locale
// bundle, then to the key itself. `params` interpolates {name}-style
// placeholders as raw values — callers escape at the leaf when needed
// (template literals injecting into innerHTML), or rely on downstream
// escaping (component helpers already escapeHtml() their string props;
// toast() internally escapes; textContent/confirm/setInline* are plain text).
export const t = (key, params) => {
  const raw = bundle[key] || fallback[key] || key;
  return params ? interpolate(raw, params) : raw;
};

export const currentLocale = () => active;

export const localeDisplayName = (code) => DISPLAY_NAMES[code] || code;

// setLocale persists the choice and reloads so the server-rendered shell
// picks it up in one step.
export const setLocale = async (code) => {
  if (!SUPPORTED.includes(code)) throw new Error(`unsupported locale: ${code}`);
  await idbSet(IDB_KEY, { locale: code, updatedAt: new Date().toISOString() });
  writeCookie(code);
  window.location.reload();
};

// ---------- helpers ----------

const loadManifest = async () => {
  const manifest = await fetchJSON('/static/i18n/manifest.json');
  if (!Array.isArray(manifest.supported) || manifest.supported.length === 0) {
    throw new Error('i18n manifest: supported is empty');
  }
  SUPPORTED = manifest.supported.slice();
  DEFAULT_LOCALE = SUPPORTED[0];
  // Warn when a manifest locale lacks a display name — the language switcher
  // falls back to showing the raw code (e.g. "vi" instead of "Tiếng Việt"),
  // which is cosmetic but easy to miss when adding a locale.
  const missing = SUPPORTED.filter(code => !(code in DISPLAY_NAMES));
  if (missing.length) {
    console.warn(`[i18n] DISPLAY_NAMES missing entries for: ${missing.join(', ')}`);
  }
};

// Resolution order: IndexedDB → cookie → browser navigator.language → DEFAULT_LOCALE.
const resolvePreferred = async () => {
  const stored = await idbGet(IDB_KEY);
  if (stored && SUPPORTED.includes(stored.locale)) return stored.locale;
  return readCookie() || pickFromNavigator() || DEFAULT_LOCALE;
};

const loadBundle = async (code) => {
  try {
    return await fetchJSON(`/static/i18n/${code}.json`);
  } catch (err) {
    console.warn(`[i18n] failed to load ${code} bundle`, err);
    return {};
  }
};

const pickFromNavigator = () => {
  const langs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);
  for (const raw of langs) {
    const code = String(raw).toLowerCase();
    const base = code.split('-')[0];
    if (SUPPORTED.includes(code)) return code;
    if (SUPPORTED.includes(base)) return base;
  }
  return '';
};

const interpolate = (raw, params) =>
  raw.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] != null ? String(params[name]) : `{${name}}`,
  );

const fetchJSON = async (path) => {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
  return res.json();
};

const readCookie = () => {
  const m = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/);
  const code = m ? decodeURIComponent(m[1]) : '';
  return SUPPORTED.includes(code) ? code : '';
};

const writeCookie = (code) => {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(code)}; path=/; max-age=${oneYear}; samesite=lax`;
};
