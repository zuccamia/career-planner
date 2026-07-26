// Shared Tailwind class strings for the local-first UI. Kept as literal
// strings so Tailwind's static scanner can see them.

export const CLS = {
  card:                 'space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm',
  eyebrow:              'text-sm font-semibold uppercase tracking-[0.14em] text-blue-700',
  label:                'text-sm font-medium text-slate-900',
  input:                'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100',
  inputCompact:         'w-16 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100',
  btnPrimary:           'inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40',
  btnPrimaryCompact:    'inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondary:         'inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondaryCompact:  'inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
  btnDanger:            'inline-flex items-center justify-center gap-2 rounded-full border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50',
  btnDangerCompact:     'inline-flex items-center justify-center gap-2 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40',
  btnIcon:              'inline-flex items-center justify-center rounded-full border border-slate-300 bg-white p-2 text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
  btnDangerIcon:        'inline-flex items-center justify-center rounded-full border border-red-200 bg-white p-2 text-red-600 transition hover:border-red-300 hover:bg-red-50',
  btnSuccessIcon:       'inline-flex items-center justify-center rounded-full border border-emerald-200 bg-white p-2 text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50',
  btnIconPrimary:       'inline-flex items-center justify-center rounded-full bg-blue-600 p-3 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40',
  linkMuted:            'text-sm text-slate-500 transition hover:text-slate-900',
};

// Alias for readability; textareas and selects share the input class.
CLS.textarea = CLS.input;
CLS.select = CLS.input;
