// Local dashboard: application pipeline (funnel bars on mobile, sankey on
// desktop) + 30-day activity chart (14-day visible window, scrolls).
//
// D3 and d3-sankey are bundled locally under /static/vendor/ and lazy-loaded
// on first mount. Local-first values keep vendor deps offline-friendly.

import {
  countApplicationsByStatus,
  listStatusTransitionCounts,
  listDailyAppliedCounts,
} from '../entities/applications.mjs';
import { listDailyEntryCounts } from '../entities/communications.mjs';
import { escapeHtml } from '../ui/dom.mjs';
import { CLS } from '../ui/classes.mjs';
import { emptyState, helpText, pageHeader } from '../ui/components.mjs';
import { t } from '../i18n.mjs';

const ACTIVITY_WINDOW_DAYS = 30;
const ACTIVITY_VISIBLE_DAYS = 14;

// STAGE_DEFINITIONS drives the mobile funnel and the totals grouping. Roll-up
// per §9: Lead (status-lead), Applied (brand teal), Assessment + Interviews
// (brass ramp), Offer (status-win), Rejected (status-out), Withdrawn + Ghosted
// (both status-hold gray but distinct rows — you-exit vs they-went-silent).
const STAGE_DEFINITIONS = [
  { key: 'leads',      statuses: ['lead'],                                                                  accent: 'bg-status-lead', muted: 'bg-status-lead-bg', fill: '#4E6E8E' },
  { key: 'applied',    statuses: ['applied'],                                                               accent: 'bg-brand',       muted: 'bg-brand-tint',     fill: '#0F5C5B' },
  { key: 'assessment', statuses: ['online_assessment'],                                                     accent: 'bg-brass',       muted: 'bg-brass-tint',     fill: '#D9AF74' },
  { key: 'interviews', statuses: ['first_interview', 'second_interview', 'additional_interview'],           accent: 'bg-brass',       muted: 'bg-brass-tint',     fill: '#B4823A' },
  { key: 'offer',      statuses: ['offer'],                                                                 accent: 'bg-status-win',  muted: 'bg-status-win-bg',  fill: '#2F7D5B' },
  { key: 'rejected',   statuses: ['rejected'],                                                              accent: 'bg-status-out',  muted: 'bg-status-out-bg',  fill: '#A05648' },
  { key: 'withdrawn',  statuses: ['withdrawn'],                                                             accent: 'bg-status-hold', muted: 'bg-status-hold-bg', fill: '#7D8A93' },
  { key: 'ghosted',    statuses: ['ghosted'],                                                               accent: 'bg-status-hold', muted: 'bg-status-hold-bg', fill: '#7D8A93' },
];

// SANKEY_STATUS_DEFS lists every distinct pipeline status. `color` is the node
// fill; the four interview sub-stages share a brass ramp (light → dark by
// depth) per §9 so the Sankey shows progression a flat brass would hide.
// Withdrawn and Ghosted are distinct terminal sinks; both status-hold gray.
const SANKEY_STATUS_DEFS = [
  { status: 'applied',              label: 'Applied',              color: '#0F5C5B', depth: 0, verticalOrder: 2, terminal: false },
  { status: 'online_assessment',    label: 'Assessment',           color: '#D9AF74', depth: 1, verticalOrder: 3, terminal: false },
  { status: 'first_interview',      label: '1st interview',        color: '#C6944F', depth: 2, verticalOrder: 4, terminal: false },
  { status: 'second_interview',     label: '2nd interview',        color: '#B4823A', depth: 3, verticalOrder: 4, terminal: false },
  { status: 'additional_interview', label: 'Additional interview', color: '#8F6626', depth: 4, verticalOrder: 4, terminal: false },
  { status: 'offer',                label: 'Offer',                color: '#2F7D5B', depth: 5, verticalOrder: 4, terminal: true },
  { status: 'withdrawn',            label: 'Withdrawn',            color: '#7D8A93', depth: 3, verticalOrder: 1, terminal: true },
  { status: 'ghosted',              label: 'Ghosted',              color: '#7D8A93', depth: 4, verticalOrder: 1, terminal: true },
  { status: 'rejected',             label: 'Rejected',             color: '#A05648', depth: 6, verticalOrder: 0, terminal: true },
];

// ---------- helpers ----------

const scaledFunnelWidth = (count, total) => {
  if (total <= 0 || count <= 0) return 28;
  const w = Math.floor((count / total) * 100);
  return Math.max(28, Math.min(100, w));
};

const scaledBarHeight = (count, max) => {
  if (count <= 0 || max <= 0) return 0;
  const h = Math.floor((count / max) * 100);
  return Math.max(8, Math.min(100, h));
};

// YYYY-MM-DD in local time. The activity window is aligned to local days so
// "today" on the chart matches what the user just did.
const dayKey = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// MM/DD in local time — matches the compact format used across the sidebar
// activity chart. Zero-padded so widths stay uniform.
const shortDayLabel = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

// Convert a naive "YYYY-MM-DD" day key (server rows are UTC-substr'd) into a
// local Date at midnight. Rows use the same substr on occurred_at/created_at
// so aggregation stays consistent even if the client and events differ in tz.
const parseDayKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// ---------- data ----------

const buildPipelineStages = async () => {
  const counts = await countApplicationsByStatus();
  const stages = [];
  let total = 0;
  for (const def of STAGE_DEFINITIONS) {
    let count = 0;
    for (const s of def.statuses) count += counts.get(s) || 0;
    if (count === 0) continue;
    total += count;
    stages.push({ ...def, count });
  }
  return stages.map(s => ({ ...s, width: scaledFunnelWidth(s.count, total) }));
};

const buildSankeyData = async () => {
  const rows = await listStatusTransitionCounts();
  const defByStatus = new Map(SANKEY_STATUS_DEFS.map(d => [d.status, d]));
  const aggregated = new Map(); // key: `${from}->${to}` → n
  const activeStatuses = new Set();
  const valueByStatus = new Map();
  for (const r of rows) {
    if (!defByStatus.has(r.from_status) || !defByStatus.has(r.to_status)) continue;
    const key = `${r.from_status}->${r.to_status}`;
    aggregated.set(key, (aggregated.get(key) || 0) + r.n);
    activeStatuses.add(r.from_status);
    activeStatuses.add(r.to_status);
    valueByStatus.set(r.from_status, (valueByStatus.get(r.from_status) || 0) + r.n);
    valueByStatus.set(r.to_status, (valueByStatus.get(r.to_status) || 0) + r.n);
  }
  if (aggregated.size === 0) return { nodes: [], links: [] };

  const nodes = [];
  const indexByStatus = new Map();
  for (const def of SANKEY_STATUS_DEFS) {
    if (!activeStatuses.has(def.status)) continue;
    indexByStatus.set(def.status, nodes.length);
    nodes.push({
      id: def.status,
      name: t(`applications.status.${def.status}`),
      color: def.color,
      value: valueByStatus.get(def.status) || 0,
      depth: def.depth,
      verticalOrder: def.verticalOrder,
      terminal: def.terminal,
    });
  }
  const links = [];
  for (const from of SANKEY_STATUS_DEFS) {
    for (const to of SANKEY_STATUS_DEFS) {
      const n = aggregated.get(`${from.status}->${to.status}`);
      if (!n) continue;
      links.push({ source: indexByStatus.get(from.status), target: indexByStatus.get(to.status), value: n });
    }
  }
  return { nodes, links };
};

// buildActivitySeries returns { days, totals } for the given end day. Mirrors
// buildDashboardActivitySeries in home_handlers.go, including the 2-year
// fallback window when no counts land in the initial 30 days.
const buildActivitySeries = async (endDay) => {
  const asISO = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const query = async (start, end) => {
    const startISO = asISO(start);
    const endISO = asISO(end);
    const [applied, entries] = await Promise.all([
      listDailyAppliedCounts(startISO, endISO),
      listDailyEntryCounts(startISO, endISO),
    ]);
    return { applied, entries };
  };
  const latestDay = ({ applied, entries }) => {
    let latest = null;
    const consider = (row) => {
      const d = parseDayKey(row.day);
      if (!latest || d > latest) latest = d;
    };
    applied.forEach(consider);
    entries.forEach(consider);
    return latest;
  };

  const buildWindow = (end) => {
    const days = [];
    const idx = new Map();
    for (let i = ACTIVITY_WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const entry = {
        date: d, label: shortDayLabel(d),
        appliedCount: 0, threadEntryCount: 0,
        totalCount: 0,
        appliedHeight: 0, threadEntryHeight: 0,
      };
      days.push(entry);
      idx.set(dayKey(d), entry);
    }
    return { days, idx };
  };

  const start = new Date(endDay);
  start.setDate(start.getDate() - (ACTIVITY_WINDOW_DAYS - 1));
  const endExclusive = new Date(endDay);
  endExclusive.setDate(endExclusive.getDate() + 1);
  let counts = await query(start, endExclusive);
  let { days, idx } = buildWindow(endDay);

  const anyInWindow = [...counts.applied, ...counts.entries].some(r => idx.has(r.day));
  if (!anyInWindow) {
    // Legacy fallback: peek back up to two years to find the newest event day
    // and re-center the 30-day window on it so the chart isn't blank.
    const discoveryStart = new Date(endDay);
    discoveryStart.setFullYear(discoveryStart.getFullYear() - 2);
    const discovery = await query(discoveryStart, endExclusive);
    const latest = latestDay(discovery);
    if (latest) {
      ({ days, idx } = buildWindow(latest));
      const rangeStart = new Date(latest);
      rangeStart.setDate(rangeStart.getDate() - (ACTIVITY_WINDOW_DAYS - 1));
      const rangeEnd = new Date(latest);
      rangeEnd.setDate(rangeEnd.getDate() + 1);
      counts = await query(rangeStart, rangeEnd);
    }
  }

  let max = 0;
  const apply = (rows, field, totalField, totals) => {
    for (const r of rows) {
      const day = idx.get(r.day);
      if (!day) continue;
      day[field] = r.n;
      totals[totalField] += r.n;
      if (r.n > max) max = r.n;
    }
  };
  const totals = { applied: 0, threadEntries: 0, total: 0 };
  apply(counts.applied, 'appliedCount', 'applied', totals);
  apply(counts.entries, 'threadEntryCount', 'threadEntries', totals);
  for (const day of days) {
    day.totalCount = day.appliedCount + day.threadEntryCount;
    totals.total += day.totalCount;
    day.appliedHeight = scaledBarHeight(day.appliedCount, max);
    day.threadEntryHeight = scaledBarHeight(day.threadEntryCount, max);
  }
  return { days, totals };
};

// ---------- markup ----------

const shellHtml = () => `
  <div class="space-y-6">
    <section class="space-y-2">
      ${pageHeader({ page: 'dashboard', title: t('page.dashboard.title'), tagline: null })}
    </section>
    <section id="pipeline-section"></section>
    <section id="activity-section"></section>
  </div>
`;

const funnelHtml = (stages) => `
  <div class="space-y-4 lg:hidden">
    ${stages.map(s => `
      <div class="${CLS.paperCard}">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="${CLS.statLabel} text-ink-faint">${escapeHtml(t(`dashboard.stage.${s.key}.label`))}</p>
            ${s.key === 'interviews' ? `<p class="${CLS.helpText}">${escapeHtml(t(`dashboard.stage.${s.key}.status`))}</p>` : ''}
          </div>
          <p class="${CLS.statTotal}">${s.count}</p>
        </div>
        <div class="h-3 rounded-full ${s.muted}">
          <div class="h-3 rounded-full ${s.accent}" style="width: ${s.width}%;"></div>
        </div>
      </div>
    `).join('')}
  </div>
`;

const pipelineHtml = (stages, sankey) => {
  const article = (body) => `
    <article class="${CLS.cardWide}">
      <div class="space-y-1">
        <h2 class="${CLS.cardTitle}">${t('dashboard.pipeline.heading')}</h2>
      </div>
      ${body}
    </article>`;
  if (!stages.length) return article(emptyState({ message: t('dashboard.pipeline.empty') }));
  const sankeyBlock = `
    <div class="hidden overflow-x-auto lg:block">
      <div class="${CLS.sankeyViewport}">
        <svg id="pipeline-sankey" class="block h-auto w-full overflow-visible"
             viewBox="0 0 1080 380" preserveAspectRatio="xMidYMid meet"
             role="img" aria-label="${t('dashboard.pipeline.aria')}"></svg>
        <div id="pipeline-sankey-fallback" class="mt-4 hidden"></div>
      </div>
    </div>`;
  return article(funnelHtml(stages) + sankeyBlock);
};

const activityHtml = (days, totals) => {
  const article = (body) => `
    <article class="${CLS.cardWide}">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div class="space-y-1">
          <h2 class="${CLS.cardTitle}">${t('dashboard.activity.heading')}</h2>
          ${helpText(t('dashboard.activity.help', { visible: ACTIVITY_VISIBLE_DAYS, window: ACTIVITY_WINDOW_DAYS }))}
        </div>
        <div class="${CLS.statGrid}">
          ${totalCard(t('dashboard.activity.total.applied'), totals.applied, 'blue')}
          ${totalCard(t('dashboard.activity.total.threads'), totals.threadEntries, 'amber')}
          ${totalCard(t('dashboard.activity.total.total'), totals.total, 'slate')}
        </div>
      </div>
      ${body}
    </article>`;
  if (!days.length) return article(emptyState({ message: t('dashboard.activity.empty') }));
  return article(`
    <div class="${CLS.chartLegend}">
      <span class="inline-flex items-center gap-2"><span class="${CLS.dotMd} bg-brand"></span>${t('dashboard.activity.legend.applied')}</span>
      <span class="inline-flex items-center gap-2"><span class="${CLS.dotMd} bg-brass"></span>${t('dashboard.activity.legend.threads')}</span>
    </div>
    <div id="activity-scroll" class="overflow-x-auto">
      <div class="min-w-[1440px]">
        <div class="${CLS.chartCanvas}">
          ${days.map(d => `
            <div class="${CLS.chartDayCol}">
              <div class="${CLS.funnelBars}"
                   aria-label="${escapeHtml(t('dashboard.activity.bar_aria', { label: d.label, applied: d.appliedCount, threads: d.threadEntryCount }))}">
                <div class="${CLS.chartBar} bg-brand"    style="height: ${d.appliedHeight}%;"     title="${escapeHtml(t('dashboard.activity.bar_applied', { n: d.appliedCount }))}"></div>
                <div class="${CLS.chartBar} bg-brass"       style="height: ${d.threadEntryHeight}%;" title="${escapeHtml(t('dashboard.activity.bar_threads', { n: d.threadEntryCount }))}"></div>
              </div>
              <div class="space-y-1 text-center">
                <p class="${CLS.chartAxisLabelStrong}">${escapeHtml(d.label)}</p>
                <p class="${CLS.chartAxisLabel}">${t('dashboard.activity.day_total', { n: d.totalCount })}</p>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>`);
};

const TOTAL_CARD_PALETTE = {
  blue:    { bg: 'bg-brand-tint',    text: 'text-brand' },
  amber:   { bg: 'bg-brass-tint',   text: 'text-brass' },
  emerald: { bg: 'bg-status-win-bg', text: 'text-status-win' },
  slate:   { bg: 'bg-paper',  text: 'text-ink-soft' },
};

const totalCard = (label, count, palette) => {
  const p = TOTAL_CARD_PALETTE[palette] || TOTAL_CARD_PALETTE.slate;
  return `
    <div class="flex min-h-20 flex-col justify-between rounded-2xl ${p.bg} px-4 py-3" data-total="${palette}">
      <p class="${CLS.statLabel} ${p.text}">${escapeHtml(label)}</p>
      <p class="text-right ${CLS.statTotal}">${count}</p>
    </div>`;
};

// ---------- sankey rendering ----------

const D3_SRC = '/static/vendor/d3.min.js';
const D3_SANKEY_SRC = '/static/vendor/d3-sankey.min.js';

const loadScript = (src) => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
  const s = document.createElement('script');
  s.src = src;
  s.async = false;
  s.onload = () => resolve();
  s.onerror = () => reject(new Error(`failed to load ${src}`));
  document.head.appendChild(s);
});

const loadD3 = async () => {
  await loadScript(D3_SRC);
  await loadScript(D3_SANKEY_SRC);
  return window.d3;
};

const renderSankey = async (data) => {
  const mount = document.getElementById('pipeline-sankey');
  const fallbackEl = document.getElementById('pipeline-sankey-fallback');
  if (!mount) return;
  const showFallback = (message) => {
    mount.classList.add('hidden');
    if (fallbackEl) {
      fallbackEl.innerHTML = emptyState({ message });
      fallbackEl.classList.remove('hidden');
    }
  };
  if (!data.nodes.length || !data.links.length) {
    showFallback(t('dashboard.pipeline.no_transitions'));
    return;
  }
  let d3;
  try { d3 = await loadD3(); }
  catch { showFallback(t('dashboard.pipeline.load_failed')); return; }
  if (!d3 || typeof d3.sankey !== 'function') {
    showFallback(t('dashboard.pipeline.load_failed'));
    return;
  }

  // Layout + palette follow the cool-ledger spec §6: node fill = stage color,
  // link color = source's color unless the target is a terminal outcome (offer,
  // rejected, ghosted, withdrawn) — those take the outcome's color so the
  // final result is legible at a glance.
  // Opacity 0.40 at rest, 0.68 on hover. Nodes get a 1px surface stroke so
  // touching nodes separate cleanly.
  const CFG = {
    width: 1080, height: 380, nodeWidth: 12, nodePadding: 22,
    labelOffset: 10, rightPad: 16, gutterFallback: 170, cornerRadius: 5,
    depthEasing: 1.5,
    link: { base: 0.40, hot: 0.68, muted: 0.12 },
    nodeMuted: 0.35,
    nodeStroke: '#FBFCFB',       // --color-surface
    nameFill: '#16202B',         // --color-ink
    countFill: '#7D8A93',        // --color-ink-faint
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  };
  const linkColor = (d) => (d.target.terminal ? d.target.color : d.source.color);
  const margin = { top: 18, right: CFG.gutterFallback, bottom: 18, left: 20 };
  const svg = d3.select(mount);
  svg.selectAll('*').remove();

  const sankey = d3.sankey()
    .nodeId(d => d.id)
    .nodeWidth(CFG.nodeWidth)
    .nodePadding(CFG.nodePadding)
    .nodeAlign(d3.sankeyLeft)
    .nodeSort((a, b) =>
      ((a.verticalOrder ?? 0) - (b.verticalOrder ?? 0)) ||
      d3.descending(a.value, b.value) ||
      d3.ascending(a.name, b.name))
    .extent([[margin.left, margin.top], [CFG.width - margin.right, CFG.height - margin.bottom]]);

  const graph = sankey({
    nodes: data.nodes.map(d => ({ ...d })),
    links: data.links.map(d => ({
      ...d,
      source: data.nodes[d.source].id,
      target: data.nodes[d.target].id,
    })),
  });

  const maxDepth = d3.max(graph.nodes, d => d.depth) || 0;
  const frac = (depth) => (maxDepth === 0 ? 0 : Math.pow((depth || 0) / maxDepth, CFG.depthEasing));

  const links = svg.append('g')
    .attr('fill', 'none')
    .selectAll('path')
    .data(graph.links)
    .join('path')
    .attr('stroke', linkColor)
    .attr('stroke-opacity', CFG.link.base)
    .attr('stroke-width', d => Math.max(1, d.width));

  const nodes = svg.append('g').selectAll('g').data(graph.nodes).join('g');
  const rects = nodes.append('rect')
    .attr('rx', CFG.cornerRadius)
    .attr('fill', d => d.color)
    .attr('stroke', CFG.nodeStroke)
    .attr('stroke-width', 1);

  const label = nodes.append('text')
    .attr('text-anchor', 'start')
    .attr('font-family', CFG.fontFamily);
  label.append('tspan').attr('dy', '-0.15em').attr('font-size', 11).attr('font-weight', 500).attr('fill', CFG.nameFill).text(d => d.name);
  label.append('tspan').attr('dy', '1.3em').attr('font-size', 11).attr('font-weight', 500).attr('fill', CFG.countFill).text(d => d.value || 0);

  let widestLabel = 0;
  label.selectAll('tspan').each(function () {
    const len = this.getComputedTextLength ? this.getComputedTextLength() : 0;
    if (len > widestLabel) widestLabel = len;
  });

  margin.right = widestLabel > 0 ? CFG.labelOffset + widestLabel + CFG.rightPad : CFG.gutterFallback;
  const rightEdge = CFG.width - margin.right - CFG.nodeWidth;
  const usableWidth = rightEdge - margin.left;

  graph.nodes.forEach(node => {
    node.x0 = margin.left + frac(node.depth) * usableWidth;
    node.x1 = node.x0 + CFG.nodeWidth;
    node.labelX = node.x1 + CFG.labelOffset;
  });
  sankey.update(graph);

  rects
    .attr('x', d => d.x0).attr('y', d => d.y0)
    .attr('width', d => d.x1 - d.x0)
    .attr('height', d => Math.max(1, d.y1 - d.y0));
  links.attr('d', d3.sankeyLinkHorizontal());
  label.attr('y', d => (d.y0 + d.y1) / 2);
  label.selectAll('tspan').attr('x', d => d.labelX);

  const trace = (start) => {
    const litLinks = new Set();
    const litNodes = new Set([start]);
    const walk = (node, downstream) => {
      (downstream ? node.sourceLinks : node.targetLinks).forEach(link => {
        if (litLinks.has(link)) return;
        litLinks.add(link);
        const next = downstream ? link.target : link.source;
        litNodes.add(next);
        walk(next, downstream);
      });
    };
    walk(start, true); walk(start, false);
    return { litLinks, litNodes };
  };

  nodes
    .on('mouseenter', (_event, node) => {
      const { litLinks, litNodes } = trace(node);
      links.attr('stroke-opacity', l => litLinks.has(l) ? CFG.link.hot : CFG.link.muted);
      rects.attr('opacity', n => litNodes.has(n) ? 1 : CFG.nodeMuted);
    })
    .on('mouseleave', () => {
      links.attr('stroke-opacity', CFG.link.base);
      rects.attr('opacity', 1);
    });
};

// ---------- entrypoint ----------

export const mountDashboard = async (root) => {
  root.innerHTML = shellHtml();

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const [stages, sankeyData, activity] = await Promise.all([
    buildPipelineStages(),
    buildSankeyData(),
    buildActivitySeries(now),
  ]);

  document.getElementById('pipeline-section').innerHTML = pipelineHtml(stages, sankeyData);
  document.getElementById('activity-section').innerHTML = activityHtml(activity.days, activity.totals);
  // Default scroll to the rightmost edge so the newest days are in view; users
  // can scroll left to see the older half of the 30-day window.
  const scroller = document.getElementById('activity-scroll');
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;

  // Sankey mounts only when the desktop layout is visible — but D3 hydrates
  // the SVG regardless; CSS controls visibility. Skip the fetch entirely when
  // the pipeline has no data (funnel article already shows the empty state).
  if (stages.length) await renderSankey(sankeyData);
};
