// Blab Translation — the charge-confirmation round trip for server-backed jobs.
//
// D9 put a confirmation gate in front of anything that spends credits. The
// contract, from the server side (app/api/comic/jobs/route.ts and
// lib/comic/billing.ts `requireComicConfirmation`):
//
//   * `confirmCharge` is absent by default, and absent means NOT confirmed.
//   * A job that would spend credits and is affordable, but was not confirmed,
//     is refused with HTTP 409 and `error: "QUOTE_CONFIRM_REQUIRED"`, carrying
//     the server's own quote.
//   * That 409 RESERVES NOTHING. The retry that carries the SAME operationId
//     plus `confirmCharge: true` is the same operation, not a second one, so
//     the round trip cannot double-charge.
//   * A job the monthly allowance covers (`quote.points <= 0`) is never
//     refused, and a job the balance cannot afford is refused for that reason
//     instead. So "the server asked" already means "this costs real credits".
//
// The last point is why this module is so small: the decision of WHETHER to ask
// is the server's, and the only client-side judgement left is what to do with
// the answer. B4 §2.2 states the product rule the server implements —
// 「额度内零确认 / 需积分一次汇总确认」 — and this is its extension-side half.
//
// Pure on purpose: no DOM, no chrome.*, no fetch. The surface that has an
// overlay to draw on supplies `confirm`, the surface that can talk to the
// service supplies `submit`, and this file owns only the order they happen in.
// Loaded as a classic script by the content scripts, so it publishes onto the
// global object rather than using `export`.
(function (root) {
  'use strict';

  /** The server's code for "this costs credits and you have not said yes". */
  const CONFIRM_REQUIRED_CODE = 'QUOTE_CONFIRM_REQUIRED';

  /**
   * Our code for "the user said no". Never sent by the server and never shown
   * as an error: a declined charge is a cancelled action, not a failure.
   */
  const DECLINED_CODE = 'charge_declined';

  function isConfirmRequired(error) {
    return !!error && error.code === CONFIRM_REQUIRED_CODE;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * The quote out of a 409, in the shape a confirmation prompt needs.
   *
   * `billingErrorBody` nests the full quote under `quote` and also flattens
   * `required`/`balance` alongside it. The nested object is the detailed one,
   * so it wins; the flat pair is the fallback for a body that carries only it.
   * Anything unreadable comes back null, which the caller must treat as "ask
   * anyway" — see needsUserConfirmation.
   */
  function readQuote(error) {
    if (!error) return null;
    const quote = error.quote && typeof error.quote === 'object' ? error.quote : {};
    const points = finiteOrNull(quote.points !== undefined ? quote.points : error.required);
    if (points === null) return null;
    return {
      points,
      balancePoints: finiteOrNull(
        quote.balancePoints !== undefined ? quote.balancePoints : error.balance
      ),
      pages: finiteOrNull(quote.pages),
      pointsPerPage: finiteOrNull(quote.pointsPerPage),
      freePages: finiteOrNull(quote.freePages),
      paidPages: finiteOrNull(quote.paidPages)
    };
  }

  /**
   * Whether a 409's quote is worth interrupting the user for.
   *
   * The server does not raise the 409 for allowance-covered work, so in
   * practice this is always true — it exists so that the "free work is never
   * asked about" rule holds on this side too, and cannot be broken by a server
   * change alone. A quote that could not be READ still gets asked about: the
   * one thing worse than an unnecessary prompt is spending someone's credits
   * because a field was missing.
   */
  function needsUserConfirmation(quote) {
    if (!quote) return true;
    return quote.points > 0;
  }

  /**
   * Submit once; if the server asks for confirmation, ask the user and submit
   * again with the same operation.
   *
   * `submit(confirmCharge)` performs one create and resolves to the extension's
   * usual messaging envelope — `{ ok: true, data }` or `{ ok: false, error }`.
   * It owns the operation id, and that is the point: the retry goes through the
   * same closure, so it cannot invent a new one and cannot be charged twice.
   *
   * `confirm(quote)` resolves true to spend the credits, false to abandon.
   *
   * At most two submits ever happen. `confirmCharge: true` is not a request the
   * server can answer with QUOTE_CONFIRM_REQUIRED, so there is no loop here to
   * run away.
   */
  async function submitWithConfirmation({ submit, confirm }) {
    const first = await submit(false);
    if (first.ok || !isConfirmRequired(first.error)) return first;

    const quote = readQuote(first.error);
    if (needsUserConfirmation(quote) && !(await confirm(quote))) {
      return {
        ok: false,
        declined: true,
        quote,
        error: { code: DECLINED_CODE, message: 'The charge was not confirmed' }
      };
    }
    return submit(true);
  }

  root.ComicCharge = {
    CONFIRM_REQUIRED_CODE,
    DECLINED_CODE,
    isConfirmRequired,
    readQuote,
    needsUserConfirmation,
    submitWithConfirmation
  };
})(globalThis);
