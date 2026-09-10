import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock every module tailorResume touches before importing the service.
// Per-test the BYOK toggle + LLM callable behavior are overridden via the
// exported vi.fns so one file can cover both dispatch branches.
vi.mock('../../storage/byok-llm.mjs', () => ({
  isByokLLMActive: vi.fn(async () => false),
  getByokLLMConfig: vi.fn(async () => null),
}));
vi.mock('../../sources/llm/client.mjs', () => ({
  callOpenAICompatible: vi.fn(),
  getServerLLMStatus: vi.fn(async () => ({ available: true, provider: 'openai', model: 'gpt-4o' })),
}));
vi.mock('../../entities/profile.mjs', () => ({
  BRAG_CATEGORIES: ['experience', 'project', 'activity'],
  searchBrags: vi.fn(async () => [{ id: 1, title: 'Cut latency 40%', body: 'checkout flow',
                                    impact: '', tags: [], company_name: '', entry_year: 2024, category: 'experience' }]),
  searchResumes: vi.fn(async () => []),
}));

// Prompt handlers are mocked so tests don't need to fetch real prompt JSON.
// build() returns a trivial { system, user, tools? } prompt; parse() echoes
// enough shape for the caller. Tools list is scripted with the two names
// runBYOKToolLoop dispatches on.
vi.mock('../../prompt-handlers/applications/tailor-with-tools.mjs', () => ({
  build: vi.fn(async () => ({
    system: 'sys', user: 'user',
    tools: [
      { type: 'function', function: { name: 'search_brags', description: '', parameters: {} } },
      { type: 'function', function: { name: 'search_resumes', description: '', parameters: {} } },
    ],
  })),
  parse: vi.fn((raw) => JSON.parse(raw)),
}));
vi.mock('../../prompt-handlers/applications/tailor-rank-brags.mjs', () => ({
  build: vi.fn(async () => ({ system: 'rank-sys', user: 'rank-user' })),
  parse: vi.fn(() => ({ ranked: [] })),
}));
vi.mock('../../prompt-handlers/applications/tailor-draft-resume.mjs', () => ({
  build: vi.fn(async () => ({ system: 'draft-sys', user: 'draft-user' })),
  parse: vi.fn((raw) => JSON.parse(raw)),
}));

import { tailorResume } from './service.mjs';
import { isByokLLMActive, getByokLLMConfig } from '../../storage/byok-llm.mjs';
import { callOpenAICompatible } from '../../sources/llm/client.mjs';

const draftInput = () => ({
  jd_structured: { role_title: 'Engineer' },
  profile: { headline: 'X' },
  base_resume_structured: {
    contact: { name: 'Alex' },
    experience: [{ company: 'Acme', bullets: [{ description: 'Shipped X' }] }],
  },
  role_signals: '### Desirable skills\n- Go',
  profile_fit: 'Strong Go background.',
  brags: [],
});

const finalResult = {
  resume: {
    contact: { name: 'Alex' },
    experience: [{ company: 'Acme', bullets: [{ description: 'Cut latency 40% on checkout flow.' }] }],
  },
  changes: [],
};

const okJSON = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
afterEach(() => { fetchSpy.mockRestore(); vi.clearAllMocks(); });

describe('tailorOnServer', () => {
  it('drives a tool_calls turn then returns the parsed result', async () => {
    fetchSpy
      .mockResolvedValueOnce(okJSON({
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'search_brags', arguments: '{"query":"latency","category":"experience"}' },
        }],
      }))
      .mockResolvedValueOnce(okJSON({ result: finalResult }));

    const out = await tailorResume(draftInput(), { locale: 'en' });

    expect(out).toEqual(finalResult);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First call: no exchanges. Second call: one exchange containing the tool result.
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(secondBody.exchanges).toHaveLength(1);
    expect(secondBody.exchanges[0].tool_calls[0].function.name).toBe('search_brags');
    expect(secondBody.exchanges[0].tool_results[0].id).toBe('call_1');
    expect(secondBody.exchanges[0].tool_results[0].result_json.results[0].title).toBe('Cut latency 40%');
  });

  it('short-circuits on immediate final result (no tool calls)', async () => {
    fetchSpy.mockResolvedValueOnce(okJSON({ result: finalResult }));
    const out = await tailorResume(draftInput(), { locale: 'en' });
    expect(out).toEqual(finalResult);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to bundled endpoint when server rejects tools', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('tools is not supported by this provider', { status: 400 }))
      .mockResolvedValueOnce(okJSON(finalResult));
    const out = await tailorResume(draftInput(), { locale: 'en' });
    expect(out).toEqual(finalResult);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/applications/tailor/turn');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/applications/tailor');
  });
});

describe('tailorInBrowser (BYOK)', () => {
  const enableBYOK = () => {
    isByokLLMActive.mockResolvedValue(true);
    getByokLLMConfig.mockResolvedValue({
      enabled: true, baseUrl: 'https://api.example', apiKey: 'sk-x', model: 'gpt-4o',
    });
  };

  it('drives a tool_calls turn then returns the parsed result', async () => {
    enableBYOK();
    const draftJSON = JSON.stringify(finalResult);
    callOpenAICompatible
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'call_1', name: 'search_brags', arguments: '{"query":"latency","category":"experience"}' }],
      })
      .mockResolvedValueOnce({ content: draftJSON, toolCalls: [] });

    const out = await tailorResume(draftInput(), { locale: 'en' });

    expect(out).toEqual(finalResult);
    expect(callOpenAICompatible).toHaveBeenCalledTimes(2);
    // Second call carries the growing message history: system + user + assistant(tool_calls) + tool(result).
    const secondCallPayload = callOpenAICompatible.mock.calls[1][0];
    expect(secondCallPayload.messages).toHaveLength(4);
    expect(secondCallPayload.messages[2].role).toBe('assistant');
    expect(secondCallPayload.messages[2].tool_calls[0].function.name).toBe('search_brags');
    expect(secondCallPayload.messages[3].role).toBe('tool');
    expect(secondCallPayload.messages[3].tool_call_id).toBe('call_1');
    // Server endpoint should NOT be touched on the BYOK path.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('short-circuits on immediate final content (no tool calls)', async () => {
    enableBYOK();
    callOpenAICompatible.mockResolvedValueOnce({
      content: JSON.stringify(finalResult), toolCalls: [],
    });
    const out = await tailorResume(draftInput(), { locale: 'en' });
    expect(out).toEqual(finalResult);
    expect(callOpenAICompatible).toHaveBeenCalledTimes(1);
  });

  it('falls back to rank+draft when the provider rejects tools', async () => {
    enableBYOK();
    // First call (tool-loop attempt) throws tools_unsupported; then two calls
    // for rank + draft succeed.
    const err = Object.assign(new Error('provider does not support tools'), { code: 'tools_unsupported' });
    callOpenAICompatible
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ content: JSON.stringify(finalResult), toolCalls: [] });

    const input = { ...draftInput(), brags: [{ id: 1, title: 'X', category: 'experience' }] };
    const out = await tailorResume(input, { locale: 'en' });
    expect(out).toEqual(finalResult);
    // 1 (tool-loop attempt) + N (rank per category with brags) + 1 (draft).
    // With one brag in "experience" only, rank fires once → 3 total.
    expect(callOpenAICompatible.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
