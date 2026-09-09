// Shared BYOK helpers for e2e specs.
//
// BYOK e2e specs cover the JS build()/parse() handlers that BYOK-inactive
// specs skip. Each helper here sets up one leg of the BYOK path: seed the
// config in IndexedDB so isByokLLMActive() returns true, then intercept
// outbound calls to the configured provider so no real LLM runs.

import type { Page, Route } from '@playwright/test';

// Fake provider host — must be a pattern page.route can catch. `.test` is a
// reserved TLD so no accidental external traffic reaches a real server.
const BYOK_BASE_URL = 'https://byok-mock.test/v1';
const BYOK_HOST_GLOB = '**/byok-mock.test/**';

// enableBYOK persists a fake BYOK config through the app's own IDB layer, so
// isByokLLMActive() reads back what we wrote. Call after page.goto().
export const enableBYOK = async (page: Page, overrides: Partial<{ baseUrl: string; apiKey: string; model: string }> = {}) => {
  const config = { baseUrl: BYOK_BASE_URL, apiKey: 'sk-test', model: 'stub', ...overrides };
  await page.evaluate(async (cfg) => {
    const m = await import('/static/js/storage/byok-llm.mjs');
    await m.saveByokLLMConfig({ enabled: true, ...cfg });
  }, config);
};

// One entry in the request log we hand back to specs.
export interface BYOKCall {
  messages: any[];
  tools?: any[];
  toolChoice?: any;
}

// interceptBYOKLLM captures every /chat/completions POST and answers with the
// caller-provided responder. Responses are wrapped in the OpenAI-compat
// { choices: [{ message: ... }] } envelope callOpenAICompatible expects.
//
// The responder receives the parsed request body plus a zero-based call index.
// Return { content?, toolCalls? } — content defaults to '' when only tool
// calls fire, toolCalls defaults to [] for a normal response.
export const interceptBYOKLLM = async (
  page: Page,
  respond: (call: BYOKCall, index: number) =>
    Promise<{ content?: string; toolCalls?: any[] }> | { content?: string; toolCalls?: any[] },
) => {
  const calls: BYOKCall[] = [];
  await page.route(BYOK_HOST_GLOB, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const call: BYOKCall = {
      messages: body.messages ?? [],
      tools: body.tools,
      toolChoice: body.tool_choice,
    };
    calls.push(call);
    const resp = await respond(call, calls.length - 1);
    const message: any = { role: 'assistant', content: resp.content ?? '' };
    if (resp.toolCalls?.length) message.tool_calls = resp.toolCalls;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message }] }),
    });
  });
  return { calls };
};

// scriptedBYOKResponder is the common shape: a fixed list of replies, returned
// in order. Useful when you just want turn 1 → tool_calls, turn 2 → final.
export const scriptedBYOKResponder = (
  responses: Array<{ content?: string; toolCalls?: any[] }>,
) => (_call: BYOKCall, index: number) => responses[index] ?? responses[responses.length - 1];
