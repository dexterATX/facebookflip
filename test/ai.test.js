// The AI second opinion, tested with a stand-in client (no network, no key, no cost).
import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AiAdvisor, buildPrompt } from '../src/ai.js';

function fakeStore(ai = {}) {
  return {
    settings: { ai: { enabled: true, apiKey: 'sk-ant-test', model: 'claude-opus-5-5', maxPerDay: 5, ...ai } },
    data: { aiUsage: null },
    save() {},
  };
}

const goodAnswer = {
  item: 'Sony PS5 Disc Edition',
  condition: 'good',
  resale_low: 330,
  resale_high: 380,
  confidence: 'high',
  red_flags: [],
  verdict: 'good deal',
  reason: 'Consoles in good shape resell quickly.',
};

function client(handler) {
  const calls = [];
  return {
    calls,
    factory: () => ({ beta: { messages: { parse: async (params) => (calls.push(params), handler(params, calls.length)) } } }),
  };
}

const listing = { id: '1', title: 'PS5 disc edition', price: 220, priceText: '$220', locationText: 'Tampa, FL', photo: 'https://scontent.xx.fbcdn.net/v/abc.jpg', creationTime: Date.now() - 5 * 60e3 };

test('asks for structured JSON, sends the photo, enables refusal fallback, and tracks spend', async () => {
  const c = client(() => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 3000, output_tokens: 500 }, parsed_output: goodAnswer }));
  const store = fakeStore();
  const ai = new AiAdvisor({ store, clientFactory: c.factory });
  const r = await ai.assess(listing, { details: { description: 'Works great', condition: 'Used - good' }, compsSummary: { n: 9, median: 400, low: 380, high: 420, examples: [{ title: 'PS5 disc', price: 400 }] } });
  assert.equal(r.ok, true);
  assert.equal(r.item, 'Sony PS5 Disc Edition');
  assert.equal(r.low, 330);
  assert.equal(r.costUsd, 0.022); // 3000 x $4/M + 500 x $20/M
  assert.deepEqual(store.data.aiUsage.checks, 1);
  const p = c.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.output_config.effort, 'medium');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.equal(p.messages[0].content[0].type, 'image');
  assert.match(p.messages[0].content[1].text, /Asking price: \$220[\s\S]*Description: Works great[\s\S]*median \$400 from 9 listings/);
});

test('Haiku gets no fallback parameter; local photos are not sent', async () => {
  const c = client(() => ({ stop_reason: 'end_turn', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 200 }, parsed_output: goodAnswer }));
  const ai = new AiAdvisor({ store: fakeStore({ model: 'claude-haiku-5-5' }), clientFactory: c.factory });
  await ai.assess({ ...listing, photo: 'http://127.0.0.1:3999/img/1.svg' });
  assert.equal(c.calls[0].fallbacks, undefined);
  assert.equal(c.calls[0].betas, undefined);
  assert.equal(c.calls[0].messages[0].content.length, 1, 'text only');
});

test('an expired photo link is retried without the photo', async () => {
  const c = client((params, n) => {
    if (n === 1) throw new Anthropic.BadRequestError(400, { error: { message: 'Could not download image' } }, 'Could not download image', new Headers());
    return { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 900, output_tokens: 300 }, parsed_output: goodAnswer };
  });
  const r = await new AiAdvisor({ store: fakeStore(), clientFactory: c.factory }).assess(listing);
  assert.equal(r.ok, true);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1].messages[0].content.length, 1);
});

test('failures never throw: bad key, refusal, incomplete answer', async () => {
  const bad = client(() => {
    throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  });
  const a = await new AiAdvisor({ store: fakeStore(), clientFactory: bad.factory }).assess(listing);
  assert.deepEqual([a.ok, a.code], [false, 'auth']);

  const refused = client(() => ({ stop_reason: 'refusal', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0 }, parsed_output: null }));
  const r = await new AiAdvisor({ store: fakeStore(), clientFactory: refused.factory }).assess(listing);
  assert.deepEqual([r.ok, r.code], [false, 'refused']);

  const cut = client(() => ({ stop_reason: 'max_tokens', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 16000 }, parsed_output: null }));
  const m = await new AiAdvisor({ store: fakeStore(), clientFactory: cut.factory }).assess(listing);
  assert.deepEqual([m.ok, m.code], [false, 'parse']);
});

test('needs a key and respects the daily cap', () => {
  const store = fakeStore({ apiKey: '', maxPerDay: 2 });
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const ai = new AiAdvisor({ store });
  assert.equal(ai.enabled(), false);
  store.settings.ai.apiKey = 'sk-ant-x';
  assert.equal(ai.enabled(), true);
  store.data.aiUsage = { day: new Date().toISOString().slice(0, 10), checks: 2, costUsd: 0.04 };
  assert.equal(ai.hasBudget(), false);
  store.data.aiUsage = { day: '2000-01-01', checks: 99, costUsd: 9 }; // yesterday's count doesn't matter
  assert.equal(ai.hasBudget(), true);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('the prompt asks for sold prices and states the selling channel', () => {
  const text = buildPrompt({ title: 'Couch', price: 0, priceText: 'Free' }, { sellOn: 'ebay' });
  assert.match(text, /Asking price: Free/);
  assert.match(text, /No comparable listings/);
  assert.match(text, /on eBay/);
});
