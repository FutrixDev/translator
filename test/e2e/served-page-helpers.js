/**
 * A page served from context routes, and what the content script makes of it:
 * which roots its page scope resolves to, and when its settings have settled.
 */
const { expect } = require('@playwright/test');
const { evaluateInContentScript } = require('./helpers');

/**
 * Serve whole HTML pages from context routes: `pages` maps a full URL (no query or
 * hash) to its body. One route per origin; a path that is not in the map is 404.
 */
async function serveHtml(context, pages) {
  const origins = new Set(Object.keys(pages).map((url) => new URL(url).origin));
  for (const origin of origins) {
    await context.route(`${origin}/**`, (route) => {
      const body = pages[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

/**
 * Ask the content script which roots the page scope resolves to, and the main
 * share. `invalidate` picks what is thrown away first:
 *   'round' — only the body fallback (what discovery does at the start of a round);
 *   'all'   — the recognised root as well, so the share is measured again.
 */
async function scopeProbe(context, page, { invalidate }) {
  const reset = { round: 'ctx.beginScopeRound()', all: 'ctx.invalidatePageScope()' }[invalidate];
  if (!reset) throw new Error(`scopeProbe: invalidate must be 'round' or 'all', got ${invalidate}`);
  return evaluateInContentScript(context, page, `(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ${reset};
    const scope = ctx.resolvePageScope();
    return { roots: scope.roots.map((root) => root.tagName), share: scope.share };
  })()`);
}

/** Wait until the content script's settings carry `key: value`. */
function settingsSettled(context, page, key, value) {
  return expect.poll(() => evaluateInContentScript(context, page,
    `window.AI_TRANSLATOR_CONTENT.settings[${JSON.stringify(key)}]`), { timeout: 10000 }).toBe(value);
}

module.exports = {
  serveHtml,
  scopeProbe,
  settingsSettled,
};
