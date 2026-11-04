import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, findFlags, compsEstimate, isCandidate, similarComps, modelNumber } from '../src/evaluate.js';
import { titleWords } from '../src/deals.js';

// Recent asking prices for a PS5 search: consoles around $400, controllers around $50.
const pool = [];
const add = (title, price) => pool.push({ id: `c${pool.length}`, title, price });
for (const p of [400, 420, 380, 410, 395, 405, 390, 415, 400]) add('PS5 disc edition console', p);
for (const p of [45, 50, 55, 48, 52]) add('PS5 DualSense controller white', p);
const watch = { query: 'ps5', include: [], sellOn: 'local' };
const L = (title, price, extra = {}) => ({ id: `x${Math.random()}`, title, price, priceText: `$${price}`, ...extra });
const ev = (title, price, opts = {}) => evaluate(L(title, price), { watch, pool, ...opts });

test('a console well under market is a deal, with the math spelled out', () => {
  const e = ev('PS5 Disc Edition, works great', 220);
  assert.equal(e.verdict, 'deal');
  assert.equal(e.confidence, 'high');
  assert.equal(e.resale.value, 360); // median ask $400 x 90%
  assert.equal(e.profit, 130); // 360 - 220 - 10
  assert.ok(e.reasons.some((r) => r.kind === 'good' && r.text.includes('= +$130')));
  assert.ok(isCandidate(e));
});

test('a fair price is not a deal and says why', () => {
  const e = ev('PS5 disc console', 340);
  assert.equal(e.verdict, 'unsorted');
  assert.match(e.headline, /Only \+\$10 profit/);
});

test('condition problems, box-only, wanted posts and replicas never count as deals', () => {
  assert.equal(ev('PS5 disc edition - for parts, doesn’t turn on', 120).verdict, 'unsorted');
  assert.match(ev('PS5 disc edition box only', 30).headline, /Accessory or box only/);
  assert.match(ev('ISO PS5 disc edition', 200).headline, /wanted/);
  assert.match(ev('PS5 disc edition replica', 150).headline, /replica/i);
  // ...but "not broken" is fine
  assert.equal(ev('PS5 disc edition, not broken, no scratches', 220).verdict, 'deal');
});

test('problems hidden in the description are caught once the full listing is read', () => {
  const quick = ev('PS5 disc edition', 200);
  assert.equal(quick.verdict, 'deal');
  const full = ev('PS5 disc edition', 200, { details: { description: 'Turns on but then the screen goes black.\nWater damaged, selling as is.', condition: 'Used - fair' } });
  assert.equal(full.verdict, 'unsorted');
  assert.ok(full.flags.some((f) => f.code === 'parts'));
  assert.ok(full.flags.some((f) => f.code === 'condition'));
});

test('far too cheap is flagged as a likely scam', () => {
  const scam = ev('PS5 disc edition brand new', 30);
  assert.equal(scam.verdict, 'unsorted');
  assert.match(scam.headline, /Likely scam/);
  const withTalk = ev('PS5 disc edition', 90, { details: { description: 'Zelle only, shipping only.' } });
  assert.match(withTalk.headline, /Likely scam/);
  const verify = ev('PS5 disc edition', 80); // 78% under: allowed, but with a warning
  assert.equal(verify.verdict, 'deal');
  assert.ok(verify.flags.some((f) => f.code === 'toocheap'));
  // Payment apps alone are normal with honest sellers...
  assert.equal(ev('PS5 disc edition', 220, { details: { description: 'Cash or Zelle at pickup.' } }).verdict, 'deal');
  // ...but money up front on a deal-level price is the classic scam.
  assert.match(ev('PS5 disc edition', 220, { details: { description: 'Deposit required to hold it.' } }).headline, /Likely scam/);
});

test('free items can be deals', () => {
  const e = ev('Free PS5 disc edition, moving', 0);
  assert.equal(e.verdict, 'deal');
  assert.equal(e.profit, 350);
});

test('accessories are compared with accessories, not consoles', () => {
  const e = ev('PS5 controller', 40);
  assert.equal(e.resale.value, 45); // 50 x 90%
  assert.equal(e.verdict, 'unsorted'); // -$5 profit
});

test('not enough look-alikes means unsorted with a hint, never a guess', () => {
  const e = ev('PS5 VR2 headset', 150);
  assert.equal(e.verdict, 'unsorted');
  assert.equal(e.resale, null);
  assert.match(e.reasons.map((r) => r.text).join(' '), /resells for|AI second opinion/);
});

test('your own resale price wins, unless look-alikes show it is a different item', () => {
  const w = { ...watch, resaleValue: 380 };
  const console = evaluate(L('PS5 VR2 headset', 200), { watch: w, pool });
  assert.equal(console.verdict, 'deal');
  assert.equal(console.resale.value, 380);
  const accessory = evaluate(L('PS5 DualSense controller', 30), { watch: w, pool });
  assert.equal(accessory.resale.value, 45);
  assert.equal(accessory.verdict, 'unsorted');
  assert.ok(accessory.reasons.some((r) => /probably an accessory/.test(r.text)));
  // No look-alikes yet and far under your number: don't call it a deal (or a scam), ask to check.
  const unknown = evaluate(L('PS5 charging dock', 55), { watch: w, pool });
  assert.equal(unknown.verdict, 'unsorted');
  assert.equal(unknown.headline, 'Far under your resale price: check it is the same item');
  assert.ok(!unknown.flags.some((f) => f.code === 'scam'));
  // ...but a real console steal that look-alikes confirm still counts.
  assert.equal(evaluate(L('PS5 disc edition', 120), { watch: w, pool }).verdict, 'deal');
});

test('eBay fees and shipping come out of the profit', () => {
  const local = ev('PS5 disc edition', 250);
  const ebay = evaluate(L('PS5 disc edition', 250), { watch: { ...watch, sellOn: 'ebay', shipCost: 25 }, pool });
  assert.equal(local.verdict, 'deal'); // 360 - 250 - 10 = +100 (28%)
  assert.equal(ebay.verdict, 'unsorted'); // 360 - 250 - 49.36 fees - 25 ship - 10 = +26
  assert.equal(ebay.profit, 26);
  assert.equal(Math.round(ebay.fees), 74);
});

test('your rules decide: both the profit and the margin bar must be cleared', () => {
  assert.equal(ev('PS5 disc edition', 250).verdict, 'deal');
  assert.equal(ev('PS5 disc edition', 250, { rules: { minProfit: 120 } }).verdict, 'unsorted');
  const thin = ev('PS5 disc edition', 270); // +$80 is plenty, but only 22% margin
  assert.equal(thin.verdict, 'unsorted');
  assert.equal(ev('PS5 disc edition', 270, { rules: { minMarginPct: 20 } }).verdict, 'deal');
});

test('AI agreement raises confidence; disagreement lowers it and uses the lower price', () => {
  const few = pool.filter((c) => c.title.includes('disc')).slice(0, 4); // medium confidence alone
  const rules = { priceGuide: false }; // similar listings only, so the AI is the second source
  const base = evaluate(L('PS5 disc edition', 220), { watch, pool: few, rules });
  assert.equal(base.confidence, 'medium');
  const ai = (low, high, extra = {}) => ({ ok: true, item: 'PS5 Disc', condition: 'good', low, high, confidence: 'high', redFlags: [], verdict: 'good deal', reason: 'Popular console.', model: 'test', ...extra });
  assert.equal(evaluate(L('PS5 disc edition', 220), { watch, pool: few, rules, ai: ai(340, 380) }).confidence, 'high');
  const dis = evaluate(L('PS5 disc edition', 220), { watch, pool: few, rules, ai: ai(200, 240) });
  assert.equal(dis.confidence, 'low');
  assert.equal(dis.resale.value, 220);
  assert.equal(dis.verdict, 'unsorted');
  // AI alone is capped at medium confidence
  const alone = evaluate(L('PS5 VR2 headset', 150), { watch, pool, ai: ai(300, 340) });
  assert.equal(alone.confidence, 'medium');
  assert.equal(alone.verdict, 'deal');
  // AI says it's for parts: never a deal
  assert.equal(evaluate(L('PS5 VR2 headset', 150), { watch, pool, ai: ai(300, 340, { condition: 'for parts' }) }).verdict, 'unsorted');
});

test('red flags respect negation, sentence breaks and title-only rules', () => {
  const codes = (title, desc = '', words = []) => findFlags(title, desc, words).map((f) => f.code);
  assert.deepEqual(codes('Dresser', 'No scratches or dents, nothing missing.'), []);
  assert.deepEqual(codes('Dresser', 'No box. Broken drawer.'), ['parts']);
  assert.deepEqual(codes('Couch', 'Looking for a new home. Each cushion is clean.'), []);
  assert.deepEqual(codes('Glove, broken in'), []);
  assert.deepEqual(codes('Off-lease ThinkPad'), []);
  assert.deepEqual(codes('PS5 controller only', '', ['ps5 controller']), []);
  assert.deepEqual(codes('Air Jordan 1 1:1'), ['fake']);
  assert.deepEqual(codes('iPhone 14', 'iCloud locked, sold as is'), ['locked', 'wear']);
});

test('comparison helper: needs real look-alikes, trims outliers, reports confidence', () => {
  const c = compsEstimate(L('PS5 disc edition', 300), pool, { searchWords: ['ps5'] });
  assert.equal(c.kind, 'similar');
  assert.equal(c.confidence, 'high');
  assert.equal(Math.round(c.askMedian), 400);
  assert.equal(compsEstimate(L('PS5 VR2 headset', 300), pool, { searchWords: ['ps5'] }).value, null);
  assert.deepEqual([...titleWords('PS5 Disc Edition + 2 controllers, great condition')], ['ps5', 'disc', 'edition', 'controller']);
});

test('look-alikes must be the same model, not just similar words', () => {
  const phones = [
    ...[200, 210, 220, 205].map((p, i) => ({ id: `m${i}`, title: 'iPhone 13 mini 128GB', price: p })),
    ...[300, 310, 320, 305].map((p, i) => ({ id: `f${i}`, title: 'iPhone 14 128GB unlocked', price: p })),
  ];
  const same = similarComps(L('iPhone 14 128GB, battery 91%', 200), phones, ['iphone']);
  assert.deepEqual(same.map((o) => o.id).sort(), ['f0', 'f1', 'f2', 'f3']);
  const bikes = [
    ...[300, 320, 310].map((p, i) => ({ id: `a${i}`, title: 'Trek FX 3 hybrid bike', price: p })),
    ...[500, 520, 510].map((p, i) => ({ id: `b${i}`, title: 'Trek FX 2 hybrid bike', price: p })),
  ];
  assert.deepEqual(similarComps(L('Trek FX 2 hybrid bike', 200), bikes, ['bike']).map((o) => o.id).sort(), ['b0', 'b1', 'b2']);
  assert.deepEqual(modelNumber('PS5 disc edition + 2 controllers'), null); // a count, not a model
});
