import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccuracy, formatReport } from '../tools/accuracy.js';

// The labeled set in test/fixtures/labeled-listings.json: realistic listings
// with the answer a careful reseller would give. A change to the deal rules
// that makes these worse should fail here, with the report saying which.
test('labeled listings: no false alarms, real deals caught, 90%+ right overall', () => {
  const r = runAccuracy();
  const report = formatReport(r);
  assert.ok(r.total >= 60, 'the labeled set should stay big enough to mean something');
  assert.equal(r.falseAlarms, 0, report);
  assert.ok(r.caught / r.deals >= 0.85, report);
  assert.ok(r.accuracy >= 0.9, report);
});
