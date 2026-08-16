import { describe, it, expect, vi } from 'vitest';

// Mock the fetch used by ats-lookup.mjs's loadProviders. Return the same
// canonical JSON shipped at web/static/data/ats-providers.json.
vi.mock('./host.mjs', () => ({ STATIC_ROOT: '/static/' }));

globalThis.fetch = vi.fn((url) => {
  if (!String(url).endsWith('ats-providers.json')) {
    throw new Error(`unexpected fetch: ${url}`);
  }
  const data = [
    { provider: 'greenhouse', search_hosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'], host_pattern: '^(job-)?boards\\.greenhouse\\.io$|\\.greenhouse\\.io$', slug_in_path: true },
    { provider: 'lever', search_hosts: ['jobs.lever.co'], host_pattern: '^jobs\\.lever\\.co$', slug_in_path: true },
    { provider: 'ashby', search_hosts: ['jobs.ashbyhq.com'], host_pattern: '\\.ashbyhq\\.com$|^jobs\\.ashbyhq\\.com$', slug_in_path: true },
    { provider: 'workday', search_hosts: [], host_pattern: '\\.myworkdayjobs\\.com$', slug_in_path: false },
    { provider: 'smartrecruiters', search_hosts: ['jobs.smartrecruiters.com'], host_pattern: '^jobs\\.smartrecruiters\\.com$', slug_in_path: true },
    { provider: 'internal', search_hosts: [], host_pattern: '^careers\\.', slug_in_path: false },
  ];
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
});

const { inferATSFromPostingURL } = await import('./ats-lookup.mjs');

describe('inferATSFromPostingURL', () => {
  it('greenhouse (boards.greenhouse.io) keeps the tenant slug in path', async () => {
    expect(await inferATSFromPostingURL('https://boards.greenhouse.io/acme/jobs/12345')).toEqual({
      atsURL: 'https://boards.greenhouse.io/acme',
      provider: 'greenhouse',
    });
  });

  it('greenhouse (job-boards.greenhouse.io) keeps the tenant slug in path', async () => {
    expect(await inferATSFromPostingURL('https://job-boards.greenhouse.io/acme/jobs/12345')).toEqual({
      atsURL: 'https://job-boards.greenhouse.io/acme',
      provider: 'greenhouse',
    });
  });

  it('greenhouse tenant-subdomain uses origin only, no path', async () => {
    expect(await inferATSFromPostingURL('https://acme.greenhouse.io/jobs/12345')).toEqual({
      atsURL: 'https://acme.greenhouse.io',
      provider: 'greenhouse',
    });
  });

  it('lever keeps the tenant slug in path', async () => {
    expect(await inferATSFromPostingURL('https://jobs.lever.co/globex/uuid-uuid-uuid')).toEqual({
      atsURL: 'https://jobs.lever.co/globex',
      provider: 'lever',
    });
  });

  it('ashby (jobs.ashbyhq.com) keeps the tenant slug in path', async () => {
    expect(await inferATSFromPostingURL('https://jobs.ashbyhq.com/acme/uuid')).toEqual({
      atsURL: 'https://jobs.ashbyhq.com/acme',
      provider: 'ashby',
    });
  });

  it('ashby tenant-subdomain uses origin only', async () => {
    expect(await inferATSFromPostingURL('https://acme.ashbyhq.com/xyz')).toEqual({
      atsURL: 'https://acme.ashbyhq.com',
      provider: 'ashby',
    });
  });

  it('workday uses origin only (path pattern varies)', async () => {
    expect(await inferATSFromPostingURL('https://acme.wd5.myworkdayjobs.com/careers/job/x/y')).toEqual({
      atsURL: 'https://acme.wd5.myworkdayjobs.com',
      provider: 'workday',
    });
  });

  it('smartrecruiters keeps the tenant slug in path', async () => {
    expect(await inferATSFromPostingURL('https://jobs.smartrecruiters.com/CoolCo/12345-title')).toEqual({
      atsURL: 'https://jobs.smartrecruiters.com/CoolCo',
      provider: 'smartrecruiters',
    });
  });

  it('internal (careers.*) uses origin only', async () => {
    expect(await inferATSFromPostingURL('https://careers.acme.com/jobs/foo')).toEqual({
      atsURL: 'https://careers.acme.com',
      provider: 'internal',
    });
  });

  it('unknown host returns empty', async () => {
    expect(await inferATSFromPostingURL('https://random.example.com/jobs/1')).toEqual({
      atsURL: '',
      provider: '',
    });
  });

  it('non-URL input returns empty', async () => {
    expect(await inferATSFromPostingURL('not a url')).toEqual({ atsURL: '', provider: '' });
    expect(await inferATSFromPostingURL('')).toEqual({ atsURL: '', provider: '' });
    expect(await inferATSFromPostingURL(null)).toEqual({ atsURL: '', provider: '' });
  });
});
