#!/usr/bin/env node
// Makes sure FlipRadar has a browser to drive, so it can read past the first
// page of results (Facebook shows 24 at a time and loads more as you scroll).
// Uses Chrome, Edge, Chromium or Brave if one is installed; otherwise
// downloads Chromium once (about 170 MB). Never stops FlipRadar from
// starting: without a browser it still works and reads the first page.
//
// Skip the download with FLIPRADAR_NO_BROWSER_DOWNLOAD=1.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../src/facebook/browser.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  if (process.env.FLIPRADAR_NO_BROWSER_DOWNLOAD) return;
  if (await findBrowser(process.env.BROWSER_PATH || '')) return;
  const cli = path.join(root, 'node_modules', 'playwright-core', 'cli.js');
  if (!fs.existsSync(cli)) return;
  console.log('');
  console.log('  No Chrome or Chromium found. Downloading Chromium (one time, about 170 MB)');
  console.log('  so FlipRadar can read past the first 24 results of each search...');
  // --no-shell: FlipRadar runs the full Chromium headless, so the separate headless build isn't needed.
  const r = spawnSync(process.execPath, [cli, 'install', '--no-shell', 'chromium'], { stdio: 'inherit' });
  if (r.status === 0 && (await findBrowser(''))) console.log('  Done.');
  else console.log('  Could not download Chromium. FlipRadar will read the first page of results only.');
  console.log('');
}

main().catch((e) => console.log(`  Skipping the browser check: ${e.message}`));
