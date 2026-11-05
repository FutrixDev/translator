// How long a comic job may run before the page gives it back
// (content/comic/pages.js, jobBudget).
//
// A unit test, not an e2e journey: the budget is five minutes, and the content
// script's clock lives in an isolated world a page clock cannot reach.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../../content/comic/pages.js', import.meta.url), 'utf8');

function loadComic() {
  const ctx = { t: (key) => key };
  const sandbox = { console, window: { AI_TRANSLATOR_CONTENT: ctx } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/comic/pages.js' });
  return ctx.comic;
}

const comic = loadComic();
const LIMIT = comic.JOB_TIMEOUT_MS;

test('a page waiting in the chapter queue spends none of its budget', () => {
  const budget = comic.jobBudget(0);
  for (const now of [1_000, LIMIT, LIMIT * 4]) {
    budget.observe('queued', now);
    assert.equal(budget.expired(now), false);
  }
  // Leaves the queue twenty minutes in: the full budget is still ahead.
  budget.observe('running', LIMIT * 4);
  assert.equal(budget.expired(LIMIT * 4 + LIMIT - 1), false);
  assert.equal(budget.expired(LIMIT * 5), true);
});

test('a page that runs straight away is timed from when it was ordered', () => {
  const budget = comic.jobBudget(1_000);
  budget.observe('running', 60_000);
  assert.equal(budget.expired(LIMIT), false);
  assert.equal(budget.expired(1_000 + LIMIT), true);
});

test('a job picked up again already running gets no second budget', () => {
  // Ordered on an earlier visit; this page load first sees it running.
  const budget = comic.jobBudget(0);
  budget.observe('running', LIMIT - 10);
  assert.equal(budget.expired(LIMIT), true);
});

test('only the first exit from the queue starts the clock', () => {
  const budget = comic.jobBudget(0);
  budget.observe('queued', 10_000);
  budget.observe('running', 20_000);
  budget.observe('running', LIMIT);
  assert.equal(budget.expired(20_000 + LIMIT), true);
});
