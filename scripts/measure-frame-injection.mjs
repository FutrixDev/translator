#!/usr/bin/env node
// What does it cost a page that the content scripts now load into every frame
// (manifest `all_frames`)? Design: docs/plans/2026-09-24-p1-a-page-coverage.md §2.9.
//
//   node scripts/measure-frame-injection.mjs [--frames 20] [--runs 7]
//
// One page with N iframes, three ways:
//
//   off          a copy of this extension with all_frames switched off — the
//                frames get nothing; this is the baseline
//   dormant      this extension, the N frames are ad slots (ad.doubleclick.net):
//                every script is compiled and evaluated, and each one returns
//                at its first line because FrameEligibility says no
//   translatable this extension, the N frames are ordinary content frames: the
//                content scripts come up in full (ctx, listeners, HELLO to the
//                top), with nothing translated — the page is not on any list
//
// The number is CDP `Performance.getMetrics` ScriptDuration for the page's
// renderer, measured after the frames settle. Site isolation is switched off so
// the cross-origin frames share the top's renderer and are counted by the same
// metric — with it on they are separate processes the page target never sees.
// Per-frame cost = (variant - off) / N, median over the runs.
//
// The design's bar: over ~15 ms per dormant frame, register two-stage
// injection (chrome.scripting on demand, a new permission) in the backlog.
// Not in the zip: `scripts/` is not in package.json's zip list.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}
const N = arg('frames', 20);
const RUNS = arg('runs', 7);
const SETTLE_MS = 1500;
const DORMANT_BUDGET_MS = 15;

const TOP = 'https://measure.test';
const CONTENT = 'https://content.test';
const AD = 'https://ad.doubleclick.net';

const doc = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const para = 'The harbour master posts the ferry timetable on the board beside the ticket office every morning.';

function topPage(frameOrigin) {
  const frames = Array.from({ length: N }, (_, i) =>
    `<iframe src="${frameOrigin}/frame/${i}" width="600" height="200" style="border:0;display:block"></iframe>`).join('');
  return doc(`<p>${para}</p>${frames}`);
}

/** A copy of the unpacked extension with every all_frames switched off. */
function extensionWithoutAllFrames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blab-no-all-frames-'));
  const skip = new Set(['node_modules', '.git', 'test', 'dist', '.worktrees']);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)) || path.dirname(src) !== ROOT,
  });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const entry of manifest.content_scripts) {
    delete entry.all_frames;
    delete entry.match_about_blank;
    delete entry.match_origin_as_fallback;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function launch(extensionPath) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
    ],
    viewport: { width: 1280, height: 720 },
  });
  await context.route(`${TOP}/**`, (route) => {
    const url = new URL(route.request().url());
    const origin = url.pathname === '/ads' ? AD : CONTENT;
    return route.fulfill({ status: 200, contentType: 'text/html', body: topPage(origin) });
  });
  for (const origin of [CONTENT, AD]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: doc(`<p>${para}</p>`) }));
  }
  // The service worker has to be up before the first page, or the first run
  // measures a cold extension.
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  return context;
}

/** ScriptDuration (ms) for one fresh load of `url`. */
async function scriptMs(context, url) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const before = await metric(cdp);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(SETTLE_MS);
  const after = await metric(cdp);
  await page.close();
  return (after - before) * 1000;
}

async function metric(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'ScriptDuration').value;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function series(context, url) {
  await scriptMs(context, url); // warm-up: code cache, first compile
  const xs = [];
  for (let i = 0; i < RUNS; i++) xs.push(await scriptMs(context, url));
  return xs;
}

async function main() {
  const offDir = extensionWithoutAllFrames();
  const results = {};
  try {
    const off = await launch(offDir);
    results.off = await series(off, `${TOP}/content`);
    results.offAds = await series(off, `${TOP}/ads`);
    await off.close();

    const on = await launch(ROOT);
    results.dormant = await series(on, `${TOP}/ads`);
    results.translatable = await series(on, `${TOP}/content`);
    await on.close();
  } finally {
    fs.rmSync(offDir, { recursive: true, force: true });
  }

  const fmt = (x) => x.toFixed(2).padStart(8);
  console.log(`frames per page: ${N}, runs: ${RUNS} (+1 warm-up), settle: ${SETTLE_MS} ms`);
  console.log('variant          median ScriptDuration (ms)   all runs');
  for (const [name, xs] of Object.entries(results)) {
    console.log(`${name.padEnd(16)} ${fmt(median(xs))}                  ${xs.map((x) => x.toFixed(1)).join(' ')}`);
  }
  const dormantPer = (median(results.dormant) - median(results.offAds)) / N;
  const translatablePer = (median(results.translatable) - median(results.off)) / N;
  console.log('');
  console.log(`per dormant frame      ${dormantPer.toFixed(2)} ms  (dormant - off, same ad page)`);
  console.log(`per translatable frame ${translatablePer.toFixed(2)} ms  (translatable - off, same content page)`);
  console.log(dormantPer > DORMANT_BUDGET_MS
    ? `OVER the ${DORMANT_BUDGET_MS} ms dormant budget: register two-stage injection in the backlog`
    : `within the ${DORMANT_BUDGET_MS} ms dormant budget`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
