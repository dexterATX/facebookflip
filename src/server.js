// FlipRadar web server: JSON API + live updates (SSE) + the dashboard files.
// No framework needed; it is all Node's built-in http module.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config as defaultConfig } from './config.js';
import { Store, cleanWatchInput, INTERVALS } from './store.js';
import { Monitor } from './monitor.js';
import { AiAdvisor, AI_MODELS } from './ai.js';
import { Notifier } from './notify.js';
import { FacebookClient } from './facebook/client.js';
import { buildSearchUrl, parseMarketplaceUrl } from './facebook/urls.js';
import { parseCookieInput, hasSession } from './facebook/cookies.js';
import { JUNK_WORDS } from './deals.js';
import { guideSummary } from './priceguide.js';
import { Hub } from './sse.js';
import { clamp, toNumber, log, isMainModule } from './util.js';

const VERSION = '1.0.0';
const SECRET = '••••••••';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  'img-src * data: blob:',
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shapes sent to the dashboard

function maskSettings(s) {
  const n = s.notify;
  return {
    ...s,
    cookies: '',
    cookiesSet: Boolean(s.cookies),
    cookiesKind: (() => {
      const list = parseCookieInput(s.cookies);
      return list.length ? (hasSession(list) ? 'session' : 'partial') : 'none';
    })(),
    ai: { ...s.ai, apiKey: s.ai.apiKey ? SECRET : '', envKey: Boolean(process.env.ANTHROPIC_API_KEY) },
    notify: {
      ntfy: { ...n.ntfy, token: n.ntfy.token ? SECRET : '' },
      discord: { ...n.discord, webhookUrl: n.discord.webhookUrl ? SECRET : '' },
      telegram: { ...n.telegram, botToken: n.telegram.botToken ? SECRET : '' },
    },
  };
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function applySettings(cur, patch) {
  if (!patch || typeof patch !== 'object') return;
  if (['auto', 'fast', 'browser'].includes(patch.engine)) cur.engine = patch.engine;
  if (typeof patch.cookies === 'string') cur.cookies = patch.cookies.trim().slice(0, 20000);
  if ('maxAlertAgeMin' in patch) cur.maxAlertAgeMin = clamp(Math.round(toNumber(patch.maxAlertAgeMin) || 60), 5, 1440);
  if ('hidePlaceholderPrices' in patch) cur.hidePlaceholderPrices = Boolean(patch.hidePlaceholderPrices);
  if (patch.deals && typeof patch.deals === 'object') {
    const d = patch.deals;
    const num = (v, lo, hi, dflt) => clamp(toNumber(v) ?? dflt, lo, hi);
    if ('minProfit' in d) cur.deals.minProfit = num(d.minProfit, 0, 100000, 40);
    if ('minMarginPct' in d) cur.deals.minMarginPct = num(d.minMarginPct, 0, 95, 25);
    if ('otherCosts' in d) cur.deals.otherCosts = num(d.otherCosts, 0, 10000, 10);
    if ('askToSalePct' in d) cur.deals.askToSalePct = num(d.askToSalePct, 40, 120, 90);
    if ('readDetails' in d) cur.deals.readDetails = Boolean(d.readDetails);
    if ('priceGuide' in d) cur.deals.priceGuide = Boolean(d.priceGuide);
  }
  if (patch.ai && typeof patch.ai === 'object') {
    const a = patch.ai;
    if ('enabled' in a) cur.ai.enabled = Boolean(a.enabled);
    if (typeof a.apiKey === 'string' && a.apiKey !== SECRET) cur.ai.apiKey = a.apiKey.trim().slice(0, 300);
    if (typeof a.model === 'string' && AI_MODELS[a.model]) cur.ai.model = a.model;
    if ('maxPerDay' in a) cur.ai.maxPerDay = clamp(Math.round(toNumber(a.maxPerDay) ?? 60), 0, 2000);
  }
  if (patch.quietHours && typeof patch.quietHours === 'object') {
    const q = patch.quietHours;
    if ('enabled' in q) cur.quietHours.enabled = Boolean(q.enabled);
    if ('start' in q) cur.quietHours.start = clamp(Math.round(toNumber(q.start) ?? 1), 0, 23);
    if ('end' in q) cur.quietHours.end = clamp(Math.round(toNumber(q.end) ?? 6), 0, 23);
  }
  const n = patch.notify;
  if (n && typeof n === 'object') {
    const set = (ch, key, val, max) => {
      if (val === undefined || val === SECRET) return;
      cur.notify[ch][key] = typeof cur.notify[ch][key] === 'boolean' ? Boolean(val) : str(val, max);
    };
    for (const [ch, fields] of Object.entries({
      ntfy: ['enabled', 'server', 'topic', 'token'],
      discord: ['enabled', 'webhookUrl'],
      telegram: ['enabled', 'botToken', 'chatId'],
    })) {
      if (n[ch] && typeof n[ch] === 'object') for (const f of fields) set(ch, f, n[ch][f], 600);
    }
    if (cur.notify.ntfy.topic && !/^[\w-]{1,64}$/.test(cur.notify.ntfy.topic)) {
      throw new HttpError(400, 'An ntfy topic can only use letters, numbers, - and _.');
    }
  }
}

// ---------------------------------------------------------------------------

export async function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'db.json'));
  const hub = new Hub();
  const fb = new FacebookClient({ store, config });
  const notifier = new Notifier(store);
  const ai = new AiAdvisor({ store, clientFactory: overrides.aiClientFactory });
  const monitor = new Monitor({ store, fb, notifier, ai, fbBase: config.fbBase, gapMs: config.scanGapMs });
  // Listings saved by an older version have no pile yet: judge them once.
  if (Object.values(store.listings).some((l) => !l.pile)) monitor.reevaluate();

  const publicWatch = (w) => ({ ...w, searchUrl: buildSearchUrl(w, config.fbBase) });

  monitor.on('listings', (items) => hub.send('listings', items));
  monitor.on('updates', (items) => hub.send('updates', items));
  monitor.on('alert', (items) => hub.send('alert', items));
  monitor.on('watch', (w) => hub.send('watch', publicWatch(w)));
  monitor.on('log', (e) => hub.send('log', e));
  monitor.on('notify', (errors) => hub.send('notify', errors));
  let lastStatus = '';
  monitor.on('status', (s) => {
    const key = JSON.stringify(s);
    if (key !== lastStatus) {
      lastStatus = key;
      hub.send('status', s);
    }
  });

  const pushFacebook = async () => hub.send('facebook', await fb.status());

  // -------------------------------------------------------------------------
  // API

  const routes = [];
  const add = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, fn });
  };

  // How often your thumbs-up / thumbs-down agreed with the deal checker.
  const accuracy = () => {
    const s = { dealsRight: 0, dealsWrong: 0, missed: 0, rightSkips: 0 };
    for (const l of Object.values(store.listings)) {
      if (!l.feedback) continue;
      if (l.pile === 'deals') s[l.feedback === 'good' ? 'dealsRight' : 'dealsWrong']++;
      else s[l.feedback === 'good' ? 'missed' : 'rightSkips']++;
    }
    return s;
  };
  const aiInfo = () => ({
    usage: ai.usage(),
    lastError: ai.lastError,
    models: Object.fromEntries(Object.entries(AI_MODELS).map(([k, v]) => [k, v.label])),
  });

  add('GET', '/api/state', async () => ({
    version: VERSION,
    accuracy: accuracy(),
    ai: aiInfo(),
    demo: config.demo,
    settings: maskSettings(store.settings),
    watches: store.watches.map(publicWatch),
    listings: store.recent({ limit: 400 }),
    status: monitor.status,
    facebook: await fb.status(),
    notifyErrors: notifier.errors,
    logs: monitor.logs.slice(-80),
    junkWords: JUNK_WORDS,
    intervals: INTERVALS,
    priceGuide: guideSummary(),
  }));

  add('GET', '/api/listings', async ({ query }) => ({
    listings: store.recent({ limit: clamp(toNumber(query.get('limit')) || 200, 1, 500), before: toNumber(query.get('before')) || Infinity }),
  }));

  add('POST', '/api/watches', async ({ body }) => {
    const w = store.addWatch(cleanWatchInput(body));
    hub.send('watch', publicWatch(w));
    monitor.emitStatus();
    monitor.tick();
    return publicWatch(w);
  });

  add('PUT', '/api/watches/:id', async ({ params, body }) => {
    const existing = store.getWatch(params.id);
    if (!existing) throw new HttpError(404, 'That watch no longer exists.');
    const judged = (x) => JSON.stringify([x.resaleValue, x.sellOn, x.shipCost, x.include, x.exclude, x.minPrice, x.maxPrice, x.query]);
    const before = judged(existing);
    const w = store.updateWatch(params.id, cleanWatchInput(body, existing));
    if (judged(w) !== before) {
      // Resale price, fees or filters changed: re-judge what this watch already found.
      monitor.reevaluate(w.id);
      hub.send('reload', { reason: 'watch' });
    }
    hub.send('watch', publicWatch(w));
    monitor.emitStatus();
    monitor.tick();
    return publicWatch(w);
  });

  add('DELETE', '/api/watches/:id', async ({ params }) => {
    if (!store.removeWatch(params.id)) throw new HttpError(404, 'That watch no longer exists.');
    hub.send('watch-removed', { id: params.id });
    monitor.emitStatus();
    return { ok: true };
  });

  add('POST', '/api/watches/:id/scan', async ({ params }) => {
    if (!store.getWatch(params.id)) throw new HttpError(404, 'That watch no longer exists.');
    monitor.scanNow(params.id);
    return { ok: true };
  });

  add('POST', '/api/listings/:id', async ({ params, body }) => {
    const l = store.listings[params.id];
    if (!l) throw new HttpError(404, 'Listing not found.');
    if ('saved' in body) l.saved = Boolean(body.saved);
    if ('hidden' in body) l.hidden = Boolean(body.hidden);
    if ('feedback' in body) {
      // Your call wins: thumbs-up moves it to Deals, thumbs-down to Unsorted.
      l.feedback = body.feedback === 'good' || body.feedback === 'bad' ? body.feedback : null;
      l.pileOverride = l.feedback === 'good' ? 'deals' : l.feedback === 'bad' ? 'unsorted' : null;
      hub.send('accuracy', accuracy());
    }
    store.save();
    hub.send('updates', [l]);
    return l;
  });

  add('POST', '/api/listings-clear', async () => {
    let n = 0;
    for (const l of Object.values(store.listings)) {
      if (!l.saved && !l.hidden) {
        // Keep it as "hidden" so it is not reported as new again.
        l.hidden = true;
        n++;
      }
    }
    store.save();
    return { cleared: n };
  });

  add('PUT', '/api/settings', async ({ body }) => {
    const before = store.settings.engine;
    const rulesBefore = JSON.stringify([store.settings.deals, store.settings.hidePlaceholderPrices]);
    applySettings(store.settings, body);
    store.save();
    if (JSON.stringify([store.settings.deals, store.settings.hidePlaceholderPrices]) !== rulesBefore) {
      // New deal rules: re-sort everything already found.
      monitor.reevaluate();
      hub.send('reload', { reason: 'rules' });
    }
    if (body.ai) hub.send('ai', aiInfo());
    if (before !== store.settings.engine) fb.httpPausedUntil = 0;
    const masked = maskSettings(store.settings);
    hub.send('settings', masked);
    pushFacebook();
    monitor.emitStatus();
    return masked;
  });

  add('POST', '/api/notify/test', async ({ body }) => {
    const ch = String(body.channel || '');
    const override = {};
    for (const [k, v] of Object.entries(body.config || {})) if (v !== SECRET && v !== '' && v != null) override[k] = v;
    try {
      await notifier.test(ch, override);
      hub.send('notify', notifier.errors);
      return { ok: true };
    } catch (e) {
      throw new HttpError(400, `Test failed: ${e.message}`);
    }
  });

  add('POST', '/api/ai/test', async () => {
    if (!ai.enabled()) throw new HttpError(400, 'Turn on the AI check and add an Anthropic API key first.');
    const sample = { id: 'test', title: 'PS5 disc edition with 2 controllers', price: 250, priceText: '$250', locationText: 'Tampa, FL', photo: null };
    const r = await ai.assess(sample, { sellOn: 'local' });
    hub.send('ai', aiInfo());
    if (!r.ok) throw new HttpError(400, `AI check failed: ${r.message}`);
    return { ok: true, item: r.item, low: r.low, high: r.high, model: r.model, costUsd: r.costUsd };
  });

  add('POST', '/api/parse-url', async ({ body }) => {
    const p = parseMarketplaceUrl(body.url);
    if (!p) throw new HttpError(400, 'That is not a Facebook Marketplace link. Copy the address from your browser while looking at a Marketplace search.');
    if (p.kind === 'item') {
      throw new HttpError(400, 'That link is a single listing. Search for something on Marketplace first, then copy that page\'s link.');
    }
    return p;
  });

  add('POST', '/api/facebook/connect', async () => {
    const st = await fb.browser.status();
    if (!st.installed || !st.executable) throw new HttpError(400, 'No browser found. Install Google Chrome (or Edge), then try again.');
    if (!st.canShowWindow) throw new HttpError(400, 'This computer has no screen for a login window. Use Advanced > Paste cookies instead.');
    if (st.loginActive) return { started: true };
    fb.browser
      .connect()
      .then((r) => {
        if (r.ok) {
          Object.assign(store.data.facebook, { connected: true, connectedAt: Date.now() });
          store.save();
          monitor.problem = null;
          monitor.clearCooldown();
          fb.httpPausedUntil = 0;
          for (const w of store.watches) if (w.enabled) w.nextScanAt = Math.min(w.nextScanAt || 0, Date.now());
          hub.send('toast', { kind: 'ok', text: 'Facebook connected. Checking your watches now.' });
        } else {
          hub.send('toast', { kind: 'warn', text: r.cancelled ? 'Login window closed before logging in.' : 'Login timed out.' });
        }
      })
      .catch((e) => hub.send('toast', { kind: 'error', text: e.message }))
      .finally(pushFacebook);
    setTimeout(pushFacebook, 300);
    return { started: true };
  });

  add('POST', '/api/facebook/disconnect', async () => {
    await fb.browser.disconnect();
    Object.assign(store.data.facebook, { connected: false, connectedAt: null });
    store.save();
    await pushFacebook();
    return { ok: true };
  });

  add('POST', '/api/resume', async () => {
    monitor.problem = null;
    monitor.clearCooldown();
    for (const w of store.watches) if (w.enabled) w.nextScanAt = Date.now();
    monitor.tick();
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Plumbing

  const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host);

  function checkAccess(req) {
    // Stop other websites from talking to this app through your browser
    // (DNS rebinding / cross-site requests).
    if (loopbackHost) {
      const host = String(req.headers.host || '')
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new HttpError(403, 'Forbidden host');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Browsers label every request with where it came from (Sec-Fetch-Site),
      // and a web page cannot fake it. Trust that when present: it keeps working
      // behind proxies that rewrite the Host header. Otherwise compare Origin.
      const site = req.headers['sec-fetch-site'];
      if (site) {
        if (site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked');
      } else {
        const origin = req.headers.origin;
        if (origin && origin !== 'null') {
          let ok = false;
          try {
            ok = new URL(origin).host === req.headers.host;
          } catch {
            ok = false;
          }
          if (!ok) throw new HttpError(403, 'Cross-site request blocked');
        }
      }
    }
    if (config.password) {
      const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
      const given = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : '';
      const a = crypto.createHash('sha256').update(given).digest();
      const b = crypto.createHash('sha256').update(config.password).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        const e = new HttpError(401, 'Password required');
        e.auth = true;
        throw e;
      }
    }
  }

  async function readJson(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return {};
    const type = String(req.headers['content-type'] || '');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new HttpError(413, 'Request too large');
      chunks.push(c);
    }
    if (!size) return {};
    if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON');
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    try {
      rel = decodeURIComponent(rel);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Not found');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) throw new HttpError(404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const longCache = ext === '.png' || ext === '.ico';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': longCache ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(ext === '.html' ? { 'content-security-policy': CSP } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      checkAccess(req);
      if (url.pathname === '/api/events') {
        hub.add(req, res);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!route) throw new HttpError(404, 'Unknown API route');
        const m = url.pathname.match(route.re);
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = await readJson(req);
        const data = await route.fn({ params, body, query: url.searchParams, req });
        return sendJson(res, 200, data ?? { ok: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.error(e.stack || e.message);
      if (res.headersSent) return res.end();
      if (e.auth) res.setHeader('www-authenticate', 'Basic realm="FlipRadar", charset="UTF-8"');
      if (url.pathname.startsWith('/api/') || status !== 404) return sendJson(res, status, { error: status >= 500 ? 'Something went wrong. Check the terminal window for details.' : e.message });
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error(e.stack || e.message);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  const pruneTimer = setInterval(() => store.prune(), 3600e3);
  pruneTimer.unref?.();
  store.prune();

  return {
    config,
    store,
    hub,
    fb,
    notifier,
    monitor,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          monitor.start();
          resolve(server.address());
        });
      });
    },
    async close() {
      monitor.stop();
      clearInterval(pruneTimer);
      hub.close();
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await fb.browser.close().catch(() => {});
      store.flush();
    },
  };
}

function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no desktop browser; that's fine */
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    log.error(`FlipRadar needs Node.js 20 or newer (you have ${process.versions.node}). Get the LTS version from https://nodejs.org`);
    process.exit(1);
  }
  const app = await createApp();
  try {
    await app.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      log.error(`Port ${app.config.port} is already in use. Is FlipRadar already running? Otherwise start with PORT=3001.`);
      process.exit(1);
    }
    throw e;
  }
  const shown = ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(app.config.host) ? 'localhost' : app.config.host;
  const url = `http://${shown}:${app.config.port}`;
  console.log('');
  console.log(`  FlipRadar is running  ->  ${url}${app.config.demo ? '   (DEMO MODE: fake listings)' : ''}`);
  console.log('  Keep this window open while you want alerts. Press Ctrl+C to stop.');
  console.log('');
  if (app.config.openBrowser) openInBrowser(url);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('Stopping...');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return app;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    log.error(e.stack || e.message);
    process.exit(1);
  });
}

export { main };
