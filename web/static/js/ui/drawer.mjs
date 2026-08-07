// Sidebar drawer: the sidebar is always off-canvas and slides in when the
// top-bar hamburger is tapped. Uses the shared overlay module for backdrop /
// Esc / outside-click / focus trap / scroll lock.

import { openOverlay } from './overlay.mjs';

const SIDEBAR_ID = 'sidebar';
const TOGGLE_ID = 'sidebar-toggle';
const OPEN_CLASS = 'translate-x-0';

let closeFn = null;

const setToggleExpanded = (toggle, expanded) => {
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
};

export const initDrawer = () => {
  const toggle = document.getElementById(TOGGLE_ID);
  const panel = document.getElementById(SIDEBAR_ID);
  if (!toggle || !panel) return;

  const open = () => {
    closeFn = openOverlay({
      panel,
      trigger: toggle,
      onOpen: () => panel.classList.add(OPEN_CLASS),
      onClose: () => {
        panel.classList.remove(OPEN_CLASS);
        setToggleExpanded(toggle, false);
        closeFn = null;
      },
    });
    setToggleExpanded(toggle, true);
  };

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    if (closeFn) closeFn();
    else open();
  });

  panel.addEventListener('click', (e) => {
    if (!closeFn) return;
    if (e.target.closest('a[href]')) closeFn();
  });
};
