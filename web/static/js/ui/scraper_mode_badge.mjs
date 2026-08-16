// Renders the "Web scraper" pill in the sidebar. Three states:
//   - BYOK scraper active            → slate "BYOK Scraper · <provider>"
//   - BYOK off, server scraper set   → slate "Server Scraper · <provider>"
//   - No scraper anywhere            → hidden (scraper is optional; unlike LLM
//                                     the app is fully functional without it)
// Active states are neutral config facts; reserve green for success.
// BYOK takes precedence — a user who configured their own scraper sees the
// BYOK badge even when the deploy also has a server-side scraper. Clicking
// navigates to Settings → Web scraper.

import { getByokScraperConfig, PROVIDERS } from '../storage/byok-scraper.mjs';
import { getServerScraperStatus } from '../scrape-client.mjs';
import { badge } from './components.mjs';
import { t } from '../i18n.mjs';

export const refreshScraperModeBadge = async () => {
  const wrap = document.getElementById('scraper-mode-badge');
  if (!wrap) return;

  try {
    const [cfg, server] = await Promise.all([getByokScraperConfig(), getServerScraperStatus()]);
    const needsKey = PROVIDERS[cfg?.provider]?.requiresApiKey;
    const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.provider && (!needsKey || cfg.apiKey));
    if (byokActive) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.byok', { provider: cfg.provider }) });
      wrap.classList.remove('hidden');
    } else if (server.available) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'link', label: t('settings.scraper.badge.server', { provider: server.provider }) });
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
