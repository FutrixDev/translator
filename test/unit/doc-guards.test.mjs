// Structural guards for the document surfaces (spec §2.3, §5.3, §9.1).
//
// Each guard is a checker over source text, and each checker is first run on a
// deliberately broken copy of the source: a guard that cannot fail is not a
// guard. The scope is the document surfaces only — base64 and byte caps are
// legitimate in the comic, OCR and cache code.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const jsIn = dir => readdirSync(path.join(ROOT, dir)).filter(n => n.endsWith('.js')).sort().map(n => `${dir}/${n}`);

/** The document surfaces, per spec §2.3. */
const DOC_SURFACES = [
  'background/pdf-client.js', 'background/pdf-jobs.js', 'background/pdf-notify.js',
  ...jsIn('pdf'), 'popup/popup-pdf.js', 'options/options-pdf-tasks.js'
];

/** Every shipped script: the repo minus tests, docs, tooling and dependencies. */
function shippedScripts() {
  const out = [];
  const skip = new Set(['node_modules', 'test', 'docs', 'scripts', 'dist', 'coverage']);
  (function walk(dir) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.js')) out.push(rel);
    }
  })('');
  return out;
}

/** Files whose source matches, as `file: match` lines. */
function offenders(files, pattern, sourceOf = read) {
  const hits = [];
  for (const file of files) {
    const match = sourceOf(file).match(pattern);
    if (match) hits.push(`${file}: ${match[0]}`);
  }
  return hits;
}

/** A source lookup that answers `mutated` for one file and the disk for the rest. */
const mutating = (target, mutate) => file => (file === target ? mutate(read(file)) : read(file));

/** The body of a named function, by brace matching from its first `{`. */
function functionBody(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  let i = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(i, j + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Limits, status sets, transport
// ---------------------------------------------------------------------------

const BYTE_CAP = /MAX_PDF_BYTES|\b\d+\s*\*\s*1024\s*\*\s*1024\b/;
const HAND_BUILT_ACTIVE = /['"](queued|running)['"]\s*,\s*['"](queued|running)['"]|===\s*['"](queued|running)['"]\s*\|\|\s*[\w.]+\s*===\s*['"](queued|running)['"]/;
const BASE64 = /base64|\batob\s*\(|\bbtoa\s*\(/i;

test('byte caps live only in DocJobs', () => {
  assert.ok(offenders(['pdf/upload.js'], BYTE_CAP,
    mutating('pdf/upload.js', s => `${s}\nconst LIMIT = 30 * 1024 * 1024;`)).length, 'self-check');
  assert.deepEqual(offenders(DOC_SURFACES, BYTE_CAP), []);
});

test('the status sets live only in DocJobs', () => {
  assert.ok(offenders(['popup/popup-pdf.js'], HAND_BUILT_ACTIVE,
    mutating('popup/popup-pdf.js', s => `${s}\nconst ACTIVE = new Set(['queued', 'running']);`)).length, 'self-check');
  assert.ok(offenders(['pdf/job-view.js'], HAND_BUILT_ACTIVE,
    mutating('pdf/job-view.js', s => `${s}\nconst a = v => v.status === 'running' || v.status === 'queued';`)).length,
  'self-check');
  assert.deepEqual(offenders(DOC_SURFACES, HAND_BUILT_ACTIVE), []);
});

test('no document surface encodes bytes as base64', () => {
  assert.ok(offenders(['background/pdf-jobs.js'], BASE64,
    mutating('background/pdf-jobs.js', s => `${s}\nconst b = btoa(x);`)).length, 'self-check');
  assert.deepEqual(offenders(DOC_SURFACES, BASE64), []);
});

test('the retired names are gone from every shipped script', () => {
  const retired = /\b(isPdfBytes|isPdfJobActive|PDF_OPEN_RESULT|createPdfJob)\b/;
  const files = shippedScripts();
  assert.ok(files.includes('background/background.js') && files.includes('shared/doc-jobs.js'),
    'the walk reaches the worker and shared/');
  assert.ok(offenders(['background/background.js'], retired,
    mutating('background/background.js', s => `${s}\n// PDF_OPEN_RESULT`)).length, 'self-check');
  assert.deepEqual(offenders(files, retired), []);
});

// ---------------------------------------------------------------------------
// Load order
// ---------------------------------------------------------------------------

/** Does doc-jobs load before pdf-errors in this list? */
function docJobsFirst(source) {
  const jobs = source.indexOf('shared/doc-jobs.js');
  const errors = source.indexOf('shared/pdf-errors.js');
  return jobs !== -1 && errors !== -1 && jobs < errors;
}

test('every load list puts doc-jobs before pdf-errors', () => {
  const lists = ['background/pdf-client.js', 'pdf/upload.html', 'popup/popup.html', 'options/options.html'];
  const swapped = read('pdf/upload.html')
    .replace('../shared/doc-jobs.js', '@@').replace('../shared/pdf-errors.js', '../shared/doc-jobs.js')
    .replace('@@', '../shared/pdf-errors.js');
  assert.equal(docJobsFirst(swapped), false, 'self-check');
  for (const file of lists) assert.ok(docJobsFirst(read(file)), file);
});

// ---------------------------------------------------------------------------
// The popup's shared lexical scope
// ---------------------------------------------------------------------------

/** Top-level names a classic script declares (column-0 declarations). */
function topLevelNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    let m = line.match(/^(?:async\s+)?function\s*\*?\s*([\w$]+)/) || line.match(/^class\s+([\w$]+)/) ||
      line.match(/^(?:const|let|var)\s+([\w$]+)/);
    if (m) { names.push(m[1]); continue; }
    m = line.match(/^(?:const|let|var)\s+\{([^}]*)\}/);
    if (m) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop().split('=')[0].trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

function duplicateTopLevel(files, sourceOf = read) {
  const seen = new Map();
  const dupes = [];
  for (const file of files) {
    for (const name of new Set(topLevelNames(sourceOf(file)))) {
      if (seen.has(name)) dupes.push(`${name}: ${seen.get(name)} and ${file}`);
      else seen.set(name, file);
    }
  }
  return dupes;
}

test('the popup scripts declare no top-level name twice', () => {
  const files = jsIn('popup');
  assert.ok(files.length >= 2, 'popup.js and popup-pdf.js share one scope');
  const firstName = topLevelNames(read('popup/popup.js'))[0];
  assert.ok(duplicateTopLevel(files, mutating('popup/popup-pdf.js', s => `${s}\nconst ${firstName} = 1;`)).length,
    'self-check');
  assert.deepEqual(duplicateTopLevel(files), []);
});

// ---------------------------------------------------------------------------
// Notifications (spec §5.3)
// ---------------------------------------------------------------------------

const PAGE_HANDLERS = ['handlePdfCreateJob', 'handlePdfJobGet', 'handlePdfJobConfirm', 'openPdfJob'];

/** What is wrong with where the worker raises notifications, as a list. */
function notificationProblems(jobs) {
  const problems = [];
  const poll = functionBody(jobs, 'refreshPdfJobs');
  if (!poll) return ['refreshPdfJobs is missing'];
  const calls = (jobs.match(/notifyPdfTerminal\(/g) || []).length;
  const inPoll = (poll.match(/notifyPdfTerminal\(/g) || []).length;
  if (inPoll === 0 || calls !== inPoll) problems.push('notifyPdfTerminal( outside refreshPdfJobs');
  for (const name of PAGE_HANDLERS) {
    const body = functionBody(jobs, name);
    if (!body) problems.push(`${name} is missing`);
    else if (/notifyPdf/.test(body)) problems.push(`${name} raises a notification`);
  }
  return problems;
}

test('only the poll turns a job\'s progress into a notification', () => {
  const jobs = read('background/pdf-jobs.js');
  const injected = jobs.replace(/(async function handlePdfJobGet\([^)]*\)\s*\{)/, '$1\n  notifyPdfTerminal(x);');
  assert.notEqual(injected, jobs);
  assert.ok(notificationProblems(injected).length >= 2, 'self-check');
  assert.deepEqual(notificationProblems(jobs), []);
  assert.equal(/function notifyPdfTerminal\(/.test(read('background/pdf-notify.js')), true);
});

test('the notification click listener is registered at the top level', () => {
  const TOP_LEVEL = /^chrome\.notifications\.onClicked\.addListener\(/m;
  const jobs = read('background/pdf-jobs.js');
  assert.equal(TOP_LEVEL.test(jobs.replace(TOP_LEVEL, '  chrome.notifications.onClicked.addListener(')), false,
    'self-check');
  assert.ok(TOP_LEVEL.test(jobs));
});
