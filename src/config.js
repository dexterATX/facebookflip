import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultUserAgent() {
  const os =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36`;
}

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  // Optional password for the dashboard (recommended if you open it to your network).
  password: process.env.PASSWORD || '',
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  // Lets the demo and the tests point the app at a fake Facebook server.
  fbBase: (process.env.FB_BASE_URL || 'https://www.facebook.com').replace(/\/+$/, ''),
  userAgent: process.env.FB_USER_AGENT || defaultUserAgent(),
  // Full path to Chrome/Edge/Chromium if it is not found automatically.
  browserPath: process.env.BROWSER_PATH || '',
  // Pause between two Facebook checks (ms). Lower only for testing.
  scanGapMs: num(process.env.SCAN_GAP_MS, 6000),
  demo: process.env.DEMO === '1',
  openBrowser: process.env.OPEN === '1',
};
