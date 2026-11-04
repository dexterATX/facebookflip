// Decides whether a listing is worth flipping.
//
// Every listing ends up in one of two piles:
//   deals    - worth acting on now (these alert you)
//   unsorted - everything else, kept with the reason, in case the call was wrong
// Nothing is thrown away.
//
// How it decides, in the order a reseller would:
//   1. Red flags: broken / for parts, locked phones, "wanted" posts, replicas,
//      rentals, box-only, scam payment wording. Negations like "not broken"
//      don't count.
//   2. Resale value: your own number for the watch if you gave one; otherwise
//      what similar listings ask (titles sharing words beyond the search
//      words), discounted to what things actually sell for after haggling;
//      optionally checked by an AI second opinion.
//   3. Profit: resale - price - selling fees (eBay ~13.6% + $0.40 + shipping,
//      or none for local) - your other costs (gas, cleaning, time).
//   4. Verdict: a deal needs enough profit, enough margin, no blocking red
//      flag, and at least medium confidence. Unsure means unsorted.

import { norm, titleWords, quantile } from './deals.js';
import { median, clamp } from './util.js';

// eBay's final value fee for most categories. Published figures in 2026 range
// from 12.9% to 13.6% plus a per-order fee; we use the higher one to stay
// conservative. Check your own fee page in eBay Seller Hub.
export const EBAY_FEE_PCT = 13.6;
export const EBAY_FEE_FIXED = 0.4;

export const DEFAULT_DEAL_RULES = {
  minProfit: 40, // dollars left after fees and costs
  minMarginPct: 25, // profit as a share of the resale price
  otherCosts: 10, // gas, cleaning, your time, per flip
  askToSalePct: 90, // Marketplace asking prices usually sell a bit lower
  readDetails: true, // open the full listing (description, condition) for possible deals
};

const CONF = ['low', 'medium', 'high'];
const raise = (c) => CONF[Math.min(2, CONF.indexOf(c) + 1)];
const lower = (c) => CONF[Math.max(0, CONF.indexOf(c) - 1)];
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------------
// Red flags

// [kind, code, label, phrases, options]. Phrases match whole words in the
// title and description. kind: block = never a deal; warn = a deal can still
// happen but look closer; info = context. titleOnly rules ignore the
// description, where the same words are often innocent ("looking for a new
// home", "each drawer...").
const FLAG_RULES = [
  ['block', 'parts', 'Not working / for parts', ['for parts', 'parts only', 'not working', 'doesnt work', 'doesn t work', 'does not work', 'dont work', 'don t work', 'broken', 'wont turn on', 'won t turn on', 'will not turn on', 'doesnt turn on', 'doesn t turn on', 'does not turn on', 'no power', 'needs repair', 'water damage', 'water damaged', 'cracked screen', 'screen cracked', 'shattered', 'dead pixels', 'parts or repair']],
  ['block', 'locked', 'Locked or blacklisted device', ['icloud locked', 'icloud lock', 'activation lock', 'activation locked', 'blacklisted', 'bad imei', 'bad esn', 'google locked', 'frp locked', 'account locked']],
  ['block', 'wanted', 'A "wanted" post, not a sale', ['iso', 'in search of', 'looking for', 'wtb', 'want to buy', 'wanted'], { titleOnly: true }],
  ['block', 'fake', 'Possible replica', ['replica', 'rep', '1to1', 'aaa quality', 'dupe', 'knockoff', 'knock off', 'not authentic', 'unauthentic', 'fake', 'counterfeit']],
  ['block', 'notsale', 'Rent, lease or payment plan, not a sale price', ['for rent', 'for lease', 'lease takeover', 'take over lease', 'take over payments', 'rent to own', 'per month', 'monthly payment', 'monthly payments', 'down payment', 'trade only']],
  ['block', 'accessory', 'Accessory or box only', ['box only', 'empty box', 'case only', 'cover only', 'manual only', 'stand only', 'skin only', 'controller only', 'remote only', 'charger only', 'cable only', 'just the box', 'only the box']],
  ['warn', 'scamtalk', 'Payment or shipping wording common in scams', ['zelle', 'cash app', 'cashapp', 'venmo only', 'paypal friends', 'friends and family', 'deposit', 'shipping only', 'ship only', 'pay first', 'gift card', 'western union', 'wire transfer', 'crypto']],
  ['warn', 'carrier', 'Carrier-locked phone', ['carrier locked', 'sim locked', 'network locked']],
  ['warn', 'wear', 'Has wear or missing pieces', ['as is', 'scratches', 'scratched', 'dent', 'dented', 'dents', 'stain', 'stained', 'stains', 'tear', 'torn', 'missing', 'no charger', 'needs battery', 'needs work', 'chipped', 'cracked', 'crack', 'cracks', 'damage', 'damaged', 'fair condition', 'rough']],
  ['warn', 'inspired', '"Inspired" / unbranded version', ['inspired', 'unbranded', 'off brand']],
  ['warn', 'financing', 'Dealer or financing listing: the price may be a down payment', ['financing', 'financing available', 'buy here pay here']],
  ['warn', 'perunit', 'Price may be per item', ['each', 'per piece', 'price per', 'per item', 'per unit'], { titleOnly: true }],
  ['info', 'lot', 'Several items in one listing', ['lot', 'bundle', 'set of'], { titleOnly: true }],
].map(([kind, code, label, phrases, opts = {}]) => ({ kind, code, label, ...opts, phrases: phrases.map((p) => norm(p).trim().split(' ')) }));

// A phrase doesn't count when followed by these words ("broken in" glove).
const EXCEPT_NEXT = { broken: ['in'], rough: ['in'], dent: ['free'], tear: ['down'] };

const NEGATORS = new Set(['no', 'not', 'never', 'nothing', 'without', 'zero', 'isnt', 'isn', 'wasnt', 'wasn', 'none']);
const ACCESSORY_NOUNS = ['box', 'case', 'cover', 'manual', 'stand', 'skin', 'controller', 'remote', 'charger', 'cable'];

/** Splits text into word tokens, keeping sentence/comma breaks as "|" so negation doesn't leak across them. */
function tokenize(text) {
  return String(text || '')
    .replace(/\b1\s*:\s*1\b/g, ' 1to1 ')
    .replace(/[.,;:!?\n\r()[\]{}]+/g, ' | ')
    .split('|')
    .flatMap((chunk, i) => [...(i ? ['|'] : []), ...norm(chunk).trim().split(' ').filter(Boolean)]);
}

function phraseAt(tokens, i, phrase) {
  for (let k = 0; k < phrase.length; k++) if (tokens[i + k] !== phrase[k]) return false;
  return true;
}

function negated(tokens, i) {
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
    if (tokens[k] === '|') return false;
    if (NEGATORS.has(tokens[k])) return true;
  }
  return false;
}

/**
 * Red flags in a listing's text. `searchWords` are the watch's own words: an
 * accessory flag is skipped when you are searching for that accessory.
 */
export function findFlags(title, description = '', searchWords = []) {
  const titleTokens = tokenize(title);
  const allTokens = description ? [...titleTokens, '|', ...tokenize(description)] : titleTokens;
  const searching = new Set(searchWords.flatMap((w) => norm(w).trim().split(' ')).filter(Boolean));
  const out = [];
  for (const rule of FLAG_RULES) {
    const tokens = rule.titleOnly ? titleTokens : allTokens;
    let hit = null;
    for (let i = 0; i < tokens.length && !hit; i++) {
      for (const phrase of rule.phrases) {
        const next = tokens[i + phrase.length];
        if (phraseAt(tokens, i, phrase) && !negated(tokens, i) && !(phrase.length === 1 && EXCEPT_NEXT[phrase[0]]?.includes(next))) {
          if (rule.code === 'accessory' && phrase.some((w) => ACCESSORY_NOUNS.includes(w) && searching.has(w))) continue;
          hit = phrase.join(' ');
          break;
        }
      }
    }
    if (hit) out.push({ kind: rule.kind, code: rule.code, text: `${rule.label} ("${hit}")` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resale value from similar listings

/**
 * Estimates what this item resells for, from prices of similar listings.
 * `pool` is [{ id, title, price }] of listings seen recently.
 */
/** Listings in `pool` whose titles share meaningful words with this one (beyond the search words). */
export function similarComps(listing, pool, searchWords = []) {
  const skip = new Set(searchWords.flatMap((w) => [...titleWords(w)]));
  const minus = (set) => new Set([...set].filter((w) => !skip.has(w)));
  const mine = minus(titleWords(listing.title));
  if (!mine.size) return [];
  return pool.filter((o) => {
    if (o.id === listing.id || !(o.price > 1)) return false;
    const theirs = minus(titleWords(o.title));
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    // Two words in common, or at least half of this (short) title's words.
    return shared >= 2 || (shared >= 1 && shared / mine.size >= 0.5);
  });
}

export function compsEstimate(listing, pool, { searchWords = [], askToSalePct = DEFAULT_DEAL_RULES.askToSalePct } = {}) {
  const others = pool.filter((o) => o.id !== listing.id && o.price > 1);

  let basis = null;
  let kind = null;
  let similarCount = 0;
  {
    const comps = similarComps(listing, others, searchWords);
    similarCount = comps.length;
    if (comps.length >= 3) {
      basis = comps.map((o) => o.price);
      kind = 'similar';
    }
  }
  if (!basis && others.length >= 8) {
    // Not enough look-alikes: the whole search only counts if its prices are tightly grouped.
    const xs = others.map((o) => o.price).sort((a, b) => a - b);
    const med = median(xs);
    if (med && (quantile(xs, 0.75) - quantile(xs, 0.25)) / med <= 0.5) {
      basis = xs;
      kind = 'search';
    }
  }
  if (!basis) return { value: null, n: similarCount };

  let xs = [...basis].sort((a, b) => a - b);
  if (xs.length >= 10) xs = xs.slice(Math.floor(xs.length * 0.1), Math.ceil(xs.length * 0.9)); // trim outliers
  const med = median(xs);
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const spread = med ? (q3 - q1) / med : 1;
  let confidence;
  if (kind === 'search') confidence = 'medium';
  else if (xs.length >= 8 && spread <= 0.5) confidence = 'high';
  else if (xs.length >= 4 || (xs.length === 3 && spread <= 0.3)) confidence = 'medium'; // 3 tightly grouped prices are decent evidence
  else confidence = 'low';
  if (spread > 0.8) confidence = lower(confidence);
  const r = askToSalePct / 100;
  return { value: med * r, low: q1 * r, high: q3 * r, askMedian: med, n: xs.length, spread, confidence, kind };
}

// ---------------------------------------------------------------------------
// The verdict

/**
 * @param listing  normalized listing (title, price, ...)
 * @param ctx.watch     the watch (query, include, resaleValue, sellOn, shipCost)
 * @param ctx.rules     deal rules (see DEFAULT_DEAL_RULES)
 * @param ctx.pool      recent listings [{id,title,price}] for comparisons
 * @param ctx.details   { description, condition } from the full listing, if read
 * @param ctx.ai        AI second opinion, if any
 */
export function evaluate(listing, { watch = {}, rules = {}, pool = [], details = null, ai = null } = {}) {
  const r = { ...DEFAULT_DEAL_RULES, ...rules };
  const searchWords = [watch.query || '', ...(watch.include || [])];
  const flags = findFlags(listing.title, details?.description || '', searchWords);
  if (details?.condition && /fair|poor|parts/i.test(details.condition)) {
    flags.push({ kind: 'warn', code: 'condition', text: `Seller lists the condition as "${details.condition}"` });
  }
  const notes = [];

  const price = listing.price ?? null;

  // Resale value
  let est = null;
  if (watch.resaleValue > 0) {
    est = { value: watch.resaleValue, low: watch.resaleValue, high: watch.resaleValue, confidence: 'high', basis: 'your resale price for this watch' };
    // A watch-wide price can't fit everything a search turns up (a $45 controller
    // in a PS5 search). If look-alikes clearly sell for much less, trust them.
    const c = compsEstimate(listing, pool, { searchWords, askToSalePct: r.askToSalePct });
    const confirmed = c.value && c.confidence !== 'low';
    if (confirmed && c.askMedian < watch.resaleValue * 0.5) {
      est = { value: c.value, low: c.low, high: c.high, confidence: c.confidence, basis: `${c.n} similar listings (asking ~${money(c.askMedian)})` };
      notes.push({ kind: 'warn', code: 'mismatch', text: `Similar listings ask ~${money(c.askMedian)}, far below your ${money(watch.resaleValue)} resale price: this is probably an accessory or a different model` });
    } else if (!confirmed && price !== null && price < watch.resaleValue * 0.35) {
      // Way under your number with nothing to confirm it's the same item: more
      // often an accessory, another model or a scam than a steal. Look first.
      est.confidence = 'low';
      notes.push({
        kind: 'warn',
        code: 'checkitem',
        short: 'Far under your resale price: check it is the same item',
        text: `Priced at ${Math.round((price / watch.resaleValue) * 100)}% of your ${money(watch.resaleValue)} resale price, and no similar listings confirm it's the same item. It could be an accessory, a different model, or a scam.`,
      });
    }
  } else {
    const c = compsEstimate(listing, pool, { searchWords, askToSalePct: r.askToSalePct });
    if (c.value) {
      est = {
        value: c.value,
        low: c.low,
        high: c.high,
        confidence: c.confidence,
        basis: c.kind === 'similar' ? `${c.n} similar listings (asking ~${money(c.askMedian)})` : `${c.n} listings in this search (asking ~${money(c.askMedian)})`,
      };
    } else if (c.n) {
      notes.push({ kind: 'info', code: 'fewcomps', text: `Only ${c.n} similar listing${c.n === 1 ? '' : 's'} seen so far` });
    }
  }

  // AI second opinion
  let aiView = null;
  if (ai && ai.ok && ai.low > 0 && ai.high >= ai.low) {
    const mid = (ai.low + ai.high) / 2;
    aiView = { item: ai.item, condition: ai.condition, low: ai.low, high: ai.high, confidence: ai.confidence, verdict: ai.verdict, reason: ai.reason, model: ai.model };
    if (est && !(watch.resaleValue > 0)) {
      if (mid >= est.value * 0.8 && mid <= est.value * 1.25) {
        est.confidence = raise(est.confidence);
        notes.push({ kind: 'good', code: 'ai-agrees', text: `AI agrees: resells for ${money(ai.low)}–${money(ai.high)}` });
      } else {
        // Disagreement: trust the lower number and be less sure.
        est.confidence = lower(est.confidence);
        if (mid < est.value) est = { ...est, value: mid, low: ai.low, high: ai.high };
        notes.push({ kind: 'warn', code: 'ai-disagrees', text: `AI says it resells for ${money(ai.low)}–${money(ai.high)}, which doesn't match similar listings` });
      }
    } else if (!est) {
      // AI alone is never "high" confidence.
      est = { value: mid, low: ai.low, high: ai.high, confidence: ai.confidence === 'high' ? 'medium' : 'low', basis: `AI estimate (${ai.item || 'item'})` };
    }
    if (ai.condition === 'for parts') flags.push({ kind: 'block', code: 'ai-parts', text: 'AI reads this as for parts / not working' });
    else if (ai.condition === 'poor') flags.push({ kind: 'warn', code: 'ai-poor', text: 'AI reads the condition as poor' });
    for (const f of (ai.redFlags || []).slice(0, 3)) flags.push({ kind: 'warn', code: 'ai-flag', text: `AI: ${f}` });
    if (ai.verdict === 'avoid' && ai.confidence !== 'low') flags.push({ kind: 'block', code: 'ai-avoid', text: `AI says avoid: ${ai.reason || 'see notes'}` });
  }

  const base = { flags, notes, ai: aiView, price, checkedAt: Date.now(), detailsRead: Boolean(details) };
  const blockers = flags.filter((f) => f.kind === 'block');

  if (price === null || price === undefined) {
    return finish({ ...base, verdict: 'unsorted', headline: 'No price listed', confidence: 'low', resale: est });
  }
  if (!est) {
    return finish({
      ...base,
      verdict: 'unsorted',
      headline: blockers[0]?.text || 'Not enough price info yet to judge',
      confidence: 'low',
      resale: null,
      hint: 'Add a "resells for" price to this watch, or turn on the AI second opinion in Settings.',
    });
  }

  const ebay = watch.sellOn === 'ebay';
  const fees = ebay ? (est.value * EBAY_FEE_PCT) / 100 + EBAY_FEE_FIXED + (Number(watch.shipCost) || 0) : 0;
  const profit = est.value - price - fees - r.otherCosts;
  const margin = est.value > 0 ? profit / est.value : 0;

  // Too good to be true? (Skipped when we aren't even sure it's the same item.)
  const checkItem = notes.find((n) => n.code === 'checkitem');
  if (price > 0 && est.value >= 80 && !checkItem) {
    const ratio = price / est.value;
    const scamTalk = flags.some((f) => f.code === 'scamtalk');
    const off = Math.round((1 - ratio) * 100);
    if (ratio < 0.12 || (scamTalk && ratio < 0.4)) {
      flags.push({ kind: 'block', code: 'scam', text: `Likely scam: ${off}% under what it resells for${scamTalk ? ', plus scam-style payment wording' : ''}` });
    } else if (ratio < 0.25) {
      flags.push({ kind: 'warn', code: 'toocheap', text: `${off}% under resale value: could be a scam or a pricing mistake. See it in person before paying.` });
    }
  }

  const blocked = flags.some((f) => f.kind === 'block');
  const enoughProfit = profit >= r.minProfit;
  const enoughMargin = margin * 100 >= r.minMarginPct;
  const sure = est.confidence !== 'low';
  const verdict = !blocked && enoughProfit && enoughMargin && sure ? 'deal' : 'unsorted';

  let headline;
  if (verdict === 'deal') headline = `+${money(profit)} profit (${Math.round(margin * 100)}% margin)`;
  else if (blocked) headline = flags.find((f) => f.kind === 'block').text;
  else if (!enoughProfit || !enoughMargin) headline = profit > 0 ? `Only +${money(profit)} profit (${Math.round(margin * 100)}%)` : `Priced above resale (~${money(est.value)})`;
  else headline = checkItem?.short || 'Looks cheap, but not enough data to be sure';

  const weight = { high: 1, medium: 0.85, low: 0.6 }[est.confidence];
  const score = Math.round((clamp(margin, 0, 1) * 70 + clamp(profit / 200, 0, 1) * 30) * weight);
  return finish({
    ...base,
    verdict,
    headline,
    confidence: est.confidence,
    resale: est,
    fees,
    otherCosts: r.otherCosts,
    profit,
    margin,
    score,
    sellOn: ebay ? 'ebay' : 'local',
    rules: { minProfit: r.minProfit, minMarginPct: r.minMarginPct },
  });
}

function finish(e) {
  const reasons = [];
  if (e.resale) {
    reasons.push({ kind: 'info', text: `Resells for about ${money(e.resale.value)} (${e.resale.basis}; ${e.confidence} confidence)` });
  }
  if (typeof e.profit === 'number') {
    const parts = [`${money(e.resale.value)} resale`, `− ${money(e.price)} price`];
    if (e.fees) parts.push(`− ${money(e.fees)} eBay fees & shipping`);
    if (e.otherCosts) parts.push(`− ${money(e.otherCosts)} other costs`);
    const ok = e.profit >= e.rules.minProfit && e.margin * 100 >= e.rules.minMarginPct;
    reasons.push({
      kind: ok ? 'good' : 'warn',
      text: `${parts.join(' ')} = ${e.profit >= 0 ? '+' : '−'}${money(Math.abs(e.profit))} (${Math.round(e.margin * 100)}% margin; you want ${money(e.rules.minProfit)}+ and ${e.rules.minMarginPct}%+)`,
    });
    if (e.confidence === 'low') reasons.push({ kind: 'warn', text: 'Not enough comparable listings to be sure about the resale price' });
  }
  for (const f of e.flags) reasons.push({ kind: f.kind, text: f.text });
  for (const n of e.notes) reasons.push({ kind: n.kind, text: n.text });
  if (e.ai?.reason) reasons.push({ kind: 'info', text: `AI note: ${e.ai.reason}` });
  if (e.hint) reasons.push({ kind: 'info', text: e.hint });
  const order = { block: 0, warn: 1, good: 2, info: 3 };
  reasons.sort((a, b) => order[a.kind] - order[b.kind]);
  if (e.resale) {
    e.resale = {
      value: Math.round(e.resale.value),
      low: Math.round(e.resale.low),
      high: Math.round(e.resale.high),
      basis: e.resale.basis,
    };
  }
  if (typeof e.profit === 'number') {
    e.profit = Math.round(e.profit);
    e.fees = Math.round(e.fees * 100) / 100;
    e.margin = Math.round(e.margin * 1000) / 1000;
  }
  delete e.notes;
  return { ...e, reasons };
}

/**
 * Worth a closer look (reading the full listing, asking the AI)? Anything not
 * already ruled out that is close to profitable, or that we can't price yet.
 */
export function isCandidate(ev, rules = {}) {
  const r = { ...DEFAULT_DEAL_RULES, ...rules };
  if (!ev || ev.price === null || ev.flags.some((f) => f.kind === 'block')) return false;
  if (typeof ev.profit !== 'number') return true; // can't price it yet
  return ev.profit >= r.minProfit * 0.6;
}
