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
import { getServerScraperStatus } from '../scrape-client.mjs';
import { badge } from './components.mjs';
import { t } from '../i18n.mjs';

// invalidateScraperServerStatus is kept as a no-op for callers that still
// invoke it after toggling BYOK config. The shared probe in scrape-client.mjs
// caches at module scope and short-circuits on isStaticHost, so there's no
// per-badge cache to invalidate here anymore.
export const invalidateScraperServerStatus = () => {};

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
