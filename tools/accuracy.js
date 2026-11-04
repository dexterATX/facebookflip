#!/usr/bin/env node
// Runs the deal checker over realistic listings with known right answers
// (test/fixtures/labeled-listings.json) and reports how often it agrees.
//
//   npm run accuracy
//
// "False alarm" = it would have alerted you about something that isn't a deal.
// "Missed deal" = a real deal it left in Unsorted. False alarms cost money and
// trust, so the checker is tuned to miss a deal before it cries wolf.

import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.js';
import { isMainModule } from '../src/util.js';

const FIXTURE = new URL('../test/fixtures/labeled-listings.json', import.meta.url);

export function loadLabeled(file = FIXTURE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function runAccuracy(data = loadLabeled()) {
  const now = Date.parse(`${data.asOf}T12:00:00Z`);
  const results = data.cases.map((c, i) => {
    const pool = (data.pools[c.pool] || []).map((p, k) => ({ id: `${c.pool}-${k}`, ...p }));
    const listing = { id: `case-${i}`, title: c.title, price: c.price, priceText: `$${c.price}` };
    const details = c.description || c.condition ? { description: c.description || '', condition: c.condition || '' } : null;
    const watch = { include: [], sellOn: 'local', ...c.watch };
    const e = evaluate(listing, { watch, pool, details, rules: c.rules, now });
    return { ...c, got: e.verdict, ok: e.verdict === c.expect, headline: e.headline, confidence: e.confidence, resale: e.resale?.value ?? null, profit: e.profit ?? null };
  });
  const count = (fn) => results.filter(fn).length;
  const caught = count((r) => r.expect === 'deal' && r.got === 'deal');
  const falseAlarms = count((r) => r.expect !== 'deal' && r.got === 'deal');
  const missed = count((r) => r.expect === 'deal' && r.got !== 'deal');
  const correct = count((r) => r.ok);
  const groups = {};
  for (const r of results) {
    const g = (groups[r.group] ||= { total: 0, right: 0 });
    g.total++;
    if (r.ok) g.right++;
  }
  return {
    results,
    total: results.length,
    correct,
    caught,
    falseAlarms,
    missed,
    deals: caught + missed,
    accuracy: correct / results.length,
    groups,
  };
}

export function formatReport(r) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [];
  lines.push(`Deal checker accuracy on ${r.total} labeled listings`);
  lines.push('');
  lines.push(`  Right overall          ${r.correct}/${r.total} (${pct(r.accuracy)})`);
  lines.push(`  Real deals caught      ${r.caught}/${r.deals}`);
  lines.push(`  False alarms           ${r.falseAlarms}  (alerts that weren't deals)`);
  lines.push(`  Missed deals           ${r.missed}  (left in Unsorted)`);
  lines.push('');
  lines.push('  By kind of listing:');
  for (const [g, v] of Object.entries(r.groups)) lines.push(`    ${g.padEnd(24)} ${v.right}/${v.total}`);
  const wrong = r.results.filter((x) => !x.ok);
  if (wrong.length) {
    lines.push('');
    lines.push('  Disagreements:');
    for (const x of wrong) {
      const kind = x.got === 'deal' ? 'FALSE ALARM' : 'missed deal';
      lines.push(`    [${kind}] "${x.title}" $${x.price}`);
      lines.push(`        expected ${x.expect}: ${x.why}`);
      lines.push(`        checker said: ${x.headline} (${x.confidence} confidence)`);
    }
  }
  lines.push('');
  lines.push('  These are hand-written examples: they show the rules work as intended, not real-world');
  lines.push('  accuracy. For that, use the thumbs up / down on real listings in the app.');
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const r = runAccuracy();
  console.log(formatReport(r));
  if (r.falseAlarms) process.exitCode = 1;
}
