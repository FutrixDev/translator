// Guards for D9's charge confirmation on the PDF path.
//
// The comic side got this handshake first (test/unit/comic-charge.test.mjs);
// the PDF create endpoint enforces the identical contract
// (app/api/pdf/jobs/route.ts): a job that would spend credits and did not say
// so is refused with HTTP 409 `QUOTE_CONFIRM_REQUIRED`, carrying the server's
// own quote and RESERVING NOTHING. Until this batch the extension showed that
// 409 as a generic failure, so a paid PDF was simply unreachable from the
// extension — the same bug comics had.
//
// The four properties worth a test are the four the round trip rests on:
//
//   1. An ordinary create makes no claim: no `confirmCharge` field at all.
//      Absent is the server's default and already means "not confirmed", and a
//      present non-boolean is a 400 (`invalid_confirm_charge`) — so the only
//      safe values are "absent" and "true".
//   2. The confirmed retry is the SAME operation. The 409 reserved nothing;
//      the only thing keeping the retry from being a second, separately
//      charged job is that it replays the same operationId.
//   3. Declining leaves nothing behind — no second POST, and a result the
//      caller can tell apart from a failure.
//   4. Work the monthly allowance covers is never asked about.
//
// These run against the REAL background/pdf-client.js and the REAL
// shared/comic-charge.js over a fake fetch, because what goes on the wire IS
// the property under test.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// No `export`: the extension's own pages load it as a classic script, so
// importing it for its side effect publishes globalThis.ChargeConfirm.
await import('../../shared/comic-charge.js');
const ChargeConfirm = globalThis.ChargeConfirm;

const OPERATION_ID = 'b1b7f0de-2f2e-4a1f-9a0a-6c0f1f2d3e40';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%…\n').buffer;

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
 * A fake fetch covering the three hops a PDF create makes — presign ticket,
 * the storage PUT, then the job creation — and answering only the last one
 * from a script, since that is the hop the handshake happens on.
 */
function installFetch(responses) {
  const creates = [];
  let call = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/api/pdf/uploads')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ uploadUrl: 'https://storage.test/put/1', sourceKey: 'src/1' })
      };
    }
    if (href.startsWith('https://storage.test/')) {
      return { ok: true, status: 200, text: async () => '' };
    }
    creates.push({ url: href, body: JSON.parse(init.body) });
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return creates;
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
      operation: 'pdf_translate',
      pages: 12,
      freePages: 0,
      paidPages: 12,
      pointsPerPage: 1,
      points,
      balancePoints: balance
    }
  }
});

const accepted = { status: 202, body: { jobId: 'job-pdf-1', status: 'queued' } };

installChrome();
const pdf = await import('../../background/pdf-client.js');

/**
 * One create, the way the worker performs it, converted to the extension's
 * messaging envelope exactly as background.js's replyComic does — so a change
 * to either error shape breaks these tests rather than only production.
 */
function submitOnce(confirmCharge) {
  return pdf.createPdfJob({
    operationId: OPERATION_ID,
    bytes: PDF_BYTES,
    fileName: '2312.03724.pdf',
    targetLang: 'zh-CN',
    confirmCharge
  }).then(
    (data) => ({ ok: true, data }),
    (error) => ({ ok: false, ...error.toMessage() })
  );
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

test('a 409 the user confirms is resent as the SAME operation, with confirmCharge', async () => {
  const creates = installFetch([confirmRequired(12, 40), accepted]);
  const asked = [];

  const result = await ChargeConfirm.submitWithConfirmation({
    submit: submitOnce,
    confirm: async (quote) => { asked.push(quote); return true; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.jobId, 'job-pdf-1');
  assert.equal(creates.length, 2, 'one refused create, one confirmed create');

  // The property the whole round trip rests on. A fresh id here would be a
  // second job, separately charged, for the same document.
  assert.equal(creates[0].body.operationId, OPERATION_ID);
  assert.equal(creates[1].body.operationId, OPERATION_ID);

  // Absent, then true. Never `false` — the server rejects a non-boolean
  // outright and there is no reason to state a default.
  assert.equal('confirmCharge' in creates[0].body, false);
  assert.equal(creates[1].body.confirmCharge, true);

  // And the same source is re-used rather than re-uploaded under a new key.
  assert.equal(creates[0].body.sourceKey, creates[1].body.sourceKey);

  // The user was shown the server's own numbers, not a client-side estimate.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].points, 12);
  assert.equal(asked[0].balancePoints, 40);
  assert.equal(asked[0].pages, 12);
});

test('a 409 the user declines stops there, and reads as a cancel rather than a failure', async () => {
  const creates = installFetch([confirmRequired(12, 40), accepted]);

  const result = await ChargeConfirm.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => false
  });

  assert.equal(creates.length, 1, 'nothing is sent after the user says no');
  assert.equal(result.ok, false);
  // `declined` is what lets every PDF surface return quietly instead of drawing
  // a red row at someone who just pressed Cancel.
  assert.equal(result.declined, true);
  assert.equal(result.error.code, ChargeConfirm.DECLINED_CODE);
  assert.equal(result.quote.points, 12);
});

test('a PDF the monthly allowance covers is never asked about', async () => {
  const creates = installFetch([accepted]);
  let asked = 0;

  const result = await ChargeConfirm.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => { asked += 1; return true; }
  });

  assert.equal(asked, 0, 'a free document must not interrupt anyone');
  assert.equal(creates.length, 1);
  assert.equal('confirmCharge' in creates[0].body, false);
  assert.equal(result.ok, true);
});

test('an ordinary PDF failure is passed through, not turned into a price prompt', async () => {
  const creates = installFetch([{ status: 413, body: { error: 'too_many_pages', message: '', maxPages: 32 } }]);
  let asked = 0;

  const result = await ChargeConfirm.submitWithConfirmation({
    submit: submitOnce,
    confirm: async () => { asked += 1; return true; }
  });

  assert.equal(asked, 0);
  assert.equal(creates.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'too_many_pages');
  assert.equal(result.declined, undefined);
});

// ---------------------------------------------------------------------------
// The context menu's way back to the document
//
// It has no page to draw on, so it asks with a notification — and the answer
// arrives in a separate event, possibly after the worker has been torn down.
// The operation id rides in the notification id; the URL has to be recovered
// from the binding that already exists, because adding a storage key for it
// would be a new key for something already stored.
// ---------------------------------------------------------------------------

test('an operation id can be traced back to the URL it was minted for', async () => {
  installChrome();
  const url = 'https://arxiv.org/pdf/2312.03724';
  const opId = await pdf.getOrCreateUrlOperationId(url);
  assert.equal(await pdf.findUrlForOperationId(opId), url);
  // An id no binding holds, and a missing one, answer honestly rather than
  // guessing at some other document.
  assert.equal(await pdf.findUrlForOperationId('never-issued'), null);
  assert.equal(await pdf.findUrlForOperationId(null), null);
});

test('a binding that aged out no longer names a document', async () => {
  const store = installChrome();
  const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
  store.pdfUrlOps = { 'https://a.example/old.pdf': { opId: 'op-old', createdAt: twoDaysAgo } };
  assert.equal(await pdf.findUrlForOperationId('op-old'), null);
});

// ---------------------------------------------------------------------------
// The wiring, at source level — the parts with no headless surface to drive
// ---------------------------------------------------------------------------

test('the PDF create path asks through the shared module, and only that one', () => {
  const background = repoFile('background/background.js');
  assert.match(background, /import '\.\.\/shared\/comic-charge\.js'/,
    'the worker must load the shared charge module');
  assert.match(background, /ChargeConfirm\.isConfirmRequired\(error\)/,
    'and recognise the 409 through it rather than by comparing the string itself');

  // One implementation, repo-wide. A second copy is the one that goes stale on
  // the day the server changes the handshake.
  for (const file of ['background/background.js', 'popup/popup.js', 'pdf/upload.js',
    'content/content-comic-translation.js']) {
    assert.doesNotMatch(repoFile(file), /function submitWithConfirmation/,
      `${file} must call the shared handshake, not restate it`);
  }
});

test('the refused create drops its receipt and keeps its operation id', () => {
  const source = repoFile('background/background.js');
  const body = source.slice(source.indexOf('async function handlePdfCreateJob'));
  const branch = body.slice(body.indexOf('ChargeConfirm.isConfirmRequired'));
  const head = branch.slice(0, branch.indexOf('throw error;'));

  // Not a failure: nothing was reserved and no job exists, so the pending row
  // is dropped rather than settled as a red "translation failed" for a price
  // nobody has been shown yet.
  assert.match(head, /dismissJobRecord\(pendingId\)/,
    'the pending receipt must be dismissed, not settled as failed');
  assert.doesNotMatch(head, /releaseUrlOperationId/,
    'releasing the id here would make the confirmed retry a SECOND paid job');
  // Echoed back so a caller that did not mint the id can replay this exact one.
  assert.match(head, /operationId/);
});

test('the context menu asks with a notification and only spends on the yes button', () => {
  const source = repoFile('background/background.js');
  const listener = source.slice(source.indexOf('chrome.notifications.onButtonClicked'));
  assert.match(listener, /buttonIndex !== 0\) return;/,
    'cancel (and dismissal) must be silent — a declined charge is not an error');
  assert.match(listener, /findUrlForOperationId\(operationId\)/,
    'the confirmed retry must recover the same document from the same operation id');
  assert.match(listener, /confirmCharge: true/);

  const ask = source.slice(source.indexOf('async function askPdfCharge'));
  assert.match(ask.slice(0, 900), /requireInteraction: true/,
    'a price question must not scroll away unanswered');
});

test('every page that asks about a charge loads the module before its own script', () => {
  for (const [page, own] of [['pdf/upload.html', 'src="upload.js"'], ['popup/popup.html', 'src="popup.js"']]) {
    const html = repoFile(page);
    const shared = html.indexOf('shared/comic-charge.js');
    assert.ok(shared > -1, `${page} must load shared/comic-charge.js`);
    assert.ok(shared < html.indexOf(own), `${page} must load it before its own script`);
  }
});

test('both PDF pages create through the handshake and treat a decline as a cancel', () => {
  for (const file of ['pdf/upload.js', 'popup/popup.js']) {
    const source = repoFile(file);
    assert.match(source, /ChargeConfirm\.submitWithConfirmation\(/,
      `${file} must create through the handshake`);
    assert.match(source, /confirmCharge: confirmCharge === true/,
      `${file} must forward the flag it was handed, and nothing else`);
    assert.match(source, /!response\.ok && response\.declined/,
      `${file} must return quietly on a decline rather than render an error`);
    assert.match(source, /ChargeConfirm\.chargeText\(quote, t,/,
      `${file} must show the server's own numbers through the shared sentence`);
  }
  // The popup does not mint the id, so its retry can only be the same operation
  // if it sends back the one the 409 echoed.
  assert.match(repoFile('popup/popup.js'), /reply\.error\.operationId/);
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

await import('../../i18n/messages.js');

test('the price sentence carries both numbers or neither', () => {
  const t = (key) => globalThis.getMessage(key, 'en');
  const keys = { required: 'pdfChargeRequired', fallback: 'pdfChargeConfirm' };

  const full = ChargeConfirm.chargeText({ points: 12, balancePoints: 40 }, t, keys);
  assert.match(full, /12/);
  assert.match(full, /40/);
  assert.doesNotMatch(full, /\{points\}|\{balance\}/);

  // A body we could not read is still worth asking about — just not worth
  // guessing numbers for. "you have undefined" at the moment someone decides
  // whether to trust us with their balance reads as a bug.
  const vague = ChargeConfirm.chargeText(null, t, keys);
  assert.equal(vague, t('pdfChargeConfirm'));
  assert.equal(ChargeConfirm.chargeText({ points: 12 }, t, keys), t('pdfChargeConfirm'));
});

test('every locale carries the PDF charge copy, and none leaks a placeholder', () => {
  const keys = { required: 'pdfChargeRequired', fallback: 'pdfChargeConfirm' };
  for (const [lang, table] of Object.entries(globalThis.I18N_MESSAGES)) {
    if (!table.pdfFailed) continue; // a locale without the PDF feature strings
    for (const key of ['pdfChargeRequired', 'pdfChargeConfirm', 'pdfChargeDeclined',
      'pdfNotifyChargeTitle', 'comicChargeApprove', 'comicCancel']) {
      assert.ok(table[key], `${lang} is missing ${key}`);
    }
    assert.match(table.pdfChargeRequired, /\{points\}/, `${lang}.pdfChargeRequired must show the price`);
    assert.match(table.pdfChargeRequired, /\{balance\}/, `${lang}.pdfChargeRequired must show the balance`);
    const rendered = ChargeConfirm.chargeText(
      { points: 12, balancePoints: 40 },
      (key) => globalThis.getMessage(key, lang),
      keys
    );
    assert.doesNotMatch(rendered, /\{points\}|\{balance\}/, `${lang} leaked a placeholder`);
  }
});
