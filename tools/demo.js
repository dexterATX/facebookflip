// Try FlipRadar without touching Facebook: runs the app against a pretend
// Marketplace that keeps posting new listings every minute or so.
//
//   npm run demo   ->   http://localhost:3000

import path from 'node:path';
import { MockFacebook } from './mock-facebook.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';

// More listings than fit on one page (24), and now and then a new one placed on
// page 2, like Facebook does, so the demo shows FlipRadar reading past page 1.
// Some listings only ship, from out of state, like on Facebook: FlipRadar drops them.
const mock = new MockFacebook({ minAddSec: 20, maxAddSec: 60, bargainEvery: 5, seedCount: 60, sinkEvery: 6, shipEvery: 9 });
let base;
try {
  base = await mock.listen(Number(process.env.MOCK_PORT || 3999));
} catch {
  base = await mock.listen(0);
}

const app = await createApp({
  fbBase: base,
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(config.root, 'data', 'demo'),
  demo: true,
  scanGapMs: 2000,
});

const s = app.store.settings;
if (!app.store.watches.length) {
  app.store.addWatch({ name: 'Road & hybrid bikes', query: 'bike', location: 'tampa', minPrice: 50, maxPrice: 900, intervalSec: 60, exclude: ['kids'] });
  app.store.addWatch({ name: 'Couches under $500', query: 'couch', location: 'tampa', maxPrice: 500, intervalSec: 120 });
  // This one shows the most accurate setup: you tell FlipRadar what it resells for.
  app.store.addWatch({ name: 'PS5', query: 'ps5', location: 'tampa', intervalSec: 180, resaleValue: 380 });
  // No resale price set: the built-in price guide prices the models it knows.
  app.store.addWatch({ name: 'iPhones', query: 'iphone', location: 'tampa', intervalSec: 120 });
}
app.store.flush();

await app.listen();
const url = `http://localhost:${app.config.port}`;
console.log('');
console.log(`  FlipRadar DEMO is running  ->  ${url}`);
console.log('  Listings come from a pretend Marketplace; nothing here touches Facebook.');
console.log('  Press Ctrl+C to stop.');
console.log('');
if (app.config.openBrowser) {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const stop = async () => {
  await app.close().catch(() => {});
  await mock.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
