// The heart of the app: checks every watch on its own schedule, figures out
// which listings are genuinely new, judges each one, and raises alerts.
//
// Rules that keep it fast without getting you blocked:
//  - Only one check runs at a time, with a randomized gap between checks.
//  - Each watch's interval is randomized by ±20%.
//  - Failures back off (2x, 4x, ... up to 30 min). If Facebook rate-limits or
//    asks for a login, every watch pauses instead of hammering it.
//  - The first check of a watch only alerts on listings posted within the
//    alert window; everything older is recorded quietly as the baseline.
//
// Judging a listing (see evaluate.js) happens in two steps:
//  1. Right away, from the title, price and similar listings.
//  2. For anything promising, a closer look: the full listing page
//     (description, condition) and, if turned on, an AI second opinion.
//     Deal alerts go out after this step, a few seconds later.
// Every listing lands in the "deals" or the "unsorted" pile. Nothing is dropped.

import { EventEmitter } from 'node:events';
import { buildSearchUrl } from './facebook/urls.js';
import { filterReason } from './deals.js';
import { evaluate, isCandidate, similarComps, findFlags } from './evaluate.js';
import { median } from './util.js';
import { jitter, clamp, log } from './util.js';

const GAP_MS = 6000; // default pause between two Facebook checks
const MAX_BACKOFF_MS = 30 * 60e3;
const LOG_SIZE = 120;
const DETAILS_PER_HOUR = 40; // full-listing reads, on top of searches

export function inQuietHours(q, date = new Date()) {
  if (!q?.enabled || q.start === q.end) return false;
  const h = date.getHours();
  return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

export const pileOf = (l) => l.pileOverride || l.pile || 'unsorted';

export class Monitor extends EventEmitter {
  constructor({ store, fb, notifier, ai = null, fbBase = 'https://www.facebook.com', gapMs = GAP_MS }) {
    super();
    this.gapMs = gapMs;
    this.store = store;
    this.fb = fb;
    this.notifier = notifier;
    this.ai = ai;
    this.fbBase = fbBase;
    this.busy = false;
    this.current = null;
    this.lastScanEnd = 0;
    this.gap = 0;
    this.queue = [];
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.rateLimitStreak = 0;
    this.problem = null; // { code, message, at } shown as a banner
    this.logs = [];
    this.timer = null;
    this.deepQueue = [];
    this.deepRunning = false;
    this.deepCurrent = null; // id of the listing getting a closer look right now
    this.detailTimes = [];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Drop pending closer looks so nothing touches Facebook (or relaunches the browser) during shutdown.
    this.stopped = true;
    this.deepQueue.length = 0;
  }

  checksPerHour() {
    return Math.round(
      this.store.watches.filter((w) => w.enabled).reduce((sum, w) => sum + 3600 / clamp(w.intervalSec || 180, 60, 3600), 0),
    );
  }

  get status() {
    const now = Date.now();
    const enabled = this.store.watches.filter((w) => w.enabled);
    let state = 'running';
    if (!enabled.length) state = 'idle';
    else if (now < this.cooldownUntil) state = 'cooldown';
    else if (inQuietHours(this.store.settings.quietHours)) state = 'quiet';
    const next = enabled.reduce((m, w) => Math.min(m, w.nextScanAt || now), Infinity);
    return {
      state,
      scanning: this.current,
      nextScanAt: Number.isFinite(next) ? Math.max(next, this.lastScanEnd + this.gap, this.cooldownUntil) : null,
      lastScanAt: this.lastScanEnd || null,
      cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : null,
      cooldownReason: this.cooldownUntil > now ? this.cooldownReason : null,
      checksPerHour: this.checksPerHour(),
      problem: this.problem,
      checkingDeals: this.deepQueue.length + (this.deepRunning ? 1 : 0),
    };
  }

  emitStatus() {
    this.emit('status', this.status);
  }

  /** Run a watch as soon as possible (the "Check now" button). */
  scanNow(id) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.tick();
  }

  clearCooldown() {
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.emitStatus();
  }

  pickNext(now) {
    while (this.queue.length) {
      const w = this.store.getWatch(this.queue.shift());
      if (w) return { watch: w, manual: true };
    }
    if (now < this.cooldownUntil || inQuietHours(this.store.settings.quietHours)) return null;
    const due = this.store.watches
      .filter((w) => w.enabled && (w.nextScanAt || 0) <= now)
      .sort((a, b) => (a.nextScanAt || 0) - (b.nextScanAt || 0));
    return due.length ? { watch: due[0], manual: false } : null;
  }

  tick() {
    if (this.busy) return;
    const now = Date.now();
    if (now - this.lastScanEnd < this.gap) return;
    const pick = this.pickNext(now);
    if (!pick) return;
    this.busy = true;
    this.scan(pick.watch, pick)
      .catch((e) => log.error(`Check failed for "${pick.watch.name}": ${e.stack || e.message}`))
      .finally(() => {
        this.busy = false;
        this.current = null;
        this.lastScanEnd = Date.now();
        this.gap = jitter(this.gapMs, 0.5);
        this.emitStatus();
      });
  }

  setCooldown(ms, reason) {
    this.cooldownUntil = Date.now() + ms;
    this.cooldownReason = reason;
  }

  addLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > LOG_SIZE) this.logs.splice(0, this.logs.length - LOG_SIZE);
    this.emit('log', entry);
  }

  // -------------------------------------------------------------------------
  // Judging

  watchFor(l) {
    for (const id of l.watchIds || []) {
      const w = this.store.getWatch(id);
      if (w) return w;
    }
    return null;
  }

  /** Quick judgment from what we already know (no network). Updates l.eval and l.pile. */
  judge(l, watch = this.watchFor(l), pool = this.store.compsPool()) {
    if (!watch) return l.eval;
    l.filtered = filterReason(l, watch, this.store.settings);
    if (l.filtered) {
      l.eval = { verdict: 'unsorted', headline: l.filtered, confidence: 'low', flags: [], reasons: [{ kind: 'block', text: l.filtered }], checkedAt: Date.now(), price: l.price ?? null };
    } else {
      l.eval = evaluate(l, { watch, rules: this.store.settings.deals, pool, details: l.details, ai: l.ai });
    }
    if (l.sold || l.pending) {
      l.eval = { ...l.eval, verdict: 'unsorted', headline: l.sold ? 'Already sold' : 'Sale pending' };
    }
    l.pile = l.eval.verdict === 'deal' ? 'deals' : 'unsorted';
    return l.eval;
  }

  /**
   * Every deal is kept: saved (so the cleanup never deletes it) and added to
   * the deals spreadsheet. A deal waiting for its closer look is kept only
   * after it passes, so one the full listing rules out is never saved. Runs
   * once per listing: if you un-star it, it stays un-starred.
   */
  keepIfDeal(l, watch = this.watchFor(l), { afterCloserLook = false } = {}) {
    if (pileOf(l) !== 'deals' || l.hidden || l.dealSavedAt) return false;
    if (!afterCloserLook && (this.deepCurrent === l.id || this.deepQueue.some((j) => j.id === l.id))) return false;
    const added = this.store.saveDeal(l, { watch: watch?.name || '' });
    if (added) this.emit('dealsLogged', this.store.dealsLogged());
    return true;
  }

  /** Re-judge stored listings after rules or a watch change (no network). */
  reevaluate(watchId = null) {
    const pool = this.store.compsPool();
    let n = 0;
    for (const l of Object.values(this.store.listings)) {
      if (watchId && !(l.watchIds || []).includes(watchId)) continue;
      this.judge(l, this.watchFor(l), pool);
      this.keepIfDeal(l);
      n++;
    }
    if (n) this.store.save();
    return n;
  }

  deepOn() {
    return Boolean(this.store.settings.deals.readDetails || this.ai?.enabled());
  }

  enqueueDeep(l, watch, alertEligible) {
    if (this.stopped || this.deepQueue.some((j) => j.id === l.id)) return;
    this.deepQueue.push({ id: l.id, watchId: watch.id, alertEligible });
    this.runDeep();
  }

  async runDeep() {
    if (this.deepRunning) return;
    this.deepRunning = true;
    this.emitStatus();
    try {
      while (this.deepQueue.length && !this.stopped) {
        const job = this.deepQueue.shift();
        this.deepCurrent = job.id;
        await this.deepCheck(job).catch((e) => log.warn(`Closer look failed: ${e.message}`));
        this.deepCurrent = null;
      }
    } finally {
      this.deepRunning = false;
      this.emitStatus();
    }
  }

  detailBudget(now = Date.now()) {
    this.detailTimes = this.detailTimes.filter((t) => now - t < 3600e3);
    return this.detailTimes.length < DETAILS_PER_HOUR;
  }

  compsSummary(l, watch) {
    const comps = similarComps(l, this.store.compsPool(), [watch.query || '', ...(watch.include || [])]);
    if (!comps.length) return null;
    const prices = comps.map((c) => c.price).sort((a, b) => a - b);
    return {
      n: prices.length,
      median: median(prices),
      low: prices[0],
      high: prices[prices.length - 1],
      examples: comps.slice(-6).map((c) => ({ title: c.title, price: c.price })),
    };
  }

  /** The closer look: read the full listing, maybe ask the AI, then decide and alert. */
  async deepCheck(job) {
    const l = this.store.listings[job.id];
    const watch = this.store.getWatch(job.watchId);
    if (!l || !watch || l.hidden) return;
    const rules = this.store.settings.deals;
    if (rules.readDetails && !l.details && !l.detailsError && this.detailBudget()) {
      this.detailTimes.push(Date.now());
      const r = await this.fb.fetchItem(l.id);
      if (r.ok) {
        l.details = r.details;
        if (r.details.sold) l.sold = true;
        if (r.details.pending) l.pending = true;
      } else {
        l.detailsError = r.message;
      }
    }
    let ev = this.judge(l, watch);
    if (this.ai?.enabled() && !l.ai && !l.sold && !l.pending && isCandidate(ev, rules)) {
      if (this.ai.hasBudget()) {
        const opinion = await this.ai.assess(l, { details: l.details, compsSummary: this.compsSummary(l, watch), sellOn: watch.sellOn });
        if (opinion.ok) {
          l.ai = opinion;
          delete l.aiError;
        } else {
          l.aiError = opinion.message;
        }
        ev = this.judge(l, watch);
      } else {
        l.aiError = 'Daily AI check limit reached';
      }
    }
    l.deepCheckedAt = Date.now();
    this.keepIfDeal(l, watch, { afterCloserLook: true });
    this.store.save();
    this.emit('updates', [l]);
    if (job.alertEligible && pileOf(l) === 'deals' && !l.alertedAt) this.alert(watch, [l], []);
    return ev;
  }

  alert(watch, fresh, drops) {
    const now = Date.now();
    for (const l of [...fresh, ...drops]) l.alertedAt = now;
    this.store.save();
    this.emit('alert', [...fresh, ...drops]);
    this.notifier
      .sendListings(watch, fresh, drops)
      .catch((e) => log.warn(`Alert delivery failed: ${e.message}`))
      .finally(() => this.emit('notify', this.notifier.errors));
  }

  // -------------------------------------------------------------------------
  // Checking a watch

  async scan(watch, { manual = false } = {}) {
    this.current = watch.id;
    this.emitStatus();
    const url = buildSearchUrl(watch, this.fbBase);
    const res = await this.fb.search(url, { hadLocation: Boolean(watch.location) });
    const now = Date.now();
    const settings = this.store.settings;
    const intervalMs = clamp(watch.intervalSec || 180, 60, 3600) * 1000;

    if (!this.store.getWatch(watch.id)) return; // deleted while we were checking

    if (!res.ok) {
      watch.failCount = (watch.failCount || 0) + 1;
      watch.lastStatus = { ok: false, code: res.code, message: res.message, engine: res.engine, at: now, ms: res.ms };
      watch.lastScanAt = now;
      watch.nextScanAt = now + Math.min(intervalMs * 2 ** Math.min(watch.failCount, 5), MAX_BACKOFF_MS);
      if (res.code === 'RATE_LIMITED') {
        this.rateLimitStreak++;
        this.setCooldown(Math.min(20 * 60e3 * 2 ** (this.rateLimitStreak - 1), 2 * 3600e3), res.message);
      } else if (['LOGIN_REQUIRED', 'CHECKPOINT', 'NO_BROWSER', 'INELIGIBLE'].includes(res.code)) {
        this.setCooldown(10 * 60e3, res.message);
      }
      if (res.code !== 'EMPTY' && res.code !== 'NETWORK' && res.code !== 'BAD_LOCATION') {
        this.problem = { code: res.code, message: res.message, at: now };
      }
      this.addLog({ at: now, watchId: watch.id, watch: watch.name, engine: res.engine, fallbackFrom: res.fallbackFrom || null, code: res.code, message: res.message, ms: res.ms, found: 0, fresh: 0, manual, url });
      this.store.save();
      this.emit('watch', watch);
      return;
    }

    // Success: lift any pause caused by earlier trouble.
    this.rateLimitStreak = 0;
    if (this.cooldownUntil) this.clearCooldown();
    this.problem = null;
    watch.failCount = 0;

    const firstScan = !watch.baselineAt;
    const fresh = [];
    const drops = [];
    for (const item of res.listings) {
      if (item.sold || item.pending || item.hiddenOnFb || item.live === false) continue;
      const existing = this.store.listings[item.id];
      if (existing) {
        existing.lastSeenAt = now;
        if (!existing.watchIds.includes(watch.id)) existing.watchIds.push(watch.id);
        if (!existing.photo && item.photo) existing.photo = item.photo;
        if (!existing.creationTime && item.creationTime) existing.creationTime = item.creationTime;
        if (item.price != null && existing.price != null && item.price < existing.price - 0.009) {
          existing.prevPrice = existing.price;
          existing.prevPriceText = existing.priceText;
          existing.price = item.price;
          existing.priceText = item.priceText;
          existing.priceDroppedAt = now;
          drops.push(existing);
        }
        continue;
      }
      const ageMin = item.creationTime ? (now - item.creationTime) / 60000 : null;
      const listing = {
        ...item,
        watchIds: [watch.id],
        firstSeenAt: now,
        lastSeenAt: now,
        baseline: firstScan && !(ageMin !== null && ageMin <= settings.maxAlertAgeMin),
        saved: false,
        hidden: false,
        pile: 'unsorted',
        pileOverride: null,
        feedback: null,
        eval: null,
        details: null,
        ai: null,
      };
      this.store.listings[item.id] = listing;
      fresh.push(listing);
    }

    // Remember prices first so this batch counts as comparisons, then judge.
    // Junk (for parts, replicas, box only...) and your skip-word matches are
    // kept out of the comparisons so they can't drag the estimate down.
    const searchWords = [watch.query || '', ...(watch.include || [])];
    for (const l of [...fresh, ...drops]) {
      const junk = Boolean(filterReason(l, watch, settings)) || findFlags(l.title, '', searchWords).some((f) => f.kind === 'block');
      this.store.addComp(l, { junk, now });
    }
    const pool = this.store.compsPool(now);
    for (const l of [...fresh, ...drops]) {
      const ev = this.judge(l, this.watchFor(l) || watch, pool);
      if (ev.flags?.some((f) => f.kind === 'block')) this.store.addComp(l, { junk: true, now });
    }

    // Who gets an alert, and who gets a closer look first.
    const freshNow = [];
    let deep = 0;
    for (const l of fresh) {
      const eligible = !watch.mute && this.isFreshEnough(l, { firstScan, now });
      if (watch.alertMode === 'all') {
        if (eligible && !l.filtered) freshNow.push(l); // your skip words always win
        if (this.deepOn() && !l.baseline && isCandidate(l.eval, settings.deals)) {
          this.enqueueDeep(l, watch, false);
          deep++;
        }
      } else if (this.deepOn() && !l.filtered && isCandidate(l.eval, settings.deals) && (eligible || pileOf(l) === 'deals')) {
        this.enqueueDeep(l, watch, eligible);
        deep++;
      } else if (eligible && pileOf(l) === 'deals') {
        freshNow.push(l);
      }
    }
    // Keep every deal. (Ones getting a closer look are kept when it passes.)
    for (const l of [...fresh, ...drops]) this.keepIfDeal(l, watch);
    const dropAlerts =
      watch.mute || watch.alertDrops === false ? [] : drops.filter((l) => watch.alertMode === 'all' || pileOf(l) === 'deals');

    watch.baselineAt = watch.baselineAt || now;
    watch.lastScanAt = now;
    watch.scanCount = (watch.scanCount || 0) + 1;
    watch.foundCount = (watch.foundCount || 0) + (firstScan ? 0 : fresh.length);
    watch.nextScanAt = now + jitter(intervalMs, 0.2);
    const dealsFound = fresh.filter((l) => pileOf(l) === 'deals').length;
    watch.lastStatus = { ok: true, code: 'OK', message: res.message, engine: res.engine, at: now, ms: res.ms, results: res.listings.length, fresh: fresh.length, deals: dealsFound };
    this.addLog({ at: now, watchId: watch.id, watch: watch.name, engine: res.engine, fallbackFrom: res.fallbackFrom || null, code: 'OK', message: res.message, ms: res.ms, found: res.listings.length, fresh: fresh.length, deals: dealsFound, closer: deep, alerts: freshNow.length, manual, url });
    this.store.save();

    if (fresh.length) this.emit('listings', fresh);
    if (drops.length) this.emit('updates', drops);
    this.emit('watch', watch);
    if (freshNow.length || dropAlerts.length) this.alert(watch, freshNow, dropAlerts);
  }

  isFreshEnough(l, { firstScan, now }) {
    if (l.creationTime) return (now - l.creationTime) / 60000 <= this.store.settings.maxAlertAgeMin;
    return !firstScan; // no post time and nothing to compare with: treat as baseline
  }
}
