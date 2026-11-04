// Runs the real server against the pretend Marketplace and a fake ntfy server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockFacebook } from '../tools/mock-facebook.js';
import { createApp } from '../src/server.js';
import { findBrowser } from '../src/facebook/browser.js';

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

async function boot(t, { engine = 'fast', browserPath = '' } = {}) {
  const mock = new MockFacebook({ autoAdd: false, seedCount: 10 });
  const fbBase = await mock.listen(0);
  const ntfy = await fakeNtfy();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-e2e-'));
  const app = await createApp({ fbBase, dataDir, scanGapMs: 50, host: '127.0.0.1', demo: false, browserPath });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  await api('/api/settings', { method: 'PUT', body: { engine, notify: { ntfy: { enabled: true, server: ntfy.url } } } });
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

  const created = await api('/api/watches', { method: 'POST', body: { query: 'bike', location: 'tampa', maxPrice: 5000 } });
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
  const items = await events.waitFor('listings', (ls) => ls.some((l) => l.id === fresh.id));
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

  const cross = await api('/api/settings', { method: 'PUT', body: { engine: 'browser' }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  for (const site of ['cross-site', 'same-site']) {
    const r = await api('/api/settings', { method: 'PUT', body: { engine: 'browser' }, headers: { 'sec-fetch-site': site } });
    assert.equal(r.status, 403, site);
  }
  // Behind a preview/reverse proxy the Origin no longer matches Host, but the browser still says same-origin.
  const proxied = await api('/api/settings', { method: 'PUT', body: { engine: 'fast' }, headers: { 'sec-fetch-site': 'same-origin', origin: 'https://preview.example' } });
  assert.equal(proxied.status, 200);

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

const browserPath = process.env.BROWSER_PATH || (await findBrowser());
test('browser mode reads the same listings through a real headless browser', { skip: !browserPath && 'no Chrome/Chromium found' }, async (t) => {
  const { mock, api } = await boot(t, { engine: 'browser', browserPath: process.env.BROWSER_PATH || '' });
  const created = (await api('/api/watches', { method: 'POST', body: { query: 'couch', location: 'tampa' } })).body;
  const done = await waitUntil(async () => (await api('/api/state')).body.watches[0].lastStatus, 60000);
  assert.equal(done.code, 'OK', done.message);
  assert.equal(done.engine, 'browser');
  const state = (await api('/api/state')).body;
  assert.equal(state.listings.length, 10);
  const ua = mock.requests.find((r) => r.path.startsWith('/marketplace/')).headers['user-agent'];
  assert.doesNotMatch(ua, /Headless/);
  assert.ok(created.id);
});

test('auto mode: when fast mode gets an empty page, the real browser takes over and reads the GraphQL data', { skip: !browserPath && 'no Chrome/Chromium found' }, async (t) => {
  const { mock, api, app } = await boot(t, { engine: 'auto', browserPath: process.env.BROWSER_PATH || '' });
  mock.mode = 'needs-js';
  await api('/api/watches', { method: 'POST', body: { query: 'ps5', location: 'tampa' } });
  const done = await waitUntil(async () => (await api('/api/state')).body.watches[0].lastStatus, 60000);
  assert.equal(done.code, 'OK', done.message);
  assert.equal(done.engine, 'browser');
  const { listings } = (await api('/api/state')).body;
  assert.equal(listings.length, 10);
  assert.ok(listings.every((l) => l.creationTime && l.photo), 'came from the GraphQL data, not just the visible cards');
  assert.ok(app.fb.httpPausedUntil > Date.now(), 'fast mode rests for a while');
  assert.ok(mock.requests.some((r) => r.path === '/api/graphql/'));
});
