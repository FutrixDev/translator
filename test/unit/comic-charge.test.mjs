// Guards for the D9 charge-confirmation round trip.
//
// The server refuses a comic job that would spend credits and was not
// confirmed: HTTP 409, `error: "QUOTE_CONFIRM_REQUIRED"`, with its own quote in
// the body (translator-saas/server/lib/comic/billing.ts,
// `requireComicConfirmation`). Before this, the extension showed that 409 as a
// generic failure and paid work was simply unreachable from the extension.
//
// Three properties are worth a test, and they are the three below:
//
//   1. The retry after a confirmation is the SAME operation. The 409 reserves
//      nothing, and the only thing that stops the retry being charged as a
//      second job is that it carries the same operationId. A refactor that let
//      the retry mint a fresh id would double-charge every paid page, silently.
//   2. Declining leaves nothing behind. No second POST, and a result the caller
//      can tell apart from a failure — a cancelled action must not be shown to
//      the user as an error.
//   3. Free work is never asked about. The allowance path returns 202 straight
//      away, and a client-side prompt in front of it would be a prompt the
//      product explicitly does not have (B4: 「额度内零确认」).
//
// These run against the REAL background/comic-client.js and the REAL
// shared/comic-charge.js over a fake fetch, because the property under test is
// exactly what goes on the wire.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

// No `export` — it is also loaded as a classic script by the content scripts,
// so importing it for its side effect publishes globalThis.ComicCharge.
await import('../../shared/comic-charge.js');
const ComicCharge = globalThis.ComicCharge;

const OPERATION_ID = '1756400000000-op7x3';
const IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgo=';

/** A signed-in service worker: a live token and nothing else. */
function installChrome() {
  const store = { comicToken: 'tok-test', comicTokenExpiresAt: Date.now() + 3_600_000 };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => {
          const out = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        set: async (values) => { Object.assign(store, values); },
        remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; }
      }
    }
  };
  return store;
}

/**
 * A fake fetch that answers the create endpoint from a script of responses and
 * records every request body it was given.
 */
function installFetch(responses) {
  const posts = [];
  let call = 0;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return posts;
}

/** The 409 body the server actually sends (lib/billing/service.ts billingErrorBody). */
const confirmRequired = (points, balance) => ({
  status: 409,
  body: {
    error: 'QUOTE_CONFIRM_REQUIRED',
    message: 'This operation costs credits and has not been confirmed',
    balance,
    required: points,
    quote: {
      operation: 'comic_translate',
      pages: 1,
      freePages: 0,
      paidPages: 1,
      pointsPerPage: points,
      points,
      balancePoints: balance
    }
  }
});

const accepted = { status: 202, body: { jobId: 'job-1', status: 'queued' } };

installChrome();
const comic = await import('../../background/comic-client.js');

/**
 * Submit the way the extension does, all the way down.
 *
 * `submit` is the content script's closure over one operationId, and the
 * envelope conversion is verbatim what background.js's replyComic does with a
 * rejected ComicApiError — so a change to either error shape breaks these tests
 * rather than only breaking production.
 */
function submitOnce(confirmCharge) {
  return comic.createJob({
    operationId: OPERATION_ID,
    imageBase64: IMAGE_BASE64,
    pageUrl: 'https://example.test/ch1/p3',
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    mode: 'translate',
    confirmCharge
  }).then(
    (data) => ({ ok: true, data }),
    (error) => ({ ok: false, ...error.toMessage() })
  );
}

test('a 409 that the user confirms is resent as the SAME operation, with confirmCharge', async () => {
  const posts = installFetch([confirmRequired(3, 12), accepted]);
  const asked = [];

  const result = await ComicCharge.submitWithConfirmation({
    submit: submitOnce,
    confirm: async (quote) => { asked.push(quote); return true; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.jobId, 'job-1');
  assert.equal(posts.length, 2, 'one refused create, one confirmed create');

  // The property the whole round trip rests on: same operation, not a second
  // one. A new id here would be a second charge for the same page.
  assert.equal(posts[0].body.operationId, OPERATION_ID);
  assert.equal(posts[1].body.operationId, OPERATION_ID);

  // The first create makes no claim at all — absent is the server's default and
  // already means "not confirmed" — and only the second one says yes.
  assert.equal('confirmCharge' in posts[0].body, false);
  assert.equal(posts[1].body.confirmCharge, true);

  // The user was shown the server's own numbers, not a client-side estimate.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].points, 3);
  assert.equal(asked[0].balancePoints, 12);
  assert.equal(asked[0].pages, 1);
});

test('a 409 the user declines stops there, and reads as a cancel rather than a failure', async () => {
  const posts = installFetch([confirmRequired(3, 12), accepted]);

  const result = await ComicCharge.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => false
  });

  assert.equal(posts.length, 1, 'nothing is sent after the user says no');
  assert.equal(result.ok, false);
  // `declined` is what lets the caller return quietly instead of drawing an
  // error card at someone who just pressed Cancel.
  assert.equal(result.declined, true);
  assert.equal(result.error.code, 'charge_declined');
  assert.equal(result.error.code, ComicCharge.DECLINED_CODE);
  // The quote survives the decline, so a caller can still say what was refused.
  assert.equal(result.quote.points, 3);
});

test('work the monthly allowance covers is never asked about', async () => {
  // The server does not raise the 409 for free work — it accepts it — so the
  // absence of a prompt here is the absence of a redundant one the client
  // could have added on top.
  const posts = installFetch([accepted]);
  let asked = 0;

  const result = await ComicCharge.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => { asked += 1; return true; }
  });

  assert.equal(asked, 0, 'a free page must not interrupt the reader');
  assert.equal(posts.length, 1);
  assert.equal('confirmCharge' in posts[0].body, false);
  assert.equal(result.ok, true);
});

test('an ordinary failure is passed through untouched, not turned into a prompt', async () => {
  const posts = installFetch([{ status: 402, body: { error: 'insufficient_points', message: 'no' } }]);
  let asked = 0;

  const result = await ComicCharge.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => { asked += 1; return true; }
  });

  assert.equal(asked, 0);
  assert.equal(posts.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'insufficient_points');
  assert.equal(result.declined, undefined);
});

// ------------------------------------------------------------- quote reading
test('the quote is read from the nested object, and falls back to the flat pair', () => {
  const nested = ComicCharge.readQuote(confirmRequired(4, 9).body);
  assert.equal(nested.points, 4);
  assert.equal(nested.balancePoints, 9);
  assert.equal(nested.paidPages, 1);

  // A body carrying only the flattened numbers still yields a usable quote.
  const flat = ComicCharge.readQuote({ code: 'QUOTE_CONFIRM_REQUIRED', required: 5, balance: 8 });
  assert.equal(flat.points, 5);
  assert.equal(flat.balancePoints, 8);
  assert.equal(flat.pages, null);
});

test('an unreadable quote is asked about anyway', () => {
  // Spending someone's credits because a field was missing is worse than a
  // prompt without numbers in it.
  assert.equal(ComicCharge.readQuote({ code: 'QUOTE_CONFIRM_REQUIRED' }), null);
  assert.equal(ComicCharge.needsUserConfirmation(null), true);
});

test('a zero-cost quote is not worth interrupting for', () => {
  assert.equal(ComicCharge.needsUserConfirmation({ points: 0 }), false);
  assert.equal(ComicCharge.needsUserConfirmation({ points: 2 }), true);
});
