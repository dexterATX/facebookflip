// Optional AI second opinion on possible deals, using Claude.
//
// Only listings that already look promising get checked, and there is a daily
// cap, so this stays cheap. The AI identifies the exact item, reads the
// condition, estimates what it actually SELLS for, and lists red flags. The
// deal checker (evaluate.js) treats this as one opinion among others: it
// cross-checks it against similar listings and never trusts it alone at "high"
// confidence.

import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { log } from './util.js';

// Prices per million tokens (Anthropic first-party API).
export const AI_MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5: most accurate', inPerM: 4, outPerM: 20, fallback: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5: balanced', inPerM: 2, outPerM: 10, fallback: true },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5: cheapest', inPerM: 0.1, outPerM: 0.5, fallback: false },
};
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    item: { type: 'string', description: 'Exactly what is for sale: brand, model, size/storage/edition. Short.' },
    condition: { type: 'string', enum: ['new', 'like new', 'good', 'fair', 'poor', 'for parts', 'unknown'] },
    resale_low: { type: 'number', description: 'Low end of what this exact item in this condition SELLS for used in the US, in USD' },
    resale_high: { type: 'number', description: 'High end of the same range, in USD' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    red_flags: { type: 'array', items: { type: 'string' }, description: 'Concrete problems, each a few words. Empty if none.' },
    verdict: { type: 'string', enum: ['good deal', 'fair price', 'overpriced', 'avoid', 'not sure'] },
    reason: { type: 'string', description: 'One short sentence a reseller would find useful.' },
  },
  required: ['item', 'condition', 'resale_low', 'resale_high', 'confidence', 'red_flags', 'verdict', 'reason'],
  additionalProperties: false,
};

const SYSTEM = `You help a reseller decide whether a Facebook Marketplace listing is worth buying to resell.

For each listing:
- Identify exactly what the item is (brand, model, size, storage, edition) from the title, description and photo.
- Judge its condition from the description and photo.
- Estimate what this exact item, in this condition, typically SELLS for used in the US: completed sales on eBay or local marketplaces, not asking prices. Give a low-high range in USD.
- List concrete red flags: damage, missing parts, locked or blacklisted devices, replicas, scam signs (deposits, shipping-only, Zelle/gift-card payment, a price far below market).

Be conservative. If the listing is vague, or the item could be several things with very different values, widen the range and lower your confidence. Use "good deal" only when buying at the asking price clearly leaves profit after typical selling costs; "avoid" for scams, replicas, or broken items sold as working; "not sure" when you can't tell.`;

const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Anthropic must be able to download the photo itself, so skip local/demo URLs. */
function publicImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function buildPrompt(listing, { details, compsSummary, sellOn, now = Date.now() }) {
  const lines = ['Listing:', `Title: ${listing.title}`, `Asking price: ${listing.price === 0 ? 'Free' : listing.priceText || money(listing.price)}`];
  if (listing.locationText) lines.push(`Location: ${listing.locationText}`);
  if (listing.creationTime) lines.push(`Posted: ${Math.max(0, Math.round((now - listing.creationTime) / 60000))} minutes ago`);
  if (details?.condition) lines.push(`Seller's condition: ${details.condition}`);
  if (details?.description) lines.push(`Description: ${details.description.slice(0, 1500)}`);
  lines.push('');
  if (compsSummary?.n) {
    lines.push(
      `Asking prices of similar listings the buyer has seen recently: median ${money(compsSummary.median)} from ${compsSummary.n} listings (range ${money(compsSummary.low)}-${money(compsSummary.high)}).`,
    );
    if (compsSummary.examples?.length) lines.push(`Examples: ${compsSummary.examples.map((e) => `"${e.title}" ${money(e.price)}`).join('; ')}`);
  } else {
    lines.push('No comparable listings have been seen yet.');
  }
  lines.push(`The buyer plans to resell ${sellOn === 'ebay' ? 'on eBay (about 13.6% fees plus shipping)' : 'locally on Marketplace (no fees)'}.`);
  return lines.join('\n');
}

export class AiAdvisor {
  /** `clientFactory(apiKey)` lets tests swap in a fake client. */
  constructor({ store, clientFactory } = {}) {
    this.store = store;
    this.clientFactory = clientFactory || ((apiKey) => new Anthropic({ apiKey: apiKey || undefined, maxRetries: 1, timeout: 90_000 }));
    this.lastError = null;
  }

  get settings() {
    return this.store.settings.ai;
  }

  usage() {
    const u = this.store.data.aiUsage || {};
    return u.day === today() ? u : { day: today(), checks: 0, costUsd: 0 };
  }

  enabled() {
    return Boolean(this.settings.enabled && (this.settings.apiKey || process.env.ANTHROPIC_API_KEY));
  }

  hasBudget() {
    return this.usage().checks < (this.settings.maxPerDay || 0);
  }

  record(model, usage) {
    const u = this.usage();
    const price = AI_MODELS[model] || AI_MODELS[this.settings.model] || AI_MODELS[DEFAULT_AI_MODEL];
    const cost = ((usage?.input_tokens || 0) * price.inPerM + (usage?.output_tokens || 0) * price.outPerM) / 1e6;
    this.store.data.aiUsage = { day: u.day, checks: u.checks + 1, costUsd: Math.round((u.costUsd + cost) * 10000) / 10000 };
    this.store.save();
    return cost;
  }

  /**
   * Returns { ok: true, item, condition, low, high, confidence, redFlags, verdict, reason, model, costUsd }
   * or { ok: false, code, message }. Never throws.
   */
  async assess(listing, { details = null, compsSummary = null, sellOn = 'local' } = {}) {
    const model = AI_MODELS[this.settings.model] ? this.settings.model : DEFAULT_AI_MODEL;
    let client;
    try {
      client = this.clientFactory(this.settings.apiKey);
    } catch (e) {
      return this.fail('auth', `Could not start the AI client: ${e.message}`);
    }
    const text = buildPrompt(listing, { details, compsSummary, sellOn });
    const image = publicImage(listing.photo);
    const request = (withImage) => {
      const content = [];
      if (withImage) content.push({ type: 'image', source: { type: 'url', url: image } });
      content.push({ type: 'text', text });
      const params = {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: betaJSONSchemaOutputFormat(SCHEMA) },
      };
      if (AI_MODELS[model].fallback) {
        // If the model declines for policy reasons, Anthropic retries on its recommended fallback model.
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      return client.beta.messages.parse(params);
    };

    let response;
    try {
      try {
        response = await request(Boolean(image));
      } catch (e) {
        // Photo links expire; retry once without the photo.
        if (image && e instanceof Anthropic.BadRequestError) response = await request(false);
        else throw e;
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        return this.fail('auth', 'The Anthropic API key was rejected. Check it in Settings.');
      }
      if (e instanceof Anthropic.RateLimitError) return this.fail('rate', 'Anthropic rate limit reached; will try again later.');
      if (e instanceof Anthropic.BadRequestError) return this.fail('bad_request', `Anthropic rejected the request: ${e.message}`);
      if (e instanceof Anthropic.APIConnectionError) return this.fail('network', 'Could not reach Anthropic.');
      if (e instanceof Anthropic.APIError) return this.fail('api', `Anthropic error ${e.status ?? ''}: ${e.message}`);
      return this.fail('error', e.message || String(e));
    }

    const costUsd = this.record(response.model || model, response.usage);
    if (response.stop_reason === 'refusal') return this.fail('refused', 'The AI declined to assess this listing.');
    const out = response.parsed_output;
    if (!out) return this.fail('parse', `The AI answer was incomplete (${response.stop_reason || 'no output'}).`);
    let low = Number(out.resale_low);
    let high = Number(out.resale_high);
    if (!(low >= 0) || !(high >= 0)) return this.fail('parse', 'The AI gave no usable price range.');
    if (high < low) [low, high] = [high, low];
    this.lastError = null;
    return {
      ok: true,
      item: String(out.item || '').slice(0, 120),
      condition: out.condition,
      low,
      high,
      confidence: out.confidence,
      redFlags: (out.red_flags || []).map((f) => String(f).slice(0, 120)).slice(0, 5),
      verdict: out.verdict,
      reason: String(out.reason || '').slice(0, 240),
      model: response.model || model,
      costUsd,
      at: Date.now(),
    };
  }

  fail(code, message) {
    this.lastError = { code, message, at: Date.now() };
    if (code !== 'rate') log.warn(`AI check: ${message}`);
    return { ok: false, code, message };
  }
}
