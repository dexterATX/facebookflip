// Everything the app remembers lives in data/db.json: settings, watches and
// the listings it has found. Writes are batched and atomic (write a temp
// file, then rename) so a crash never leaves a half-written file.

import fs from 'node:fs';
import path from 'node:path';
import { randomId, clamp, toNumber, log } from './util.js';
import { DEFAULT_DEAL_RULES } from './evaluate.js';
import { DEFAULT_AI_MODEL } from './ai.js';

export const DEFAULT_SETTINGS = {
  engine: 'auto', // 'auto' | 'fast' | 'browser'
  cookies: '', // optional Facebook cookies (Settings > Advanced)
  maxAlertAgeMin: 60, // only alert on listings posted within this many minutes
  hidePlaceholderPrices: true, // hide "$1" bait listings
  quietHours: { enabled: false, start: 1, end: 6 },
  deals: { ...DEFAULT_DEAL_RULES },
  ai: { enabled: false, apiKey: '', model: DEFAULT_AI_MODEL, maxPerDay: 60 },
  notify: {
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
    discord: { enabled: false, webhookUrl: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
  },
};

export const INTERVALS = [60, 120, 180, 300, 600, 900, 1800, 3600];
const KEEP_MS = 7 * 86400e3;
const MAX_LISTINGS = 3000;
// Price memory for comparisons outlives the listings themselves.
const COMPS_KEEP_MS = 45 * 86400e3;
const COMPS_WINDOW_MS = 30 * 86400e3;
const MAX_COMPS = 12000;
const SEARCH_FIELDS = ['query', 'location', 'category', 'minPrice', 'maxPrice', 'radius', 'extraParams', 'include', 'exclude'];

export const sortKey = (l) => l.creationTime || l.firstSeenAt || 0;

function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (!(k in target)) continue; // drop unknown keys
    const cur = target[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) deepMerge(cur, v);
    else if (typeof v === typeof cur) target[k] = v;
  }
  return target;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while an antivirus scans the file.
    fs.writeFileSync(file, text);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

const terms = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 40)
    .map((s) => s.slice(0, 60));

const price = (v) => {
  const n = toNumber(v);
  return n === null || n < 0 ? null : n;
};

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/** Validates watch fields coming from the dashboard. Throws a friendly Error (status 400) on bad input. */
export function cleanWatchInput(body, existing = null) {
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  if (has('query')) out.query = String(b.query || '').trim().slice(0, 120);
  if (has('location')) out.location = String(b.location || '').trim().slice(0, 80);
  if (has('category')) out.category = String(b.category || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
  if (has('minPrice')) out.minPrice = price(b.minPrice);
  if (has('maxPrice')) out.maxPrice = price(b.maxPrice);
  if (has('radius')) out.radius = price(b.radius);
  if (has('extraParams')) {
    out.extraParams = {};
    for (const [k, v] of Object.entries(b.extraParams || {}).slice(0, 20)) {
      if (/^[\w.-]{1,40}$/.test(k) && typeof v === 'string') out.extraParams[k] = v.slice(0, 200);
    }
  }
  if (has('include')) out.include = terms(b.include);
  if (has('exclude')) out.exclude = terms(b.exclude);
  if (has('intervalSec')) out.intervalSec = clamp(Math.round(toNumber(b.intervalSec) || 180), 60, 3600);
  if (has('alertMode')) out.alertMode = b.alertMode === 'all' ? 'all' : 'deals';
  if (has('resaleValue')) out.resaleValue = price(b.resaleValue) || null;
  if (has('sellOn')) out.sellOn = b.sellOn === 'ebay' ? 'ebay' : 'local';
  if (has('shipCost')) out.shipCost = price(b.shipCost);
  if (has('alertDrops')) out.alertDrops = Boolean(b.alertDrops);
  if (has('enabled')) out.enabled = Boolean(b.enabled);
  if (has('mute')) out.mute = Boolean(b.mute);
  if (has('name')) out.name = String(b.name || '').trim().slice(0, 60);

  const merged = { ...(existing || {}), ...out };
  if (!merged.query && !merged.category) throw invalid('Type what to search for (for example: "road bike").');
  if (merged.minPrice != null && merged.maxPrice != null && merged.minPrice > merged.maxPrice) {
    throw invalid('Min price is higher than max price.');
  }
  if (!merged.name) out.name = (merged.query || merged.category).slice(0, 60);
  return out;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const bad = `${this.file}.broken-${Date.now()}`;
        try {
          fs.renameSync(this.file, bad);
        } catch {
          /* ignore */
        }
        log.warn(`Could not read ${this.file} (${e.message}). Kept a copy at ${bad} and started fresh.`);
      }
    }
    const d = raw && typeof raw === 'object' ? raw : {};
    const settings = deepMerge(structuredClone(DEFAULT_SETTINGS), d.settings);
    if (!settings.notify.ntfy.topic) settings.notify.ntfy.topic = `flipradar-${randomId(14)}`;
    if (!['auto', 'fast', 'browser'].includes(settings.engine)) settings.engine = 'auto';
    return {
      version: 1,
      settings,
      watches: Array.isArray(d.watches) ? d.watches : [],
      listings: d.listings && typeof d.listings === 'object' ? d.listings : {},
      comps: Array.isArray(d.comps) ? d.comps : [],
      aiUsage: d.aiUsage && typeof d.aiUsage === 'object' ? d.aiUsage : null,
      facebook: d.facebook && typeof d.facebook === 'object' ? d.facebook : { connected: false },
    };
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 800);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      writeAtomic(this.file, JSON.stringify(this.data));
    } catch (e) {
      log.error(`Could not save ${this.file}: ${e.message}`);
    }
  }

  get settings() {
    return this.data.settings;
  }

  get watches() {
    return this.data.watches;
  }

  get listings() {
    return this.data.listings;
  }

  getWatch(id) {
    return this.data.watches.find((w) => w.id === id) || null;
  }

  addWatch(fields) {
    const now = Date.now();
    const w = {
      id: randomId(10),
      name: '',
      query: '',
      location: '',
      category: '',
      minPrice: null,
      maxPrice: null,
      radius: null,
      extraParams: {},
      include: [],
      exclude: [],
      intervalSec: 180,
      alertMode: 'deals',
      alertDrops: true,
      resaleValue: null,
      sellOn: 'local',
      shipCost: null,
      enabled: true,
      mute: false,
      createdAt: now,
      baselineAt: null,
      lastScanAt: null,
      nextScanAt: now,
      failCount: 0,
      scanCount: 0,
      foundCount: 0,
      lastStatus: null,
      ...fields,
    };
    this.data.watches.push(w);
    this.save();
    return w;
  }

  updateWatch(id, fields) {
    const w = this.getWatch(id);
    if (!w) return null;
    const searchChanged = SEARCH_FIELDS.some((k) => k in fields && JSON.stringify(fields[k]) !== JSON.stringify(w[k]));
    Object.assign(w, fields);
    if (searchChanged) {
      // New search = new baseline, so we do not alert on everything it now matches.
      w.baselineAt = null;
      w.nextScanAt = Date.now();
      w.failCount = 0;
    }
    if (fields.enabled === true) w.nextScanAt = Math.min(w.nextScanAt || Date.now(), Date.now());
    this.save();
    return w;
  }

  removeWatch(id) {
    const i = this.data.watches.findIndex((w) => w.id === id);
    if (i === -1) return false;
    this.data.watches.splice(i, 1);
    for (const [lid, l] of Object.entries(this.data.listings)) {
      l.watchIds = (l.watchIds || []).filter((x) => x !== id);
      if (!l.watchIds.length && !l.saved) delete this.data.listings[lid];
    }
    this.save();
    return true;
  }

  /** Newest first. Always includes saved listings so the Saved tab is complete. */
  recent({ limit = 400, before = Infinity } = {}) {
    const all = Object.values(this.data.listings).filter((l) => !l.hidden);
    const page = all
      .filter((l) => sortKey(l) < before)
      .sort((a, b) => sortKey(b) - sortKey(a))
      .slice(0, limit);
    if (before === Infinity) {
      const ids = new Set(page.map((l) => l.id));
      for (const l of all) if (l.saved && !ids.has(l.id)) page.push(l);
    }
    return page;
  }

  /** Remember a listing's asking price for future comparisons. `junk` ones (broken, replicas...) are kept out. */
  addComp(l, { junk = false, now = Date.now() } = {}) {
    if (!(l.price > 1)) return;
    const i = this.data.comps.findIndex((c) => c.id === l.id);
    const entry = { id: l.id, title: l.title, price: l.price, at: now, junk };
    if (i === -1) this.data.comps.push(entry);
    else this.data.comps[i] = { ...this.data.comps[i], price: l.price, junk };
  }

  /** Prices seen in the last 30 days, for the "what does it resell for" estimate. */
  compsPool(now = Date.now()) {
    return this.data.comps.filter((c) => !c.junk && now - c.at < COMPS_WINDOW_MS);
  }

  prune(now = Date.now()) {
    const before = this.data.comps.length;
    this.data.comps = this.data.comps.filter((c) => now - c.at < COMPS_KEEP_MS).slice(-MAX_COMPS);
    const entries = Object.values(this.data.listings);
    let removed = before - this.data.comps.length;
    for (const l of entries) {
      if (!l.saved && now - (l.lastSeenAt || l.firstSeenAt || 0) > KEEP_MS) {
        delete this.data.listings[l.id];
        removed++;
      }
    }
    const left = Object.values(this.data.listings).filter((l) => !l.saved);
    if (left.length > MAX_LISTINGS) {
      left.sort((a, b) => (a.firstSeenAt || 0) - (b.firstSeenAt || 0));
      for (const l of left.slice(0, left.length - MAX_LISTINGS)) {
        delete this.data.listings[l.id];
        removed++;
      }
    }
    if (removed) this.save();
    return removed;
  }
}
