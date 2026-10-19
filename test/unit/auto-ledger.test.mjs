// The auto-translation scheduler's progress ledger (content/content-auto-ledger.js,
// design docs/design/ext-opt-page-translation.md §2, D-560 code-quality SF-1).
//
// The scheduler owns no counter of its own: every book is behind these methods, and
// counts() is what ctx.progressFeed is told. Pinned here on its own:
//   - known counts accepted keys once, plus every revival;
//   - a key is settled or retired, never both, so settled never passes known;
//   - retire ignores a key never accepted and a key already settled;
//   - reset empties every book.
//
// The scheduler wired to it is covered by test/unit/progress-feed.test.mjs.
//
// Run with: node --test test/unit/auto-ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repoSource } from './helpers/sources.mjs';

function loadLedger() {
  const ctx = {};
  const sandbox = { AI_TRANSLATOR_CONTENT: ctx };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(repoSource('content/content-auto-ledger.js'), sandbox, { filename: 'content-auto-ledger.js' });
  return ctx.autoLedger;
}

const tally = (ledger) => {
  const { known, settled, failed } = ledger.counts();
  return [known, settled, failed];
};

test('keyOf is the one key shape: block id, colon, text fingerprint', () => {
  assert.equal(loadLedger().keyOf(7, 'abc'), '7:abc');
});

test('a retired key accepted again is one more block owed, and settling it closes the ring', () => {
  const ledger = loadLedger().create();
  ledger.accept('k');
  assert.deepEqual(tally(ledger), [1, 0, 0]);
  ledger.retire('k');
  assert.deepEqual(tally(ledger), [1, 1, 0], 'retired counts as done for progress');
  assert.equal(ledger.has('k'), false, 'but does not block sending it again');
  ledger.accept('k');
  assert.deepEqual(tally(ledger), [2, 1, 0], 'revived: what was reported done stays done, one more is owed');
  ledger.settle('k');
  assert.deepEqual(tally(ledger), [2, 2, 0]);
  assert.equal(ledger.has('k'), true);
});

test('retire ignores a key never accepted and a key already settled', () => {
  const ledger = loadLedger().create();
  ledger.retire('never');
  assert.deepEqual(tally(ledger), [0, 0, 0]);
  ledger.accept('k');
  ledger.settle('k');
  ledger.retire('k');
  assert.deepEqual(tally(ledger), [1, 1, 0], 'a settled key is not counted a second time as retired');
});

test('settling a retired key moves it across instead of counting it twice', () => {
  const ledger = loadLedger().create();
  ledger.accept('k');
  ledger.retire('k');
  ledger.settle('k');
  assert.deepEqual(tally(ledger), [1, 1, 0]);
  ledger.accept('k');
  assert.deepEqual(tally(ledger), [1, 1, 0], 'no longer retired, so accepting it again revives nothing');
});

test('accepting the same key twice counts it once', () => {
  const ledger = loadLedger().create();
  ledger.accept('k');
  ledger.accept('k');
  assert.deepEqual(tally(ledger), [1, 0, 0]);
});

test('giveUp adds to failed, and reset empties every book', () => {
  const ledger = loadLedger().create();
  ledger.accept('a');
  ledger.accept('b');
  ledger.retire('b');
  ledger.accept('b');
  ledger.settle('a');
  ledger.giveUp(1);
  assert.deepEqual(tally(ledger), [3, 2, 1]);
  ledger.reset();
  assert.deepEqual(tally(ledger), [0, 0, 0]);
  assert.equal(ledger.has('a'), false);
  ledger.accept('b');
  assert.deepEqual(tally(ledger), [1, 0, 0], 'the retired book was emptied too: nothing to revive');
});

test('the ledger is frozen and has exactly these methods', () => {
  const ledger = loadLedger().create();
  assert.ok(Object.isFrozen(ledger));
  assert.deepEqual(Object.keys(ledger).sort(), ['accept', 'counts', 'giveUp', 'has', 'reset', 'retire', 'settle']);
});
