// Inline-panel helpers. Pages have "panels" (editor, details, threads, …)
// that live above the list by default. When a panel is opened for a specific
// row we move it just above that row so it visually anchors to the card the
// user clicked instead of jumping to the top of the index.

const anchors = new WeakMap(); // panel -> { parent, marker }

// Remember where a panel lives in the default (top-of-list) position. Call
// once, right after the shell is rendered. Places a Comment marker before
// the panel so we can slot it back after DOM moves.
export const rememberPanelAnchor = (panelId) => {
  const panel = document.getElementById(panelId);
  if (!panel || anchors.has(panel)) return;
  const marker = document.createComment(`panel-anchor:${panelId}`);
  panel.parentNode.insertBefore(marker, panel);
  anchors.set(panel, { parent: panel.parentNode, marker });
};

const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');

// Move the panel to sit just above the row `[data-panel-row="rowId"]` inside
// the given container (default `#list-content`). Pass rowId=null to restore
// the panel to its default anchor (used on close, "New" flows, and before
// re-rendering the list — otherwise innerHTML would wipe the panel).
export const mountInlinePanel = (panelId, rowId, containerSel = '#list-content') => {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (rowId == null) {
    const a = anchors.get(panel);
    if (a && a.parent.contains(a.marker)) a.parent.insertBefore(panel, a.marker);
    panel.classList.remove('mb-3');
    return;
  }
  const container = document.querySelector(containerSel);
  if (!container) return;
  const row = container.querySelector(`[data-panel-row="${cssEscape(rowId)}"]`);
  if (!row) return;
  row.insertBefore(panel, row.firstChild);
  panel.classList.add('mb-3');
};

// Convenience: restore every registered panel back to its anchor. Call this
// before wiping `#list-content` so panel DOM isn't destroyed alongside cards.
export const restoreAllPanels = (panelIds) => {
  for (const id of panelIds) mountInlinePanel(id, null);
};
