// Minimal positional formatter for the two verbs the prompt templates use:
//   %s → literal string (or "" for null/undefined)
//   %q → Go-quoted string (double-quoted with escapes, like strconv.Quote)
// %% is treated as a literal '%'. No width/precision, no other verbs — the
// prompt JSON is authored to this contract and any drift would silently
// mis-align arguments, so we prefer to fail loudly on unknown verbs.

// quoteGo produces output byte-close to Go's strconv.Quote for typical
// (mostly-ASCII) input:
//   - backslash → \\
//   - double quote → \"
//   - newline → \n, tab → \t, carriage return → \r
//   - other C0 controls → \x00-style hex
//   - everything else (printable ASCII + non-ASCII) passes through verbatim
// Divergence versus Go for non-ASCII code points is intentional: Go's
// strconv.Quote leaves them in-place too, and JSON.stringify would escape
// some of them.
export const quoteGo = (s) => {
  const raw = s ?? '';
  let out = '"';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  out += '"';
  return out;
};

// sprintf substitutes %s and %q positionally with args. Throws on unknown
// verbs, on a lone trailing '%', and on any arg-count mismatch between the
// template and args (either direction) — silent misalignment would let a
// template edit corrupt the LLM input without any test surface catching it.
export const sprintf = (template, ...args) => {
  let out = '';
  let i = 0;
  let a = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '%') { out += ch; i++; continue; }
    const next = template[i + 1];
    if (next === undefined) throw new Error(`sprintf: lone '%' at end of template`);
    if (next === '%') { out += '%'; i += 2; continue; }
    if (next === 's' || next === 'q') {
      if (a >= args.length) {
        throw new Error(`sprintf: template expects at least ${a + 1} args, got ${args.length}`);
      }
      const arg = args[a];
      const s = arg === null || arg === undefined ? '' : String(arg);
      out += next === 's' ? s : quoteGo(s);
      a++; i += 2; continue;
    }
    throw new Error(`sprintf: unsupported verb %${next} at ${i}`);
  }
  if (a < args.length) {
    throw new Error(`sprintf: template uses ${a} args, got ${args.length}`);
  }
  return out;
};
