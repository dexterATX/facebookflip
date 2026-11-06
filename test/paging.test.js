// Signing in with cookies, following Facebook's cursor to the end of the
// results, and keeping only what's local. The pretend Marketplace here acts
// like signed-in Facebook: no results without the session cookies, 24 per
// page, and the next pages from /api/graphql/ with the page's cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockFacebook } from '../tools/mock-facebook.js';
import { createApp } from '../src/server.js';
import { findBrowser } from '../src/facebook/browser.js';

const browserPath = process.env.BROWSER_PATH || (await findBrowser());

async function boot(t, { seedCount = 100, searchPages = 50, cookies = 'good', area = {}, mockSetup = {}, mockOpts = {} } = {}) {
  const mock = new MockFacebook({ autoAdd: false, seedCount, requireLogin: true, ...mockOpts });
  Object.assign(mock, mockSetup);
  const fbBase = await mock.listen(0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-paging-'));
  const app = await createApp({ fbBase, dataDir, scanGapMs: 50, requestGapMs: 20, pageGapMs: 20, scrollPauseMs: 60, host: '127.0.0.1', demo: false, browserPath: process.env.BROWSER_PATH || '' });
  const s = app.store.settings;
  s.searchPages = searchPages;
  Object.assign(s.area, { location: 'tampa', pickupOnly: false, autoStates: false, ...area });
  const jar = { good: `c_user=${mock.session.userId}; xs=${mock.session.xs}; datr=abc123`, stale: `c_user=${mock.session.userId}; xs=expired; datr=abc123`, none: '' }[cookies];
  if (jar) {
    s.cookies = jar;
    app.fb.useCookies();
  }
  const addr = await app.listen(0, '127.0.0.1');
  const api = (p, method = 'GET', body) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  t.after(async () => {
    await app.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  // Searches your area. Checked once right away (when signed in), then only when the test says so.
  const watch = app.store.addWatch({ name: 'Bikes', query: 'bike', intervalSec: 3600 });
  const first = cookies === 'none' ? null : await until(() => watch.lastScanAt && !app.monitor.busy && watch.lastStatus);
  return { mock, app, watch, first, api, dataDir };
}

async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ofWatch = (app, w) => Object.values(app.store.listings).filter((l) => l.watchIds.includes(w.id));
const settle = (app) => until(() => !app.monitor.deepRunning && !app.monitor.deepQueue.length);
const pagingCalls = (mock) => mock.graphqlCalls.filter((c) => c.cursor);

test('signed in with cookies, the first check follows the cursor to the very end: no browser', async (t) => {
  const { app, mock, watch, first } = await boot(t);
  assert.equal(first.code, 'OK', first.message);
  assert.equal(first.engine, 'cookies');
  assert.equal(ofWatch(app, watch).length, 100, 'all 100 results, though Facebook shows 24 per page');
  assert.deepEqual({ pages: watch.lastMore.pages, results: watch.lastMore.results, toEnd: watch.lastMore.toEnd }, { pages: 5, results: 100, toEnd: true });
  assert.equal(pagingCalls(mock).length, 4, 'one request per page after the first');
  assert.ok(pagingCalls(mock).every((c) => c.ok));
  assert.equal(app.fb.browser.ctx, null, 'no browser was started');
  assert.equal(app.store.data.facebook.account.name, 'Pat Example', 'knows whose cookies they are');
  assert.equal(app.monitor.logs.find((x) => x.more).how, "the search page's own query");
});

test('the cookies Facebook refreshes are kept, like a browser does, and survive a restart', async (t) => {
  const { app, dataDir } = await boot(t, { seedCount: 10 });
  const fr = app.store.data.facebook.jar.find((c) => c.name === 'fr');
  assert.ok(fr, 'picked up the refreshed cookie');
  assert.ok(app.store.data.facebook.jar.some((c) => c.name === 'xs'), 'kept the session');
  app.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(saved.facebook.jar.find((c) => c.name === 'fr').value, fr.value);
});

test('no cookies: nothing touches Facebook until they are pasted, then it checks right away', async (t) => {
  const { app, mock, watch, api } = await boot(t, { cookies: 'none' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mock.requests.filter((r) => r.path.startsWith('/marketplace')).length, 0);
  assert.equal(app.monitor.status.state, 'needs-cookies');
  assert.equal((await api('/api/state')).facebook.needsCookies, true);
  await api('/api/settings', 'PUT', { cookies: `c_user=${mock.session.userId}; xs=${mock.session.xs}` });
  const st = await until(() => watch.lastStatus);
  assert.equal(st.code, 'OK');
  assert.equal((await api('/api/state')).facebook.signedIn, true);
});

test('cookies Facebook no longer accepts: a clear message, not a mystery', async (t) => {
  const { first } = await boot(t, { cookies: 'stale' });
  assert.equal(first.code, 'LOGIN_REQUIRED');
  assert.match(first.message, /cookies/);
});

test("when the page's own query ignores the cursor, the id in Facebook's scripts is found and remembered", async (t) => {
  const { app, mock, watch } = await boot(t, { mockSetup: { containerAcceptsCursor: false } });
  assert.equal(ofWatch(app, watch).length, 100);
  assert.equal(app.store.data.facebook.paging.docId, mock.pagingDocId);
  assert.equal(app.monitor.logs.find((x) => x.more).how, "Facebook's script files");
  // Next time it asks the remembered way straight away.
  mock.graphqlCalls.length = 0;
  await app.monitor.scan(watch, { manual: true });
  assert.ok(pagingCalls(mock).every((c) => c.docId === mock.pagingDocId && c.ok));
  assert.equal(app.monitor.logs.filter((x) => x.more).at(-1).how, 'remembered from last time');
});

test('a remembered id that stopped working (Facebook updated) is replaced on the spot', async (t) => {
  const { app, mock, watch } = await boot(t, { seedCount: 10 });
  app.store.data.facebook.paging = { docId: '111111111111', how: 'remembered from last time', at: 0 };
  mock.add('bike', 'tampa', { ageMs: 1000 });
  for (let i = 0; i < 40; i++) mock.add('bike', 'tampa', { ageMs: 2000 + i });
  await app.monitor.scan(watch, { manual: true });
  assert.equal(ofWatch(app, watch).length, 51);
  assert.notEqual(app.store.data.facebook.paging.docId, '111111111111');
  assert.equal(app.monitor.logs.filter((x) => x.more).at(-1).toEnd, true);
});

test('a burst of new listings is followed past page 1 right away', async (t) => {
  const { app, mock, watch } = await boot(t);
  watch.lastMoreAt = Date.now();
  const burst = Array.from({ length: 30 }, (_, i) => mock.add('bike', 'tampa', { ageMs: 20e3 + i * 1000, title: `Burst bike ${i}` }));
  await app.monitor.scan(watch);
  const ids = new Set(ofWatch(app, watch).map((l) => l.id));
  assert.ok(burst.every((l) => ids.has(l.id)), 'all 30 new ones, though only 24 fit on page 1');
  const more = app.monitor.logs.filter((x) => x.more).at(-1);
  assert.equal(more.reason, 'burst of new listings');
  assert.ok(more.pages <= 3, 'stops once pages stop bringing new listings');
});

test('a deal Facebook placed on page 2 is caught by the regular deeper look, alerted and saved', async (t) => {
  const { app, mock, watch } = await boot(t);
  await settle(app);
  watch.lastMoreAt = Date.now();
  const sunk = mock.add('bike', 'tampa', { ageMs: 30e3, title: 'Trek FX 2 hybrid bike', price: 120, sink: true, description: 'Works great, tuned up last month.' });
  await app.monitor.scan(watch);
  assert.equal(app.store.listings[sunk.id], undefined, 'page 1 alone misses it, as on Facebook');
  watch.lastMoreAt = Date.now() - 11 * 60e3; // ten minutes later
  await app.monitor.scan(watch);
  const l = app.store.listings[sunk.id];
  assert.ok(l, 'found on page 2');
  await settle(app);
  assert.equal(l.pile, 'deals');
  assert.ok(l.details, 'its full listing was read (with the cookies) before alerting');
  assert.ok(l.alertedAt);
  assert.equal(l.saved, true);
});

test('your area: ship-only and out-of-state listings are dropped, and your state is learned', async (t) => {
  const { app, watch, mock, api } = await boot(t, { mockOpts: { shipEvery: 5 }, area: { pickupOnly: true, autoStates: true } });
  const kept = ofWatch(app, watch);
  assert.ok(kept.length > 50 && kept.length < 100, `${kept.length} kept`);
  assert.ok(kept.every((l) => l.state === 'FL'), 'nothing from out of state');
  assert.ok(kept.every((l) => l.deliveryTypes.includes('IN_PERSON')), 'nothing ship-only');
  const logged = app.monitor.logs.reduce((n, x) => n + (x.notLocal || 0), 0);
  assert.equal(logged, 100 - kept.length, 'every dropped one is counted in Activity');
  assert.deepEqual(app.store.settings.area.states, ['FL']);
  assert.match(mock.requests.find((r) => r.path.startsWith('/marketplace/tampa/search')).path, /deliveryMethod=local_pick_up/, 'and Facebook was asked for local pickup');
  // Moving your area: the state learned for the old place is learned again at the new one.
  await api('/api/settings', 'PUT', { area: { location: 'orlando' } });
  assert.deepEqual(app.store.settings.area.states, []);
  // States you type yourself stay put.
  await api('/api/settings', 'PUT', { area: { states: 'fl, Georgia' } });
  await api('/api/settings', 'PUT', { area: { location: 'tampa' } });
  assert.deepEqual(app.store.settings.area.states, ['FL', 'GA']);
});

test("a watch with a place of its own isn't held to your state, only to local pickup", async (t) => {
  const { app, watch } = await boot(t, { seedCount: 30, mockOpts: { shipEvery: 5 }, area: { pickupOnly: true, states: ['GA'] } });
  assert.equal(ofWatch(app, watch).length, 0, 'your area says Georgia, so Tampa results are dropped');
  const own = app.store.addWatch({ name: 'Tampa bikes', query: 'bike', location: 'tampa', intervalSec: 3600 });
  await until(() => own.lastScanAt && !app.monitor.busy && own.lastStatus);
  await settle(app);
  const kept = ofWatch(app, own);
  assert.ok(kept.length >= 20, `${kept.length} kept`);
  assert.ok(kept.every((l) => l.state === 'FL' && l.deliveryTypes.includes('IN_PERSON')), 'its own place, pickup only');
  assert.deepEqual(app.store.settings.area.states, ['GA'], 'and it never changes your state');
});

test('changing your area hides what is no longer local, except what you saved', async (t) => {
  const { app, watch, api } = await boot(t, { seedCount: 30, mockOpts: { shipEvery: 4 } });
  const all = ofWatch(app, watch);
  const shipOnly = all.filter((l) => !l.deliveryTypes.includes('IN_PERSON'));
  assert.ok(shipOnly.length > 0);
  Object.assign(shipOnly[0], { saved: true, autoSaved: false }); // one you starred yourself
  await api('/api/settings', 'PUT', { area: { pickupOnly: true } });
  assert.ok(shipOnly.slice(1).every((l) => l.hidden && !l.saved), 'hidden, even deals it had saved for you');
  assert.equal(shipOnly[0].hidden, false, 'your own star stays');
});

test('only the first page when depth is set to 24, and a short search never asks for more', async (t) => {
  const one = await boot(t, { searchPages: 1 });
  assert.equal(ofWatch(one.app, one.watch).length, 24);
  assert.equal(pagingCalls(one.mock).length, 0);
  const short = await boot(t, { seedCount: 15 });
  assert.equal(ofWatch(short.app, short.watch).length, 15);
  assert.equal(pagingCalls(short.mock).length, 0, 'Facebook said that was everything');
});

test('if no way of following the cursor works, it scrolls in a browser with the same cookies', { skip: !browserPath && 'no Chrome/Chromium found' }, async (t) => {
  const { app, mock, watch } = await boot(t, { mockSetup: { containerAcceptsCursor: false, opInScripts: false } });
  assert.equal(ofWatch(app, watch).length, 100, 'every page still read');
  const more = app.monitor.logs.find((x) => x.more);
  assert.equal(more.how, 'scrolling in the background browser');
  assert.ok(mock.graphqlCalls.some((c) => c.docId === mock.pagingDocId && c.ok), "the page's own code followed the cursor, signed in");
  const fr = app.store.data.facebook.jar.find((c) => c.name === 'fr');
  assert.equal(fr?.value, mock.lastFr, 'the cookie Facebook refreshed in the browser was kept too');
});
