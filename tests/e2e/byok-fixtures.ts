// Shared BYOK helpers for e2e specs: seed a fake config in IDB so
// isByokLLMActive() returns true, then intercept outbound provider calls
// so no real LLM runs.

import type { Page, Route } from '@playwright/test';

// `.test` is a reserved TLD, so a stray fetch can't reach anything real.
const BYOK_BASE_URL = 'https://byok-mock.test/v1';
const BYOK_HOST_GLOB = '**/byok-mock.test/**';

// Persists a fake BYOK config via the app's IDB layer. Call after page.goto().
export const enableBYOK = async (page: Page, overrides: Partial<{ baseUrl: string; apiKey: string; model: string }> = {}) => {
  const config = { baseUrl: BYOK_BASE_URL, apiKey: 'sk-test', model: 'stub', ...overrides };
  await page.evaluate(async (cfg) => {
    const m = await import('/static/js/storage/byok-llm.mjs');
    await m.saveByokLLMConfig({ enabled: true, ...cfg });
  }, config);
};

export interface BYOKCall {
  messages: any[];
  tools?: any[];
  toolChoice?: any;
}

// Captures every /chat/completions POST and answers via the caller's
// responder. Responses are wrapped in the OpenAI-compat choices envelope.
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

// Returns queued replies in order; last reply is repeated after exhaustion.
export const scriptedBYOKResponder = (
  responses: Array<{ content?: string; toolCalls?: any[] }>,
) => (_call: BYOKCall, index: number) => responses[index] ?? responses[responses.length - 1];
