// Reading past the first page of results. Facebook shows 24 per page and
// loads more as you scroll; the pretend Marketplace does the same, so these
// tests drive a real headless browser against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockFacebook } from '../tools/mock-facebook.js';
import { createApp } from '../src/server.js';
import { findBrowser } from '../src/facebook/browser.js';

const browserPath = process.env.BROWSER_PATH || (await findBrowser());
const skip = !browserPath && 'no Chrome/Chromium found';

async function boot(t, { engine = 'auto', seedCount = 70, searchPages = 10, panel = false } = {}) {
  const mock = new MockFacebook({ autoAdd: false, seedCount });
  mock.panel = panel;
  const fbBase = await mock.listen(0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-paging-'));
  const app = await createApp({ fbBase, dataDir, scanGapMs: 50, requestGapMs: 20, scrollPauseMs: 60, host: '127.0.0.1', demo: false, browserPath: process.env.BROWSER_PATH || '' });
  app.store.settings.engine = engine;
  app.store.settings.searchPages = searchPages;
  const addr = await app.listen(0, '127.0.0.1');
  const api = (p, method = 'GET', body) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  t.after(async () => {
    await app.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  // Checked once right away, then only when the test says so.
  const watch = app.store.addWatch({ name: 'Bikes', query: 'bike', location: 'tampa', intervalSec: 3600 });
  const first = await until(() => watch.lastScanAt && !app.monitor.busy && watch.lastStatus);
  return { mock, app, watch, first, api };
}

async function until(fn, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ofWatch = (app, w) => Object.values(app.store.listings).filter((l) => l.watchIds.includes(w.id));
const settle = (app) => until(() => !app.monitor.deepRunning && !app.monitor.deepQueue.length);

test('the first check of a search reads every page, not just the first 24', { skip }, async (t) => {
  const { app, watch, first } = await boot(t);
  assert.equal(first.code, 'OK', first.message);
  assert.equal(first.pages, 3, '70 listings is three pages of 24');
  assert.equal(ofWatch(app, watch).length, 70);
  assert.deepEqual({ pages: watch.lastMore.pages, results: watch.lastMore.results }, { pages: 3, results: 70 }, 'the watch remembers its last deeper read');
  const more = app.monitor.logs.find((x) => x.more);
  assert.equal(more.reason, 'first check');
  assert.equal(more.engine, 'browser');
  assert.equal(app.monitor.logs.find((x) => !x.more).engine, 'fast', 'page 1 still comes the fast way');
});

test('a burst of new listings is followed past page 1 right away', { skip }, async (t) => {
  const { app, mock, watch } = await boot(t);
  watch.lastMoreAt = Date.now(); // not due for a regular deeper look
  const burst = Array.from({ length: 30 }, (_, i) => mock.add('bike', 'tampa', { ageMs: 20e3 + i * 1000, title: `Burst bike ${i}` }));
  await app.monitor.scan(watch);
  const ids = new Set(ofWatch(app, watch).map((l) => l.id));
  assert.ok(burst.every((l) => ids.has(l.id)), 'all 30 new ones, though only 24 fit on page 1');
  const more = app.monitor.logs.filter((x) => x.more).at(-1);
  assert.equal(more.reason, 'burst of new listings');
  assert.ok(more.pages <= 3, 'stops once pages stop bringing new listings');
});

test('a deal Facebook placed on page 2 is caught by the regular deeper look, alerted and saved', { skip }, async (t) => {
  const { app, mock, watch } = await boot(t);
  await settle(app);
  watch.lastMoreAt = Date.now();
  // New, priced far under what Trek FX 2s go for, but shown below page 1.
  const sunk = mock.add('bike', 'tampa', { ageMs: 30e3, title: 'Trek FX 2 hybrid bike', price: 120, sink: true, description: 'Works great, tuned up last month.' });
  await app.monitor.scan(watch);
  assert.equal(app.store.listings[sunk.id], undefined, 'page 1 alone misses it, as on Facebook');

  watch.lastMoreAt = Date.now() - 11 * 60e3; // ten minutes later
  await app.monitor.scan(watch);
  const l = app.store.listings[sunk.id];
  assert.ok(l, 'found on page 2');
  assert.equal(app.monitor.logs.filter((x) => x.more).at(-1).reason, 'regular deeper look');
  await settle(app);
  assert.equal(l.pile, 'deals');
  assert.ok(l.details, 'its full listing was read before alerting');
  assert.ok(l.alertedAt, 'alerted');
  assert.equal(l.saved, true, 'saved');
  assert.match(fs.readFileSync(app.store.dealsFile, 'utf8'), new RegExp(`/marketplace/item/${sunk.id}/`));
});

test('only the first page when depth is set to 24, or in Fast only mode', { skip }, async (t) => {
  const one = await boot(t, { searchPages: 1 });
  assert.equal(one.first.pages, 1);
  assert.equal(ofWatch(one.app, one.watch).length, 24);
  assert.ok(!one.app.monitor.logs.some((x) => x.more));

  const fast = await boot(t, { engine: 'fast' });
  assert.equal(ofWatch(fast.app, fast.watch).length, 24);
  assert.match(fast.watch.moreProblem, /Fast only mode/);
  assert.ok(!fast.watch.morePausedUntil, 'no pause: switching to Auto works at the next check')
  assert.equal(fast.app.fb.browser.ctx, null, 'no browser was started');
});

test('a search with one page of results never opens the browser', { skip }, async (t) => {
  const { app, watch, first } = await boot(t, { seedCount: 15 });
  assert.equal(first.pages, 1);
  assert.equal(ofWatch(app, watch).length, 15);
  assert.ok(!app.monitor.logs.some((x) => x.more));
  assert.equal(app.fb.browser.ctx, null);
});

test('reads every page when the results scroll inside a panel instead of the page', { skip }, async (t) => {
  const { app, watch, first } = await boot(t, { panel: true });
  assert.equal(first.pages, 3);
  assert.equal(ofWatch(app, watch).length, 70);
});

test('switching from Fast only to Auto reads past page 1 at the very next check', { skip }, async (t) => {
  const { app, watch, api } = await boot(t, { engine: 'fast' });
  assert.match(watch.moreProblem, /Fast only mode/);
  const state = await api('/api/state');
  assert.match(state.watches[0].moreProblem, /Fast only mode/, 'the dashboard can say "first page only"');
  await api('/api/settings', 'PUT', { engine: 'auto' });
  await app.monitor.scan(watch, { manual: true });
  assert.equal(watch.moreProblem, null);
  assert.equal(watch.lastMore.pages, 3);
  assert.equal(ofWatch(app, watch).length, 70);
});
