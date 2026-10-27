// shared/site-links.js — every link from the extension to the account site.
//
// A link is the configured origin plus a site path, tagged with the entry it
// was opened from (utm_source=extension&utm_medium=<entry>). Nothing else may
// build one: a second builder is a link without the tag, or one built from a
// base that is not a web origin.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('../../shared/site-links.js');
const { SiteLinks } = globalThis;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tag = (medium) => `utm_source=extension&utm_medium=${medium}`;

test('each link is the site origin plus its path, tagged with its entry; a path on the base is dropped', () => {
  assert.equal(SiteLinks.pricing('https://blab.test', 'options'), `https://blab.test/app/pricing?${tag('options')}`);
  assert.equal(SiteLinks.pricing('http://localhost:3310/some/path?q=1', 'page'),
    `http://localhost:3310/app/pricing?${tag('page')}`);
  assert.equal(SiteLinks.library('https://staging.example.com/api/', 'options'),
    `https://staging.example.com/app/settings/pdf?${tag('options')}`);
  assert.equal(SiteLinks.reader('http://127.0.0.1:8787/api/', 'job-1', 'upload'),
    `http://127.0.0.1:8787/app/reader/job-1?${tag('upload')}`);
  assert.equal(SiteLinks.reader('https://blab-translation.com', 'a/b?c=d#e f', 'notification'),
    `https://blab-translation.com/app/reader/a%2Fb%3Fc%3Dd%23e%20f?${tag('notification')}`);
});

test('no link from a base that is not a web origin', () => {
  for (const base of ['', null, undefined, 'not a url', 'javascript:alert(1)', 'chrome-extension://abc/', 'file:///x']) {
    assert.equal(SiteLinks.pricing(base, 'popup'), '', String(base));
    assert.equal(SiteLinks.library(base, 'popup'), '', String(base));
    assert.equal(SiteLinks.reader(base, 'job-1', 'popup'), '', String(base));
  }
});

test('origin is the base\'s http(s) origin, or empty for anything else', () => {
  assert.equal(SiteLinks.origin('https://site.example/app/'), 'https://site.example');
  assert.equal(SiteLinks.origin('http://localhost:3310/'), 'http://localhost:3310');
  for (const base of ['', null, undefined, 'not a url', 'javascript:alert(1)', 'chrome-extension://abc/', 'file:///x']) {
    assert.equal(SiteLinks.origin(base), '', String(base));
  }
});

test('the sign-in tab is tagged signin and carries state and redirect_uri; no tab from a base that is not a web origin', () => {
  const url = new URL(SiteLinks.connect('https://blab.test/api/', 'st&1', 'https://abc.chromiumapp.org/'));
  assert.equal(url.origin + url.pathname, 'https://blab.test/ext/connect');
  assert.equal(url.searchParams.get('utm_source'), 'extension');
  assert.equal(url.searchParams.get('utm_medium'), 'signin');
  assert.equal(url.searchParams.get('state'), 'st&1');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://abc.chromiumapp.org/');
  for (const base of ['', 'javascript:alert(1)', 'chrome-extension://abc/']) {
    assert.equal(SiteLinks.connect(base, 's', 'r'), '', base);
  }
});

test('reader: a comic chapter opens at its page; only a non-negative integer is one', () => {
  assert.equal(SiteLinks.reader('https://blab.test', 'asset_1', 'comic_summary', { pageIndex: 3 }),
    `https://blab.test/app/reader/asset_1?${tag('comic_summary')}&pageIndex=3`);
  assert.equal(SiteLinks.reader('https://blab.test', 'asset_1', 'comic_summary', { pageIndex: 0 }),
    `https://blab.test/app/reader/asset_1?${tag('comic_summary')}&pageIndex=0`);
  for (const pageIndex of [undefined, null, -1, 1.5, '2', NaN]) {
    assert.equal(SiteLinks.reader('https://blab.test', 'asset_1', 'comic_summary', { pageIndex }),
      `https://blab.test/app/reader/asset_1?${tag('comic_summary')}`, String(pageIndex));
  }
  assert.equal(SiteLinks.reader('javascript:alert(1)', 'asset_1', 'comic_summary', { pageIndex: 2 }), '');
});

test('reader: no link for no id or a pending local: id; only the prefix marks one pending', () => {
  for (const id of ['', null, undefined, 'local:op-1']) {
    assert.equal(SiteLinks.reader('https://blab-translation.com', id, 'popup'), '', String(id));
  }
  assert.equal(SiteLinks.reader('https://blab-translation.com', 'job-local:1', 'popup'),
    `https://blab-translation.com/app/reader/job-local%3A1?${tag('popup')}`);
});

test('an entry the list does not name throws instead of filing the visit under a typo', () => {
  for (const medium of [undefined, '', 'Popup', 'settings']) {
    assert.throws(() => SiteLinks.pricing('https://blab.test', medium), /SiteLinks: unknown entry/, String(medium));
    assert.throws(() => SiteLinks.assertMedium(medium), /SiteLinks: unknown entry/, String(medium));
  }
  assert.deepEqual([...SiteLinks.MEDIUMS], ['popup', 'options', 'upload', 'notification', 'page', 'pdf_page', 'signin', 'pdf_quota', 'comic_quota', 'comic_summary']);
});

test('no other extension file builds a site page link', () => {
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !file.startsWith('test/') && file !== 'shared/site-links.js');
  const offenders = files.filter((file) =>
    /['"`}]\/(app\/(pricing|reader|settings\/pdf)|ext\/connect)/.test(readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the pages that link out load site-links.js; the worker imports it', () => {
  for (const page of ['options/options.html', 'pdf/upload.html']) {
    assert.match(readFileSync(path.join(ROOT, page), 'utf8'), /<script src="\.\.\/shared\/site-links\.js"><\/script>/, page);
  }
  for (const worker of ['background/background.js', 'background/pdf-jobs.js']) {
    assert.match(readFileSync(path.join(ROOT, worker), 'utf8'), /^import '\.\.\/shared\/site-links\.js';$/m, worker);
  }
});

test('the worker opens the reader from one place', () => {
  const files = execFileSync('git', ['ls-files', 'background/*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const callers = files.filter((file) => /SiteLinks\.reader\(/.test(readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(callers, ['background/comic-client.js'], 'a second reader opener');
  assert.match(readFileSync(path.join(ROOT, 'background/comic-client.js'), 'utf8'), /export async function openReaderTab\(/);
});
