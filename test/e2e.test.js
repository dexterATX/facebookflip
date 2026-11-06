// Runs the real server against the pretend Marketplace and a fake ntfy server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockFacebook } from '../tools/mock-facebook.js';
import { createApp } from '../src/server.js';
import { RULES_VERSION } from '../src/evaluate.js';

function fakeNtfy() {
  const got = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push({ path: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"x"}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}

/** Minimal Server-Sent Events reader. */
function sse(url) {
  const events = [];
  const waiters = [];
  const req = http.get(url, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (!name || !data) continue;
        const ev = { name, data: JSON.parse(data) };
        events.push(ev);
        for (const w of [...waiters]) if (w.name === name && w.pred(ev.data)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev.data);
        }
      }
    });
  });
  return {
    events,
    close: () => req.destroy(),
    waitFor(name, pred = () => true, ms = 10000) {
      const hit = events.find((e) => e.name === name && pred(e.data));
      if (hit) return Promise.resolve(hit.data);
      return new Promise((resolve, reject) => {
        const w = { name, pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timed out waiting for "${name}" event`)), ms).unref();
      });
    },
  };
}

async function waitUntil(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function boot(t, { seedCount = 10 } = {}) {
  const mock = new MockFacebook({ autoAdd: false, seedCount });
  const fbBase = await mock.listen(0);
  const ntfy = await fakeNtfy();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-e2e-'));
  const app = await createApp({ fbBase, dataDir, scanGapMs: 50, requestGapMs: 20, pageGapMs: 20, host: '127.0.0.1', demo: false, requireCookies: false });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  await api('/api/settings', { method: 'PUT', body: { notify: { ntfy: { enabled: true, server: ntfy.url } } } });
  const events = sse(`${base}/api/events`);
  t.after(async () => {
    events.close();
    await app.close();
    await mock.close();
    ntfy.srv.closeAllConnections?.();
    await new Promise((r) => ntfy.srv.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { mock, fbBase, ntfy, app, base, api, events };
}

test('finds listings, alerts on a brand-new one within one check, and handles a login wall', async (t) => {
  const { mock, fbBase, ntfy, api, events } = await boot(t);

  const created = await api('/api/watches', { method: 'POST', body: { query: 'bike', location: 'tampa', maxPrice: 5000, alertMode: 'all' } });
  assert.equal(created.status, 200);
  const w = created.body;
  assert.equal(w.name, 'bike');

  await waitUntil(async () => (await api('/api/state')).body.watches[0].lastStatus?.ok);
  let state = (await api('/api/state')).body;
  assert.equal(state.listings.length, 10, 'all seeded listings, the sponsored story skipped');
  // The two seeded listings posted 8 and 38 minutes ago are inside the 60 minute alert window.
  await waitUntil(() => ntfy.got.length === 2);

  const fresh = mock.add('bike', 'tampa', { ageMs: 30e3, title: 'Trek Domane SL5 road bike', price: 333 });
  await api(`/api/watches/${w.id}/scan`, { method: 'POST' });
  await events.waitFor('listings', (ls) => ls.some((l) => l.id === fresh.id));
  const items = await events.waitFor('alert', (ls) => ls.some((l) => l.id === fresh.id));
  const got = items.find((l) => l.id === fresh.id);
  assert.ok(got.alertedAt, 'new listing raised an alert');
  assert.equal(got.price, 333);
  assert.equal(got.url, `${fbBase}/marketplace/item/${fresh.id}/`);

  const push = await waitUntil(() => ntfy.got.find((m) => m.body.title.includes('Trek Domane')));
  assert.equal(push.body.topic, state.settings.notify.ntfy.topic);
  assert.equal(push.body.title, '$333 · Trek Domane SL5 road bike');
  assert.equal(push.body.click, got.url);
  assert.match(push.body.attach, /\.svg$/);
  assert.match(push.body.message, /posted (just now|1 min ago)/);

  // Looks like a browser: navigation headers, newest-first search, guest cookie kept between visits.
  const reqs = mock.requests.filter((r) => r.path.startsWith('/marketplace/'));
  assert.equal(reqs[0].headers['sec-fetch-mode'], 'navigate');
  assert.equal(reqs[0].headers['sec-fetch-dest'], 'document');
  const u = new URL(reqs[0].path, 'http://x');
  assert.equal(u.pathname, '/marketplace/tampa/search/');
  assert.equal(u.searchParams.get('sortBy'), 'creation_time_descend');
  assert.equal(u.searchParams.get('daysSinceListed'), '1');
  assert.match(reqs.at(-1).headers.cookie || '', /datr=/);

  // Login wall: everything pauses with a clear reason, then recovers.
  mock.mode = 'login';
  await api(`/api/watches/${w.id}/scan`, { method: 'POST' });
  await waitUntil(async () => (await api('/api/state')).body.status.problem?.code === 'LOGIN_REQUIRED');
  state = (await api('/api/state')).body;
  assert.equal(state.status.state, 'cooldown');
  assert.equal(state.watches[0].lastStatus.code, 'LOGIN_REQUIRED');
  mock.mode = 'ok';
  await api('/api/resume', { method: 'POST' });
  await waitUntil(async () => (await api('/api/state')).body.status.problem === null);
});

test('deals pipeline: reads the full listing, alerts only the real deal, and learns from your feedback', async (t) => {
  const { mock, ntfy, api, events } = await boot(t, { seedCount: 0 });
  // Price history: eight consoles asking about $400, posted hours ago.
  for (const p of [400, 410, 390, 405, 395, 420, 380, 400]) mock.add('ps5', 'tampa', { title: 'PS5 disc edition console', price: p, ageMs: 10 * 3600e3, description: 'Works great.' });
  const w = (await api('/api/watches', { method: 'POST', body: { query: 'ps5', location: 'tampa' } })).body;
  assert.equal(w.alertMode, 'deals');
  await waitUntil(async () => (await api('/api/state')).body.watches[0].lastStatus?.ok);
  assert.equal(ntfy.got.length, 0, 'baseline: nothing to alert');

  const good = mock.add('ps5', 'tampa', { title: 'PS5 disc edition', price: 200, ageMs: 60e3, description: 'Barely used, works perfectly. Pick up today.', condition: 'PC_USED_LIKE_NEW' });
  const broken = mock.add('ps5', 'tampa', { title: 'PS5 disc edition', price: 190, ageMs: 60e3, description: "Doesn't turn on.\nSelling for parts.", condition: 'PC_USED_FAIR' });
  await api(`/api/watches/${w.id}/scan`, { method: 'POST' });
  const alerted = await events.waitFor('alert', (items) => items.some((l) => l.id === good.id));
  assert.equal(alerted[0].eval.verdict, 'deal');
  assert.equal(alerted[0].details.condition, 'Used - like new');

  const push = await waitUntil(() => ntfy.got.find((m) => m.body.title.includes('PS5 disc edition')));
  assert.equal(push.body.title, '$200 · PS5 disc edition');
  assert.match(push.body.message, /^\+\$\d+ profit, resells ~\$\d+/);
  const pages = mock.requests.filter((r) => r.path.startsWith('/marketplace/item/')).map((r) => r.path);
  assert.ok(pages.includes(`/marketplace/item/${good.id}/`) && pages.includes(`/marketplace/item/${broken.id}/`), 'both full listings were read');

  await waitUntil(async () => (await api('/api/state')).body.listings.find((l) => l.id === broken.id)?.details);
  let state = (await api('/api/state')).body;
  const b = state.listings.find((l) => l.id === broken.id);
  assert.equal(b.pile, 'unsorted');
  assert.match(b.eval.headline, /for parts/i);
  assert.equal(ntfy.got.filter((m) => m.body.title.includes('PS5')).length, 1, 'the broken one never alerted');

  // Your thumbs-down overrides the call and counts toward accuracy.
  await api(`/api/listings/${good.id}`, { method: 'POST', body: { feedback: 'bad' } });
  await api(`/api/listings/${broken.id}`, { method: 'POST', body: { feedback: 'bad' } });
  state = (await api('/api/state')).body;
  assert.deepEqual(state.accuracy, { dealsRight: 0, dealsWrong: 1, missed: 0, rightSkips: 1 });
  assert.equal(state.listings.find((l) => l.id === good.id).pileOverride, 'unsorted');

  // Raising the profit bar re-sorts what's already found.
  await api('/api/settings', { method: 'PUT', body: { deals: { minProfit: 500 } } });
  state = (await api('/api/state')).body;
  assert.ok(state.listings.every((l) => l.pile === 'unsorted'));
});

test('API: validation, secrets stay masked, cross-site and foreign-host requests are refused', async (t) => {
  const { base, api, app } = await boot(t);

  const bad = await api('/api/watches', { method: 'POST', body: { location: 'tampa' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /search for/);

  const parsed = await api('/api/parse-url', { method: 'POST', body: { url: 'https://www.facebook.com/marketplace/nyc/search/?query=ps5&maxPrice=400' } });
  assert.deepEqual([parsed.body.location, parsed.body.query, parsed.body.maxPrice], ['nyc', 'ps5', 400]);
  assert.equal((await api('/api/parse-url', { method: 'POST', body: { url: 'https://www.facebook.com/marketplace/item/123/' } })).status, 400);

  await api('/api/settings', { method: 'PUT', body: { cookies: 'c_user=1; xs=2', notify: { discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } } } });
  const st = (await api('/api/state')).body;
  assert.equal(st.settings.cookies, '');
  assert.equal(st.settings.cookiesKind, 'session');
  assert.equal(st.settings.notify.discord.webhookUrl, '••••••••');
  // Sending the mask back must not overwrite the real value.
  await api('/api/settings', { method: 'PUT', body: { notify: { discord: { webhookUrl: '••••••••' } } } });
  assert.equal(app.store.settings.notify.discord.webhookUrl, 'https://discord.com/api/webhooks/1/abc');

  const cross = await api('/api/settings', { method: 'PUT', body: { searchPages: 1 }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(app.store.settings.searchPages, 50, 'a blocked request changes nothing');
  for (const site of ['cross-site', 'same-site']) {
    const r = await api('/api/settings', { method: 'PUT', body: { searchPages: 1 }, headers: { 'sec-fetch-site': site } });
    assert.equal(r.status, 403, site);
  }
  // Behind a preview/reverse proxy the Origin no longer matches Host, but the browser still says same-origin.
  const proxied = await api('/api/settings', { method: 'PUT', body: { searchPages: 3 }, headers: { 'sec-fetch-site': 'same-origin', origin: 'https://preview.example' } });
  assert.equal(proxied.status, 200);
  assert.equal(app.store.settings.searchPages, 3);

  const foreignHost = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(foreignHost, 403);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
});

test('listings saved by an older version are re-judged once with the current rules', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-upgrade-'));
  const watch = { id: 'w1', name: 'iPhones', query: 'iphone', location: 'tampa', intervalSec: 180, enabled: true, alertMode: 'deals', include: [], exclude: [] };
  const old = { id: '123', title: 'iPhone 14 Pro 128GB Unlocked', price: 220, priceText: '$220', url: 'https://www.facebook.com/marketplace/item/123/', watchIds: ['w1'], firstSeenAt: Date.now(), pile: 'unsorted', eval: { verdict: 'unsorted', headline: 'Not enough price info yet to judge' } };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ watches: [watch], listings: { 123: old } }));
  const app = await createApp({ dataDir, fbBase: 'http://127.0.0.1:9', demo: false });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const l = app.store.listings['123'];
  assert.equal(l.eval.resale.from, 'guide'); // now priced by the price guide
  assert.equal(l.pile, 'deals');
  assert.equal(app.store.data.rulesVersion, RULES_VERSION);
});

test('saved deals: download as a spreadsheet, thumbs and Clear respect them', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-deals-'));
  const watch = { id: 'w1', name: 'iPhones', query: 'iphone', location: 'tampa', intervalSec: 180, enabled: true, alertMode: 'deals', include: [], exclude: [] };
  const item = (id, title, price) => ({ id, title, price, priceText: `$${price}`, url: `https://www.facebook.com/marketplace/item/${id}/`, watchIds: ['w1'], firstSeenAt: Date.now(), pile: 'unsorted' });
  const listings = { 1: item('1', 'iPhone 14 Pro 128GB Unlocked', 220), 2: item('2', 'iPhone 14 Pro 128GB', 330) };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ watches: [watch], listings }));
  const app = await createApp({ dataDir, fbBase: 'http://127.0.0.1:9', demo: false });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

  // The deal found before this version is saved on start; the fair price isn't.
  assert.equal(app.store.listings['1'].saved, true);
  assert.ok(!app.store.listings['2'].saved);
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state.dealsLogged, 1);

  const res = await fetch(`${base}/api/deals.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="flipradar-deals-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(await res.text(), /iPhone 14 Pro 128GB Unlocked,220,347,117,34%/);

  // Thumbs-down: not a deal after all, so it's no longer kept. Thumbs-up keeps it.
  assert.equal((await post('/api/listings/1', { feedback: 'bad' })).saved, false);
  assert.equal((await post('/api/listings/2', { feedback: 'good' })).saved, true);
  // Clear hides everything except what's saved.
  await post('/api/listings-clear', {});
  assert.ok(!app.store.listings['2'].hidden);
  assert.equal(app.store.listings['1'].hidden, true);
  const after = await fetch(`${base}/api/deals.csv`).then((r) => r.text());
  assert.equal(after.trim().split('\n').length, 3, 'header + the two deals, no duplicates');
});
