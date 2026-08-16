// Shared Tailwind class strings for the UI. Kept as literal
// strings so Tailwind's static scanner can see them.

export const CLS = {
  card:                 'space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm',
  cardWide:             'space-y-6 rounded-2xl border border-line bg-surface p-6 shadow-sm',
  statTotal:            'font-display text-2xl font-semibold leading-none text-ink',
  statLabel:            'font-mono text-[0.62rem] font-medium uppercase tracking-[0.14em]',
  statGrid:             'grid grid-cols-3 gap-3',
  chartBar:             'w-3 rounded-t',
  chartCanvas:          'flex h-64 items-end gap-3 rounded-2xl border border-line bg-paper px-4 py-4',
  chartDayCol:          'flex min-w-0 flex-1 flex-col items-center justify-end gap-3',
  chartLegend:          'flex flex-wrap items-center justify-end gap-4 text-sm text-ink-soft',
  chartAxisLabel:       'whitespace-nowrap font-mono text-[0.62rem] font-medium uppercase tracking-[0.14em] text-ink-faint',
  chartAxisLabelStrong: 'whitespace-nowrap font-mono text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-ink-soft',
  funnelBars:           'flex h-40 items-end gap-1',
  sankeyViewport:       'min-w-[960px] rounded-3xl bg-paper p-6',
  rowList:              'overflow-hidden rounded-2xl border border-line bg-surface',
  subCard:              'space-y-4 rounded-2xl border border-line bg-paper/40 p-4',
  paperCard:            'rounded-2xl border border-line bg-paper p-4',
  surfaceCard:          'rounded-2xl border border-line bg-surface p-4',
  searchInput:          'w-full rounded-full border border-line-strong bg-surface pl-10 pr-4 py-2 text-sm text-ink shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand-tint',
  filterPill:           'rounded-full border px-3 py-1 font-mono text-[0.7rem] uppercase tracking-wide transition',
  filterPillOn:         'bg-brand text-white border-brand',
  filterPillOff:        'bg-surface text-ink-soft border-line-strong hover:border-brand hover:text-brand',
  kvLabel:              'font-mono text-[0.68rem] uppercase tracking-wide text-ink-faint',
  filterBanner:         'mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand-deep',
  fileRowBtn:           'flex w-full items-center gap-3 bg-transparent px-4 py-3 text-left transition hover:bg-paper',
  fileRowTitle:         'truncate font-display text-base font-medium text-ink',
  fileRowMeta:          'truncate font-mono text-xs text-ink-faint',
  linkRow:              'flex items-center gap-3 rounded-xl px-3 py-3 transition hover:bg-paper',
  staticRow:            'flex items-center gap-3 px-3 py-2',
  // One row in a stepper/progress list. Callers append their own state color
  // (e.g. text-brand / text-ink-soft / text-ink-faint) so the same base layout
  // covers active, done, and pending states.
  progressStepRow:      'flex items-center gap-3 text-sm',
  rowTitle:             'truncate font-semibold text-ink',
  flexTextCol:          'min-w-0 flex-1 space-y-1',
  textCol:              'min-w-0 space-y-1',
  cardTitle:            'font-display text-xl font-semibold text-ink',
  formRow:              'flex flex-wrap items-center gap-3',
  // Action-button row anchored to the right edge of the section (e.g. the
  // Save / Re-render pair below a source textarea).
  actionRowEnd:         'flex flex-wrap items-center justify-end gap-2',
  // Filename-on-left, buttons-on-right row (e.g. preview headers).
  actionRowBetween:     'flex flex-wrap items-center justify-between gap-2',
  // A wide field + narrow field on one row on ≥sm screens; stacks on
  // mobile. Used for "title + format" and similar pairings.
  gridFieldPair:        'grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end',
  winText:              'text-sm font-medium text-status-win',
  tightList:            'space-y-1 text-sm text-ink',
  metaText:             'font-mono text-xs text-ink-faint',
  codeText:             'font-mono text-xs',
  // Compact control row: stacks on mobile to avoid viewport overflow for
  // input + button combinations, then switches back to a horizontal row on
  // ≥sm screens for denser desktop layouts.
  inlineRow:            'flex flex-col items-stretch gap-2 sm:flex-row sm:items-center',
  gridTwoCol:           'grid sm:grid-cols-2',
  checkbox:             'h-4 w-4 rounded border-line-strong text-brand focus:ring-brand',
  warningBanner:        'rounded-2xl border border-brass/30 bg-brass-tint px-4 py-3 text-sm text-brass',
  tagPill:              'rounded-full border border-line bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft',
  avatarBadge:          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-status-lead-bg font-mono text-xs font-semibold text-status-lead',
  brandLink:            'text-brand underline hover:text-brand-deep',
  tinyLink:             'text-xs font-medium text-brand hover:text-brand-deep',
  linkAction:           'text-sm font-semibold text-brand hover:text-brand-deep',
  helpText:             'text-xs text-ink-faint',
  bodyText:             'text-sm text-ink-soft',
  softRow:              'rounded-2xl bg-paper px-4 py-3',
  entryRow:             'flex items-start gap-3 rounded-xl bg-paper px-3 py-2',
  formHeadRow:          'flex items-baseline justify-between',
  eyebrowFaint:         'text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint',
  divider:              'divide-y divide-line',
  chipRow:              'flex flex-wrap gap-2',
  // Small, muted meta row beneath a card title (e.g. "Posted 3d ago · Greenhouse").
  // Tight vertical gap for wrapped lines; xs+faint palette matches CLS.helpText.
  metaChipRow:          'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-faint',
  chipRowStable:        'flex flex-wrap items-start content-start gap-2',
  chipRowInline:        'flex flex-wrap items-center gap-2',
  pageHeadRow:          'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
  cardHeadRow:          'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between',
  panelHeadRow:         'flex items-start justify-between gap-4',
  headActions:          'flex shrink-0 items-center gap-2',
  dividerTop:           'border-t border-line pt-4',
  hairline:             'border-b border-line',
  dot:                  'inline-block h-2 w-2 rounded-full',
  dotMd:                'h-3 w-3 rounded-full',
  sectionHead:          'flex items-end justify-between border-b border-line pb-2',
  placeholder:          'italic text-ink-faint',
  grid2x2:              'grid grid-cols-1 gap-5 sm:grid-cols-2 sm:items-start',
  eyebrow:              'font-mono text-xs font-medium uppercase tracking-[0.14em] text-brand',
  label:                'text-sm font-medium text-ink',
  // inputBase carries only the visual styling — border, padding, focus ring.
  // Use this when you need to control width yourself (flex rows with mixed
  // sizes). CLS.input adds w-full on top for the common "one field per row"
  // case that formField() renders.
  inputBase:            'rounded-xl border border-line-strong bg-surface px-4 py-3 text-sm text-ink shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand-tint',
  input:                'w-full rounded-xl border border-line-strong bg-surface px-4 py-3 text-sm text-ink shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand-tint',
  inputCompact:         'w-16 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand-tint',
  btnPrimary:           'inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40',
  btnPrimaryCompact:    'inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondary:         'inline-flex items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-5 py-3 text-sm font-semibold text-ink-soft transition hover:border-brand hover:bg-brand-tint disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondaryCompact:  'inline-flex items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:bg-brand-tint disabled:cursor-not-allowed disabled:opacity-40',
  btnDanger:            'inline-flex items-center justify-center gap-2 rounded-full border border-status-out/30 bg-surface px-4 py-2 text-sm font-semibold text-status-out transition hover:border-status-out/50 hover:bg-status-out-bg',
  btnDangerCompact:     'inline-flex items-center justify-center gap-2 rounded-full bg-status-out px-4 py-2 text-sm font-semibold text-white transition hover:bg-status-out-deep disabled:cursor-not-allowed disabled:opacity-40',
  btnIcon:              'inline-flex items-center justify-center rounded-full border border-line-strong bg-surface p-2 text-ink-soft transition hover:border-brand hover:bg-brand-tint',
  btnDangerIcon:        'inline-flex items-center justify-center rounded-full border border-status-out/30 bg-surface p-2 text-status-out transition hover:border-status-out/50 hover:bg-status-out-bg',
  btnSuccessIcon:       'inline-flex items-center justify-center rounded-full border border-status-win/30 bg-surface p-2 text-status-win transition hover:border-status-win/50 hover:bg-status-win-bg',
  btnIconPrimary:       'inline-flex items-center justify-center rounded-full bg-brand p-3 text-white transition hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40',
  linkMuted:            'text-sm text-ink-faint transition hover:text-ink',
  slideOverPanel:       'fixed inset-y-0 right-0 z-50 flex w-full max-w-[960px] flex-col overflow-y-auto border-l border-line bg-surface shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none md:w-[70vw]',
  slideOverBody:        'space-y-6 p-6',
  // Choice card in a radio-card row (Remote / Hybrid / Onsite). Active and
  // inactive share layout; only the border/background/text palette differs.
  choiceCardBase:       'flex flex-col items-start gap-1 rounded-2xl border px-4 py-3 text-left text-sm transition',
  choiceCardActive:     'border-brand bg-brand-tint text-brand',
  choiceCardInactive:   'border-line bg-surface text-ink-soft hover:border-brand',
  choiceCardTitle:      'font-semibold',
  choiceCardHelp:       'text-xs text-ink-faint',
  choiceCardRow:        'grid grid-cols-1 gap-2 sm:grid-cols-3',
  // Three-phase progress bar for the profile wizard. Bar hosts the three
  // phase segments; each segment shows fill via an inner span.
  wizardPhaseBar:       'flex items-center gap-1',
  wizardPhaseSegment:   'relative h-1.5 flex-1 overflow-hidden rounded-full bg-line',
  wizardPhaseFill:      'absolute inset-y-0 left-0 bg-brand',
  wizardPhaseLabel:     'font-mono text-xs font-medium uppercase tracking-[0.14em] text-brand',
  // Profile-ready screen — the "you're done" card shown after the wizard
  // finishes. Centered layout, generous vertical breathing room.
  readyCard:            'max-w-2xl mx-auto text-center flex flex-col items-center gap-4 py-10',
  readyIconCircle:      'inline-flex h-14 w-14 items-center justify-center rounded-full bg-status-win-bg text-status-win',
  readyTitle:           'font-display text-3xl font-semibold text-ink',
  readyBody:            'text-sm text-ink-soft max-w-md',
};

// Alias for readability; textareas and selects share the input class.
CLS.textarea = CLS.input;
CLS.select = CLS.input;
