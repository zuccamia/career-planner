// Renders the "Web search" pill in the sidebar. Three states, mirroring
// scraper_mode_badge:
//   - BYOK search active            → slate "BYOK Search · <provider>"
//   - BYOK off, server search set   → slate "Server Search · <provider>"
//   - No search anywhere            → hidden (Discover is optional)
// BYOK precedence + click navigates to Settings → Web search.

import { getServerDiscoverStatus } from '../discover-client.mjs';
import { getByokSearchConfig } from '../storage/byok-search.mjs';
import { badge } from './components.mjs';
import { t } from '../i18n.mjs';

export const refreshSearchModeBadge = async () => {
  const wrap = document.getElementById('search-mode-badge');
  if (!wrap) return;

  try {
    const [cfg, server] = await Promise.all([getByokSearchConfig(), getServerDiscoverStatus()]);
    const byokActive = !!(cfg && cfg.enabled && cfg.provider && cfg.apiKey);
    if (byokActive) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'search', label: t('settings.search.badge.byok', { provider: cfg.provider }) });
      wrap.classList.remove('hidden');
    } else if (server.search_available) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'search', label: t('settings.search.badge.server', { provider: server.provider }) });
      wrap.classList.remove('hidden');
    } else {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
    }
  } catch (err) {
    console.warn('[local] search mode badge', err);
    wrap.classList.add('hidden');
  }
};
