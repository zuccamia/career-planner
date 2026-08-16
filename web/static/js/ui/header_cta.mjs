// Header CTA — the single primary action in the app header, swapping
// content based on onboarding state:
//   - No headline set  → "Start here" link to /profile.
//   - Headline set     → Discover button (enabled/disabled by server status).
//
// Called once at boot. Re-invoke after the profile page saves changes if
// you want the CTA to flip without a reload.

import { getOverview } from '../entities/profile-overview.mjs';
import { getServerDiscoverStatus } from '../discover-client.mjs';
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

  const status = await getServerDiscoverStatus();
  mount.innerHTML = button({
    id: 'header-btn-discover',
    variant: 'primaryCompact',
    icon: 'search',
    label: t('discover.button.label'),
    ariaLabel: t('discover.button.aria'),
    disabled: !status.available,
  });
  const btn = document.getElementById('header-btn-discover');
  if (!btn) return;
  if (status.available) {
    btn.addEventListener('click', () => openDiscoverPanel(btn));
  } else {
    btn.title = t('discover.error.unavailable');
  }
};
