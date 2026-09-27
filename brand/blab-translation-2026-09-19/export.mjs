// Renders the brand icon set from icon.js with Playwright's Chromium: each entry in
// export.html's EXPORTS list is drawn natively at its exact pixel size.
//
//   npm run icons                       -> icons/: icon{16,32,48,128}.png and the two
//                                          Chrome Web Store promo tiles (the chrome/ entries)
//   node brand/blab-translation-2026-09-19/export.mjs --all <dir>
//                                       -> the full set (web, Android, TV banner and tile, 1024 masters)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const allAt = process.argv.indexOf('--all');
const full = allAt !== -1;
if (full && !process.argv[allAt + 1]) throw new Error('--all needs an output directory');
const out = full ? resolve(process.argv[allAt + 1]) : join(ROOT, 'icons');

// The promo art is a file:// image; without this flag it taints the canvas and toDataURL throws.
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(pathToFileURL(join(HERE, 'export.html')).href);
  await page.evaluate(() => Promise.all([document.fonts.ready, window.ready]));
  if (errors.length) throw errors[0];
  const files = await page.evaluate(() => EXPORTS.map((e) => e.file));
  let written = 0;
  for (let i = 0; i < files.length; i++) {
    if (!full && !files[i].startsWith('chrome/')) continue;
    const url = await page.evaluate((i) => renderExport(i), i);
    const path = full ? join(out, files[i]) : join(out, files[i].slice('chrome/'.length));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
    written++;
  }
  console.log(`wrote ${written} files to ${out}`);
} finally {
  await browser.close();
}
