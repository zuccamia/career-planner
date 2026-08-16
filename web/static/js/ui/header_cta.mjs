// Header CTA — the single primary action in the app header, swapping
// content based on onboarding state:
//   - No headline set  → "Start here" link to /profile.
//   - Headline set     → Discover button (enabled/disabled by server status).
//
// Called once at boot. Re-invoke after the profile page saves changes if
// you want the CTA to flip without a reload.

import { getOverview } from '../entities/profile-overview.mjs';
import { getServerDiscoverStatus } from '../discover-client.mjs';
import { isByokLLMActive } from '../storage/byok-llm.mjs';
import { isByokSearchActive } from '../storage/byok-search.mjs';
import { openDiscoverPanel } from '../pages/dashboard_discover.mjs';
import { urlFor } from '../host.mjs';
import { button } from './components.mjs';
import { t } from '../i18n.mjs';

export const mountHeaderCTA = async () => {
  const mount = document.getElementById('header-cta');
  if (!mount) return;

  const overview = await getOverview().catch(() => null);
  const hasHeadline = !!(overview?.headline || '').trim();

  if (!hasHeadline) {
    mount.innerHTML = button({
      kind: 'link',
      variant: 'primaryCompact',
      href: urlFor('profile'),
      icon: 'profileCard',
      label: t('header.cta.start_here'),
      ariaLabel: t('header.cta.start_here_aria'),
    });
    return;
  }

  // Discover needs an LLM AND a search backend; either side can come from
  // server config or BYOK. Server-side status is piece-wise so BYOK LLM +
  // server search (or vice versa) still enables the button.
  const [status, byokLLM, byokSearch] = await Promise.all([
    getServerDiscoverStatus(),
    isByokLLMActive(),
    isByokSearchActive(),
  ]);
  const usable = (byokLLM || status.llm_available) && (byokSearch || status.search_available);
  mount.innerHTML = button({
    id: 'header-btn-discover',
    variant: 'primaryCompact',
    icon: 'search',
    label: t('discover.button.label'),
    ariaLabel: t('discover.button.aria'),
    disabled: !usable,
  });
  const btn = document.getElementById('header-btn-discover');
  if (!btn) return;
  if (usable) {
    btn.addEventListener('click', () => openDiscoverPanel(btn));
  } else {
    btn.title = t('discover.error.unavailable');
  }
};
