// Renders the "Web scraper" pill in the sidebar. Three states:
//   - BYOK scraper active            → slate "BYOK Scraper · <backend>"
//   - BYOK off, server scraper set   → slate "Server Scraper · <backend>"
//   - No scraper anywhere            → hidden (scraper is optional; unlike LLM
//                                     the app is fully functional without it)
// Active states are neutral config facts; reserve green for success.
// BYOK takes precedence — a user who configured their own scraper sees the
// BYOK badge even when the deploy also has a server-side scraper. Clicking
// navigates to Settings → Web scraper.

import { getScraperConfig } from '../storage/scraper.mjs';
import { badge } from './components.mjs';
import { t } from '../i18n.mjs';

let cachedServerStatus = null;

const getServerScraperStatus = async () => {
  if (cachedServerStatus) return cachedServerStatus;
  try {
    const res = await fetch('/api/scrape/server-status');
    cachedServerStatus = await res.json();
  } catch {
    cachedServerStatus = { available: false };
  }
  return cachedServerStatus;
};

// invalidateScraperServerStatus lets settings.mjs force a re-read after the
// user toggles their BYOK config, so the badge reflects the new state without
// a page reload.
export const invalidateScraperServerStatus = () => { cachedServerStatus = null; };

export const refreshScraperModeBadge = async () => {
  const wrap = document.getElementById('scraper-mode-badge');
  if (!wrap) return;

  try {
    const [cfg, server] = await Promise.all([getScraperConfig(), getServerScraperStatus()]);
    const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.backend
      && (cfg.backend !== 'firecrawl' || cfg.apiKey));
    if (byokActive) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.byok', { backend: cfg.backend }) });
      wrap.classList.remove('hidden');
    } else if (server.available) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.server', { backend: server.backend }) });
      wrap.classList.remove('hidden');
    } else {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
    }
  } catch (err) {
    console.warn('[local] scraper mode badge', err);
    wrap.classList.add('hidden');
  }
};
