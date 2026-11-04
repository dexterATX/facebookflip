import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchGuide, accessoryWord, missingPart, GUIDE_AS_OF } from '../src/priceguide.js';
import { evaluate, GUIDE_STALE_DAYS } from '../src/evaluate.js';

const DATA = JSON.parse(readFileSync(new URL('../src/data/price-guide.json', import.meta.url), 'utf8'));
const id = (title) => matchGuide(title)?.id ?? null;
const L = (title, price) => ({ id: `x${Math.random()}`, title, price, priceText: `$${price}` });
const watch = { query: 'stuff', include: [], sellOn: 'local' };

test('guide data: every price has a source link, a date and sane numbers', () => {
  assert.match(DATA.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(DATA.asOf)));
  const ids = new Set();
  for (const e of DATA.items) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(DATA.sources[e.source], `${e.id}: unknown source ${e.source}`);
    assert.match(e.url, /^https:\/\/(www\.pricecharting\.com|swappa\.com)\//, `${e.id}: source link`);
    assert.ok(e.price > 20 && e.price < 3000, `${e.id}: price ${e.price}`);
    assert.ok(Array.isArray(e.all) && e.all.length && e.all.every((g) => g.length), `${e.id}: match words`);
    for (const v of e.variants || []) assert.ok(v.price > 20 && v.any.length, `${e.id}: variant ${v.size}`);
  }
  assert.ok(DATA.items.length >= 30);
});

test('guide matching: finds the exact model and size', () => {
  const cases = {
    'PS5 Slim Digital Edition': 'ps5-slim-digital',
    'PlayStation 5 Digital Edition Slim': 'ps5-slim-digital',
    'PlayStation 5 Slim console': 'ps5-slim-disc',
    'Sony PlayStation 5 Video Game Console': 'ps5-disc',
    'PS5 disc edition + 2 controllers': 'ps5-disc',
    'PS5 2 controllers 4 games': 'ps5-disc',
    'PS4 Pro 1TB': 'ps4-pro',
    'Nintendo Switch 2': 'switch-2',
    'Nintendo Switch, 2 controllers': 'switch',
    'Nintendo Switch OLED + Mario Kart + case': 'switch-oled',
    'Xbox Series X Digital': 'xbox-series-x-digital',
    'Steam Deck 256GB with 512GB SD card': 'steam-deck',
    'Oculus Quest 2': 'quest-2',
    'Meta Quest 3S': 'quest-3s',
    'Apple iPhone15 Pro Max 256GB': 'iphone-15-pro-max',
    'iPhone 14 Pro Max w/ case': 'iphone-14-pro-max',
    'Apple iPad (10th Generation) 64GB': 'ipad-10',
    'Apple AirPods Max Wireless Over-Ear Headphones': 'airpods-max',
  };
  for (const [title, want] of Object.entries(cases)) assert.equal(id(title), want, title);
  assert.equal(matchGuide('Steam Deck OLED 1TB').price, 722);
  assert.equal(matchGuide('Steam Deck 256GB with 512GB SD card').size, '256GB'); // the card is an extra
  assert.equal(matchGuide('Xbox Series S 1TB').price, 393.77);
  assert.equal(matchGuide('PS4 Slim').size, '500GB');
});

test('guide matching: accessories, other models and mixed titles get no guide price', () => {
  for (const title of [
    'PS5 DualSense Controller Midnight Black',
    'PlayStation VR2 headset for PS5',
    'PS5 | PlayStation VR2 headset',
    'PS5 Slim disc drive',
    'Nintendo Switch 2 controllers',
    'Nintendo Switch OLED dock',
    'Mario Kart World for Switch 2',
    'Xbox Series X|S controller',
    'Steam Deck OLED carrying case',
    'Meta Quest 3 Elite Strap with Battery',
    'iPhone 15 Pro Max case and screen protector',
    'Case for iPhone 15',
    'Magic Keyboard Folio for iPad 10th gen',
    'AirPods Max ear cushions',
    'Empty box iPhone 16 Pro',
    'Nintendo Switch games lot',
    'iPhone 13 mini',
    'iPhone 16e',
    'iPhone 14 Plus',
    'iPad Air 10th',
    'PS4 and PS5',
    'iPhone 13, upgrading to 15 Pro',
    'Light switch',
  ]) {
    assert.equal(id(title), null, title);
  }
  assert.equal(accessoryWord('PS5 controller', 'Consoles'), 'controller');
  assert.equal(accessoryWord('PS5 with controller', 'Consoles'), null);
  assert.equal(accessoryWord('PS5 Digital, no disc drive', 'Consoles'), null);
});

test('guide matching: notices when the main parts are missing', () => {
  assert.equal(missingPart('PS5 no controller', 'Consoles'), 'no controller');
  assert.equal(missingPart('Nintendo Switch OLED tablet only', 'Consoles'), 'tablet only');
  assert.equal(missingPart('Meta Quest 3 headset only', 'VR'), 'headset only');
  assert.equal(missingPart('PS5 console, no controller drift', 'Consoles'), null);
  assert.equal(missingPart('PS5 with controller', 'Consoles'), null);
});

test('guide price alone: medium confidence, can be a deal', () => {
  const e = evaluate(L('iPhone 14 Pro 128GB Unlocked', 220), { watch });
  assert.equal(e.resale.value, 347);
  assert.equal(e.resale.from, 'guide');
  assert.equal(e.resale.guide.source, 'Swappa');
  assert.equal(e.confidence, 'medium');
  assert.equal(e.verdict, 'deal');
  assert.equal(e.profit, 117); // 347 - 220 - 10
  assert.ok(e.reasons.some((r) => /price guide: iPhone 14 Pro, 128GB, Swappa, Nov 4, 2026/.test(r.text)));
  assert.equal(evaluate(L('iPhone 14 Pro 128GB', 320), { watch }).verdict, 'unsorted'); // only +$17
});

test('guide + local listings: agreement raises confidence, disagreement uses the lower number', () => {
  const pool = [300, 310, 320, 330, 315, 305].map((p, i) => ({ id: `p${i}`, title: 'PS5 Slim Digital Edition console', price: p }));
  // Local asks ~$312, x90% = ~$281, well under the guide's $450: the lower local number wins.
  const low = evaluate(L('PS5 Slim Digital', 180), { watch, pool });
  assert.equal(low.resale.from, 'comps');
  assert.ok(low.resale.value < 300);
  assert.ok(low.reasons.some((r) => /Local listings ask less/.test(r.text)));
  assert.equal(evaluate(L('PS5 Slim Digital', 260), { watch, pool }).verdict, 'unsorted');
  // Local asks ~$480, x90% = ~$432: agrees with $450, so high confidence.
  const agree = [470, 480, 490, 475, 485, 480].map((p, i) => ({ id: `q${i}`, title: 'PS5 Slim Digital Edition console', price: p }));
  const hi = evaluate(L('PS5 Slim Digital', 280), { watch, pool: agree });
  assert.equal(hi.confidence, 'high');
  assert.equal(hi.resale.from, 'guide+comps');
  assert.ok(hi.resale.value <= 450);
});

test('guide: far under the guide with nothing to confirm it is not trusted', () => {
  const e = evaluate(L('Steam Deck OLED 1TB', 60), { watch });
  assert.equal(e.confidence, 'low');
  assert.equal(e.verdict, 'unsorted');
  assert.match(e.headline, /check it is the same item/);
});

test('guide: catches the wrong model in a watch with your own resale price', () => {
  // A PS4 Pro in a PS5 search: your $380 would make it a "deal".
  const e = evaluate(L('PS4 Pro 1TB', 150), { watch: { ...watch, query: 'ps5', resaleValue: 380 } });
  assert.equal(e.resale.value, 155);
  assert.equal(e.verdict, 'unsorted');
  assert.ok(e.reasons.some((r) => /looks like a PlayStation 4 Pro/.test(r.text)));
  // The right item keeps your price.
  const ok = evaluate(L('PS5 Disc Edition', 250), { watch: { ...watch, query: 'ps5', resaleValue: 380 } });
  assert.equal(ok.resale.value, 380);
  assert.equal(ok.verdict, 'deal');
});

test('guide: jumpy prices, old data and missing parts lower confidence', () => {
  // PS5 Pro used prices were unusually high: the guide alone can't make it a deal.
  assert.equal(evaluate(L('PS5 Pro 2TB', 600), { watch }).verdict, 'unsorted');
  // Prices collected long ago count for less.
  const later = Date.parse(`${GUIDE_AS_OF}T12:00:00Z`) + (GUIDE_STALE_DAYS + 30) * 86400e3;
  const old = evaluate(L('Nintendo Switch OLED White', 110), { watch, now: later });
  assert.equal(old.confidence, 'low');
  assert.ok(old.reasons.some((r) => /months old/.test(r.text)));
  assert.equal(evaluate(L('Nintendo Switch OLED White', 110), { watch }).verdict, 'deal');
  // Without the dock and Joy-Cons it's worth less than the guide says.
  const bare = evaluate(L('Nintendo Switch OLED tablet only', 110), { watch });
  assert.equal(bare.confidence, 'low');
  assert.equal(bare.verdict, 'unsorted');
});

test('guide: fair condition counts lower, and the guide can be turned off', () => {
  const fair = evaluate(L('Xbox Series X 1TB', 300), { watch, details: { description: 'Works fine.', condition: 'Used - fair' } });
  assert.equal(fair.resale.value, Math.round(567.5 * 0.85));
  assert.ok(fair.reasons.some((r) => /counted 15% lower/.test(r.text)));
  const off = evaluate(L('Xbox Series X 1TB', 300), { watch, rules: { priceGuide: false } });
  assert.equal(off.resale, null);
  assert.equal(off.verdict, 'unsorted');
});
