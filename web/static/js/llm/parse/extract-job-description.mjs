// JS port of internal/applications/extraction.go + service.go's ExtractJD
// finalization for the BYOK-LLM path. Runs entirely client-side. The parse
// input carries the LLM raw text plus the caller-supplied enriched_raw +
// posting so overlayATSPosting can enrich the finalized structured JD.

import { decodeJSONResponse } from '../decode.mjs';
import { sanitizeText } from '../safety.mjs';
import { buildFormatted } from '../prompts.mjs';

// coerceFlexString accepts string / bool / number, mirroring Go's flexString
// UnmarshalJSON. Boolean true collapses to the "required (details unclear
// from posting)" sentinel; false → empty.
const coerceFlexString = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'required (details unclear from posting)' : '';
  if (typeof v === 'number') return String(v);
  return '';
};

// coerceStringList accepts a string or an array of strings. Empty inputs
// resolve to []. Mirrors Go's stringList UnmarshalJSON.
const coerceStringList = (v) => {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
};

const normalizeRoleLevel = (v) => {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'intern' || s === 'internship') return 'intern';
  if (['new_grad', 'new-grad', 'new grad', 'graduate', 'graduating', 'fresh graduate', 'fresh-grad', 'recent graduate', 'entry_level', 'entry-level', 'entry level'].includes(s)) return 'new_grad';
  if (s === 'junior') return 'junior';
  if (['mid', 'mid_level', 'mid-level', 'mid level'].includes(s)) return 'mid';
  if (s === 'senior') return 'senior';
  if (s === 'staff') return 'staff';
  if (s === 'principal') return 'principal';
  return '';
};

const normalizeEmploymentType = (v) => {
  const s = (v ?? '').trim().toLowerCase();
  if (['full_time', 'full-time', 'full time'].includes(s)) return 'full_time';
  if (['part_time', 'part-time', 'part time'].includes(s)) return 'part_time';
  if (s === 'contract' || s === 'contractor') return 'contract';
  return '';
};

const normalizeSeason = (v) => {
  const s = (v ?? '').trim().toLowerCase();
  return ['spring', 'summer', 'fall', 'winter'].includes(s) ? s : '';
};

// inferRoleLevel walks a combined lower-cased text corpus for heuristic
// matches. Kept in Go-order so the first match wins.
const inferRoleLevel = (...parts) => {
  const combined = parts.join(' ').toLowerCase();
  if (combined.includes('internship') || combined.includes(' intern ') || combined.startsWith('intern ') || combined.endsWith(' intern')) return 'intern';
  if (combined.includes('new grad') || combined.includes('new-grad') || combined.includes('new_grad') || combined.includes('fresh graduate') || combined.includes('fresh-grad') || combined.includes('recent graduate') || combined.includes('entry level') || combined.includes('entry-level') || combined.includes('graduate')) return 'new_grad';
  if (combined.includes('junior')) return 'junior';
  if (combined.includes('mid level') || combined.includes('mid-level') || combined.includes('mid_level')) return 'mid';
  if (combined.includes('senior')) return 'senior';
  if (combined.includes('staff')) return 'staff';
  if (combined.includes('principal')) return 'principal';
  return '';
};

const inferEmploymentType = (...parts) => {
  const combined = parts.join(' ').toLowerCase();
  if (combined.includes('full-time') || combined.includes('full time') || combined.includes('full_time')) return 'full_time';
  if (combined.includes('part-time') || combined.includes('part time') || combined.includes('part_time')) return 'part_time';
  if (combined.includes('contractor') || combined.includes('contract')) return 'contract';
  return '';
};

// sanitizeStringList trims, case-insensitive dedupes (first-seen casing wins),
// drops empty, then sorts alphabetically by lowercased key — matching Go's
// sanitizeStringList exactly.
const sanitizeStringList = (values) => {
  const seen = new Map();
  for (const raw of values ?? []) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  const keys = [...seen.keys()].sort();
  return keys.map((k) => seen.get(k));
};

const normalizeEducationLabel = (value) => {
  const v = (value ?? '').trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (lower.includes('phd') || lower.includes('ph.d') || lower.includes('doctorate') || lower.includes('doctoral')) return 'PhD';
  if (lower.includes('mba')) return 'MBA';
  if (lower.includes('juris doctor') || lower.includes('j.d') || lower.includes('jd degree') || lower === 'jd') return 'JD';
  if (lower.includes('master') || lower.includes('m.s') || lower.includes('ms degree') || lower.includes('m.sc') || lower.includes('m.a')) return "Master's degree";
  if (lower.includes('bachelor') || lower.includes('b.s') || lower.includes('bs degree') || lower.includes('b.a')) return "Bachelor's degree";
  if (lower.includes('associate')) return 'Associate degree';
  if (lower.includes('high school') || lower.includes('secondary school')) return 'High school diploma';
  return '';
};

const sanitizeEducationList = (values) => {
  const cleaned = sanitizeStringList(values);
  if (cleaned.length === 0) return [];
  const seen = new Set();
  const result = [];
  for (const v of cleaned) {
    let canonical = normalizeEducationLabel(v);
    if (!canonical) canonical = v;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  // Stable sort by lowercased canonical form — matches Go's sort.SliceStable.
  result.sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });
  return result;
};

const isCurrencyCode = (token) => !!token && /^[A-Za-z]+$/.test(token);

// splitCompensation parses "USD 98,000-131,000/year" → {currency, amount}.
const splitCompensation = (raw) => {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { currency: '', amount: '' };
  const idx = trimmed.indexOf(' ');
  if (idx > 0) {
    const head = trimmed.slice(0, idx);
    const rest = trimmed.slice(idx + 1).trim();
    if (isCurrencyCode(head)) return { currency: head.toUpperCase(), amount: rest };
  }
  return { currency: '', amount: trimmed };
};

// sanitizeJobDescriptionStructured mirrors the Go function of the same name.
// ctx is { companyName, roleTitle, jobDescriptionRaw } — same fields as
// extractionContext.
const sanitizeJobDescriptionStructured = (result, ctx) => {
  const salary = result.salary ?? {};
  const requirements = result.requirements ?? {};

  const out = {
    schema_version:  'job_description.v1',
    company_name:    (result.company_name ?? '').trim() || (ctx.companyName ?? '').trim(),
    role_title:      (result.role_title ?? '').trim()   || (ctx.roleTitle ?? '').trim(),
    role_level:      normalizeRoleLevel(result.role_level),
    employment_type: normalizeEmploymentType(result.employment_type),
    season:          normalizeSeason(result.season),
    year:            typeof result.year === 'number' && result.year >= 0 ? result.year : 0,
    locations:       sanitizeStringList(coerceStringList(result.locations)),
    location_notes:  (result.location_notes ?? '').trim(),
    salary: {
      currency: (salary.currency ?? '').trim().toUpperCase(),
      amount:   (salary.amount ?? '').trim(),
    },
    application_deadline:     (result.application_deadline ?? '').trim(),
    minimum_qualifications:   sanitizeStringList(coerceStringList(result.minimum_qualifications)),
    preferred_qualifications: sanitizeStringList(coerceStringList(result.preferred_qualifications)),
    responsibilities:         sanitizeStringList(coerceStringList(result.responsibilities)),
    languages:                sanitizeStringList(coerceStringList(result.languages)),
    skills:                   sanitizeStringList(coerceStringList(result.skills)),
    domains:                  sanitizeStringList(coerceStringList(result.domains)),
    requirements: {
      transcript_required: !!requirements.transcript_required,
      work_authorization:  coerceFlexString(requirements.work_authorization).trim(),
      education:           sanitizeEducationList(coerceStringList(requirements.education)),
      majors:              sanitizeStringList(coerceStringList(requirements.majors)),
      availability:        sanitizeStringList(coerceStringList(requirements.availability)),
    },
    summary:   sanitizeText(result.summary),
    reasoning: sanitizeText(result.reasoning),
  };

  if (!out.role_level) {
    out.role_level = inferRoleLevel(
      ctx.roleTitle ?? '',
      ctx.jobDescriptionRaw ?? '',
      out.role_title,
      out.summary,
      out.location_notes,
      out.application_deadline,
      (out.minimum_qualifications ?? []).join(' '),
      (out.preferred_qualifications ?? []).join(' '),
      (out.responsibilities ?? []).join(' '),
    );
  }
  if (!out.employment_type) {
    out.employment_type = inferEmploymentType(
      ctx.roleTitle ?? '',
      ctx.jobDescriptionRaw ?? '',
      out.role_title,
      out.summary,
      out.location_notes,
      out.application_deadline,
      (out.minimum_qualifications ?? []).join(' '),
      (out.preferred_qualifications ?? []).join(' '),
      (out.responsibilities ?? []).join(' '),
    );
  }
  return out;
};

// overlayATSPosting lets structured ATS provider facts win over LLM
// inference. Empty ATS fields don't overwrite non-empty LLM output.
const overlayATSPosting = (structured, posting = {}) => {
  const title = (posting.title ?? '').trim();
  if (title) structured.role_title = title;
  const company = (posting.company ?? '').trim();
  if (company) structured.company_name = company;
  const location = (posting.location ?? '').trim();
  if (location && (structured.locations ?? []).length === 0) {
    structured.locations = [location];
  }
  const comp = (posting.compensation ?? '').trim();
  if (comp) {
    const { currency, amount } = splitCompensation(comp);
    if (!structured.salary.currency) structured.salary.currency = currency;
    if (!structured.salary.amount)   structured.salary.amount   = amount;
  }
  // EmploymentType from ATS only overrides when the LLM left it blank AND
  // the ATS value maps cleanly to our enum. Unmapped values (e.g. Ashby's
  // INTERN, which we track as role_level instead) leave the LLM's inference
  // intact. Mirrors Go's overlayATSPosting.
  if (!structured.employment_type) {
    const et = normalizeEmploymentType(posting.employment_type ?? posting.employmentType ?? '');
    if (et) structured.employment_type = et;
  }
  return structured;
};

// parse decodes the LLM raw response and finalizes it into the structured JD
// the caller consumes: sanitize + overlay ATS-authoritative fields.
export const parse = (raw, { input = {}, enriched_raw, posting } = {}) => {
  const decoded = decodeJSONResponse(raw);
  const structured = sanitizeJobDescriptionStructured(decoded, {
    companyName:       input.company_name,
    roleTitle:         input.role_title,
    jobDescriptionRaw: enriched_raw,
  });
  return overlayATSPosting(structured, posting);
};

// buildATSHintsBlock renders ATS-returned fields into a "known facts" block
// the LLM is told to trust verbatim. Returns "" when the ATS gave us nothing.
// Mirrors Go's buildATSHintsBlock — same header text + field order.
const buildATSHintsBlock = (posting = {}) => {
  const pairs = [
    ['Role title',     posting.title],
    ['Company',        posting.company],
    ['Location',       posting.location],
    ['Department',     posting.department],
    ['Team',           posting.team],
    ['Compensation',   posting.compensation],
    ['Employment type', posting.employment_type],
  ];
  const lines = [];
  for (const [label, value] of pairs) {
    const v = (value ?? '').trim();
    if (v) lines.push(`- ${label}: ${v}`);
  }
  if (lines.length === 0) return '';
  const provider = (posting.provider ?? '').trim();
  const header = provider && provider !== 'generic'
    ? `ATS-verified facts (source: ${provider})`
    : 'ATS-verified facts';
  return `\n${header} (use verbatim, do not infer):\n${lines.join('\n')}\n`;
};

// build assembles the JD extraction prompt client-side. Requires the caller
// to have already resolved raw text (from a paste or a browser-side scrape).
// input.posting (when supplied — e.g. from /api/applications/scrape) feeds
// the ATS-hints block so the LLM sees ATS-authoritative fields verbatim.
export const build = async (input, locale) => {
  const raw = (input?.job_description_raw ?? '').trim();
  if (!raw) throw new Error('job description is required');
  const posting = input?.posting || {};
  const prompt = await buildFormatted('extract-job-description', locale,
    input?.company_name ?? '',
    input?.role_title ?? '',
    input?.job_posting_url ?? '',
    buildATSHintsBlock(posting),
    raw,
  );
  return { ...prompt, enriched_raw: raw, posting };
};
