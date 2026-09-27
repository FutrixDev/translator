// The PDF / comic hint and the Alt+M media shortcut (content/content-media-hints.js,
// D-353), run for real in a vm page rather than matched as source text: every
// property here is about *which message goes out when*, and a regex over the
// source cannot tell "sent on click" from "sent on load".
//
// AccountGate and PdfUrl are the real shared modules, so "off" versus "signed
// out" is answered by the one gate the rest of the extension uses.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SOURCES = [
  'shared/account-gate.js',
  'shared/pdf-url.js',
  'content/content-media-hints.js',
].map((rel) => [rel, read(rel)]);

const PDF_URL = 'https://arxiv.org/pdf/2501.00001';
const COMIC_URL = 'https://comics.example/read/1';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One page.
 * - `kind`: 'pdf' (a PDF document at a PDF URL), 'comic' (a stack of comic pages
 *   on screen), or 'plain'.
 * - `enabled`: the raw sync switch; `signedIn`: the device holds a token.
 * - `replies`: message type -> reply the service worker gives.
 * - `shortcut`: what chrome.commands says for translate-media (null = not asked yet).
 */
function load({ kind = 'pdf', enabled = true, signedIn = false, replies = {}, shortcut = 'Alt+M', visible = true } = {}) {
  const sent = [];
  const documentListeners = {};
  const offers = [];
  const notices = [];
  const comicStarts = [];
  const settings = { enableComicTranslation: enabled, enablePdfTranslation: enabled };
  const ctx = {
    t: (key) => key,
    settings,
    signedIn,
    comic: { hasComicStack: () => kind === 'comic' },
    hasComicPageOnScreen: () => kind === 'comic',
    startComicPageTranslation: (options) => { comicStarts.push(JSON.parse(JSON.stringify(options))); },
    showAutoStatusOffer: (offer) => { offers.push(offer); },
    showAutoStatusNotice: (text) => { notices.push(text); },
    commandShortcut: () => shortcut,
    onCommandShortcuts() {},
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout,
    URL,
    requestAnimationFrame: () => 0,
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          // Plain copies: objects built in the vm realm fail deepStrictEqual
          // against this realm's literals on prototype alone.
          sent.push(JSON.parse(JSON.stringify(message)));
          const reply = replies[message.type] || { ok: true };
          if (callback) setImmediate(() => callback(reply));
        },
      },
    },
    location: { href: kind === 'pdf' ? PDF_URL : COMIC_URL, hostname: kind === 'pdf' ? 'arxiv.org' : 'comics.example' },
    document: {
      ...(kind === 'pdf'
        ? { contentType: 'application/pdf', body: null }
        : { contentType: 'text/html', body: { childElementCount: 3 } }),
      visibilityState: visible ? 'visible' : 'hidden',
      addEventListener(type, fn) { documentListeners[type] = fn; },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx, addEventListener() {} };
  vm.createContext(sandbox);
  for (const [filename, source] of SOURCES) vm.runInContext(source, sandbox, { filename });
  // The page's featureState is the gate's, over this page's settings and sign-in.
  ctx.featureState = (key) => sandbox.AccountGate.featureState(ctx.settings, key, ctx.signedIn);
  const lastOffer = () => offers[offers.length - 1] || null;
  const show = () => {
    sandbox.document.visibilityState = 'visible';
    documentListeners.visibilitychange();
  };
  return { ctx, sent, offers, notices, comicStarts, settings, lastOffer, show };
}

const types = (sent) => sent.map((m) => m.type);

// ------------------------------------------------------------ the hint

test('PDF signed out: the hint shows with the shortcut, and nothing is sent', async () => {
  const page = load({ kind: 'pdf', signedIn: false });
  page.ctx.setupMediaHints();
  await flush();
  const offer = page.lastOffer();
  assert.ok(offer, 'no hint on a PDF while signed out');
  assert.equal(offer.text, 'mediaHintPdf');
  assert.equal(offer.link, null);
  assert.deepEqual(page.sent, [], 'the hint sent a message before any click');
});

test('PDF switched off by the user: no hint', async () => {
  const page = load({ kind: 'pdf', enabled: false, signedIn: true });
  page.ctx.setupMediaHints();
  await flush();
  assert.equal(page.lastOffer(), null);
  assert.deepEqual(page.sent, []);
});

test('an unbound shortcut turns the text generic and adds the settings link', async () => {
  const page = load({ kind: 'pdf', shortcut: '' });
  page.ctx.setupMediaHints();
  await flush();
  const offer = page.lastOffer();
  assert.equal(offer.text, 'pdfAskPrompt');
  assert.equal(offer.link.text, 'mediaHintSetShortcut');
  offer.link.onClick();
  assert.deepEqual(types(page.sent), ['OPEN_SHORTCUT_SETTINGS']);
});

test('comic stack signed out: the host is claimed, and the hint shows only on a won claim', async () => {
  const won = load({ kind: 'comic', replies: { COMIC_HINT_WRITE: { value: true } } });
  won.ctx.setupMediaHints();
  await flush();
  assert.deepEqual(won.sent, [{ type: 'COMIC_HINT_WRITE', kind: 'claim', host: 'comics.example' }]);
  assert.equal(won.lastOffer().text, 'mediaHintComic');

  const seen = load({ kind: 'comic', replies: { COMIC_HINT_WRITE: { value: false } } });
  seen.ctx.setupMediaHints();
  await flush();
  assert.equal(seen.lastOffer(), null, 'a host that has had its hint got it again');
});

test('a comic reader in a background tab claims the host only once it is shown', async () => {
  // One claim per host: a tab opened in the background (or a prerender) that
  // took it would spend the hint where nobody could see it.
  const page = load({ kind: 'comic', visible: false, replies: { COMIC_HINT_WRITE: { value: true } } });
  page.ctx.setupMediaHints();
  await flush();
  assert.deepEqual(page.sent, [], 'a hidden tab claimed the host');
  assert.equal(page.lastOffer(), null);

  page.show();
  await flush();
  assert.deepEqual(types(page.sent), ['COMIC_HINT_WRITE']);
  assert.equal(page.lastOffer().text, 'mediaHintComic');
});

test('comic switched off by the user: not even the claim is sent', async () => {
  const page = load({ kind: 'comic', enabled: false, signedIn: true });
  page.ctx.setupMediaHints();
  await flush();
  assert.deepEqual(page.sent, []);
  assert.equal(page.lastOffer(), null);
});

// ------------------------------------------------------------ the shortcut

test('the shortcut dispatches on what the page is', async () => {
  const pdf = load({ kind: 'pdf', signedIn: true });
  assert.equal(pdf.ctx.runMediaShortcut(), 'pdf');
  await flush();
  assert.deepEqual(pdf.sent, [{ type: 'PDF_TRANSLATE_URL', url: PDF_URL, consent: true }]);

  const comic = load({ kind: 'comic', signedIn: true });
  assert.equal(comic.ctx.runMediaShortcut(), 'comic');
  await flush();
  assert.deepEqual(comic.comicStarts, [{ pageUrl: COMIC_URL, consent: true }]);

  const plain = load({ kind: 'plain', signedIn: true });
  assert.equal(plain.ctx.runMediaShortcut(), null);
  await flush();
  assert.deepEqual(plain.sent, []);
  assert.deepEqual(plain.notices, ['mediaShortcutNothing']);
});

test('signed out: sign in first, then carry on with the same PDF', async () => {
  const page = load({ kind: 'pdf', signedIn: false });
  page.ctx.setupMediaHints();
  page.lastOffer().accept();
  await flush();
  await flush();
  assert.deepEqual(types(page.sent), ['COMIC_SIGN_IN', 'PDF_TRANSLATE_URL']);
  // The job took over; the bar is gone.
  assert.equal(page.lastOffer(), null);
});

test('a cancelled sign-in stops silently and puts the bar back as it was', async () => {
  const page = load({
    kind: 'pdf', signedIn: false,
    replies: { COMIC_SIGN_IN: { ok: false, error: { code: 'sign_in_cancelled' } } },
  });
  page.ctx.setupMediaHints();
  page.lastOffer().accept();
  assert.equal(page.lastOffer().busy, true, 'the button is not held while signing in');
  await flush();
  await flush();
  assert.deepEqual(types(page.sent), ['COMIC_SIGN_IN']);
  assert.deepEqual(page.notices, []);
  const offer = page.lastOffer();
  assert.equal(offer.text, 'mediaHintPdf');
  assert.equal(offer.busy, false);
});

test('a failed sign-in says so and does not start the job', async () => {
  const page = load({
    kind: 'comic', signedIn: false,
    replies: { COMIC_SIGN_IN: { ok: false, error: { code: 'sign_in_failed' } } },
  });
  page.ctx.runMediaShortcut();
  await flush();
  await flush();
  assert.deepEqual(page.comicStarts, []);
  assert.deepEqual(page.notices, ['comicSignInFailed']);
});

test('switched off but signed in: the shortcut is consent for this page, the setting stays off', async () => {
  const page = load({ kind: 'pdf', enabled: false, signedIn: true });
  assert.equal(page.ctx.runMediaShortcut(), 'pdf');
  await flush();
  assert.deepEqual(page.sent, [{ type: 'PDF_TRANSLATE_URL', url: PDF_URL, consent: true }]);
  assert.equal(page.settings.enablePdfTranslation, false);
});

test('a second press while the first is still signing in does not dispatch twice', async () => {
  const page = load({ kind: 'pdf', signedIn: false });
  page.ctx.runMediaShortcut();
  page.ctx.runMediaShortcut();
  await flush();
  await flush();
  assert.deepEqual(types(page.sent), ['COMIC_SIGN_IN', 'PDF_TRANSLATE_URL']);
});

// ------------------------------------------------------------ what counts as a comic reader

function img(left, top, width, height) {
  const rect = { left, top, width, height, right: left + width, bottom: top + height };
  return { tagName: 'IMG', isConnected: true, naturalWidth: 800, naturalHeight: 1200, getBoundingClientRect: () => rect };
}

function comicShelf(images) {
  const ctx = { t: (key) => key, renderedArea: (image) => {
    const rect = image.getBoundingClientRect();
    return rect.width * rect.height;
  } };
  // The e2e window: 1280x720.
  const window = { AI_TRANSLATOR_CONTENT: ctx, innerWidth: 1280, innerHeight: 720 };
  const getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
  const sandbox = { window, document: { images }, console, getComputedStyle };
  vm.createContext(sandbox);
  vm.runInContext(read('content/comic/pages.js'), sandbox, { filename: 'content/comic/pages.js' });
  return ctx.comic;
}

test('three tall pages stacked top to bottom are a comic reader', () => {
  const stack = [img(100, 0, 600, 900), img(100, 900, 600, 900), img(100, 1800, 600, 900)];
  assert.equal(comicShelf(stack).hasComicStack(), true);
});

test('two pages, one big picture, or a grid row are not', () => {
  assert.equal(comicShelf([img(100, 0, 600, 900), img(100, 900, 600, 900)]).hasComicStack(), false);
  assert.equal(comicShelf([img(0, 0, 1200, 1600)]).hasComicStack(), false);
  // Three side by side: every one starts a new column.
  const row = [img(0, 0, 300, 450), img(320, 0, 300, 450), img(640, 0, 300, 450)];
  assert.equal(comicShelf(row).hasComicStack(), false);
  // Icons in a column are furniture, not pages.
  const icons = [img(0, 0, 40, 40), img(0, 50, 40, 40), img(0, 100, 40, 40)]
    .map((i) => ({ ...i, naturalWidth: 40, naturalHeight: 40 }));
  assert.equal(comicShelf(icons).hasComicStack(), false);
});

test('a feed or an article is a column of pictures too far apart to be pages', () => {
  // X: 506x285 pictures, a tweet's worth of text between them.
  const feed = [img(100, 0, 506, 285), img(100, 1085, 506, 285), img(100, 2170, 506, 285)];
  assert.equal(comicShelf(feed).hasComicStack(), false);
  // Tall pictures with a caption line under each: past 40 px even though a
  // tenth of the picture would allow more.
  const article = [img(100, 0, 600, 900), img(100, 950, 600, 900), img(100, 1900, 600, 900)];
  assert.equal(comicShelf(article).hasComicStack(), false);
  // Small pictures a caption apart: under 40 px but past a tenth of the height.
  // Four of them, so the column is wide and tall enough and only the gap says no.
  const small = [0, 1, 2, 3].map((i) => img(100, i * 230, 300, 200));
  assert.equal(comicShelf(small).hasComicStack(), false);
  // A reader that frames its pages with a margin still counts.
  const framed = [img(100, 0, 600, 900), img(100, 940, 600, 900), img(100, 1880, 600, 900)];
  assert.equal(comicShelf(framed).hasComicStack(), true);
});

test('a flush column of thumbnails is not a reader: pages are wide and outrun the screen', () => {
  // The sspai.com sidebar: four 222x139 cards, no gap, one centred on the next.
  const cards = [0, 1, 2, 3].map((i) => img(161, 332 + i * 139, 222, 139));
  assert.equal(comicShelf(cards).hasComicStack(), false);
  // Too narrow, however tall the column: 4 x 300 = 1200 px, but 222 wide.
  const narrow = [0, 1, 2, 3].map((i) => img(161, i * 300, 222, 300));
  assert.equal(comicShelf(narrow).hasComicStack(), false);
  // Wide, but the whole run is shorter than the 720 px window: 3 x 200.
  const short = [0, 1, 2].map((i) => img(100, i * 200, 600, 200));
  assert.equal(comicShelf(short).hasComicStack(), false);
  // webtoons.com: 700x1140 slices joined with no gap.
  const strip = [0, 1, 2].map((i) => img(290, i * 1140, 700, 1140));
  assert.equal(comicShelf(strip).hasComicStack(), true);
});

test('pages side by side in a zigzag are not a stack, however flush', () => {
  // Each one starts where the last one ended, but in the other column.
  const zigzag = [img(0, 0, 600, 900), img(640, 900, 600, 900), img(0, 1800, 600, 900)];
  assert.equal(comicShelf(zigzag).hasComicStack(), false);
});

test('pages overlapping half their height are a staircase, not a stack', () => {
  // Offset sideways enough to be separate pictures (a quarter of each covers
  // the next), centred over the one before, and each starting halfway up it.
  const staircase = [img(0, 0, 600, 900), img(280, 450, 600, 900), img(0, 900, 600, 900)];
  assert.equal(comicShelf(staircase).hasComicStack(), false);
});

test('a placeholder under each page is the same page, not a second one', () => {
  // Lazy readers: a low-resolution copy in the box, the artwork loaded over it.
  const layered = [0, 1, 2].flatMap((i) => [
    { ...img(100, i * 900, 600, 900), naturalWidth: 400, naturalHeight: 600 },
    img(100, i * 900, 600, 900),
  ]);
  assert.equal(comicShelf(layered).hasComicStack(), true);
});

test('a stack counts only once one of its pages is on screen', () => {
  // All of it below the 720 px fold: the offer would act on nothing.
  const below = [0, 1, 2].map((i) => img(100, 800 + i * 900, 600, 900));
  assert.equal(comicShelf(below).hasComicStack(), false);
  // A picture on screen that is not one of the pages does not make it count.
  const beside = [img(760, 0, 400, 500), ...below];
  assert.equal(comicShelf(beside).hasComicStack(), false);
  // Scrolled down to it.
  const reached = [0, 1, 2].map((i) => img(100, 300 + i * 900, 600, 900));
  assert.equal(comicShelf(reached).hasComicStack(), true);
  // Deep into a long strip: only the fourth page shows, and the run it ends counts.
  const deep = [0, 1, 2, 3].map((i) => img(100, -2800 + i * 900, 600, 900));
  assert.equal(comicShelf(deep).hasComicStack(), true);
});

// ------------------------------------------------------------ the service-worker half

test('a host is claimed once: the first tab wins, every later one loses', async () => {
  const sync = {};
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...sync }),
        set: async (values) => { Object.assign(sync, values); },
      },
    },
  };
  const { comicHintWriter, COMIC_HINT_HOSTS_KEY } = await import('../../background/media-hints.js');
  const claims = await Promise.all([
    comicHintWriter.applyWrite({ kind: 'claim', host: 'comics.example' }),
    comicHintWriter.applyWrite({ kind: 'claim', host: 'comics.example' }),
    comicHintWriter.applyWrite({ kind: 'claim', host: 'other.example' }),
  ]);
  assert.deepEqual(claims, [true, false, true]);
  assert.deepEqual(sync[COMIC_HINT_HOSTS_KEY], ['comics.example', 'other.example']);
});

// ------------------------------------------------------------ the failure notification

test('"sign in to translate documents" carries a Sign In button; other failures do not', async () => {
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://x/${p}`, lastError: undefined },
    storage: { sync: { get: async (defaults) => ({ ...defaults }) } },
    notifications: { create: (...args) => { created.push(args); } },
  };
  const notify = await import('../../background/pdf-notify.js');
  await notify.notifyPdfError({ error: { code: 'unauthorized', message: 'Sign in' } });
  await notify.notifyPdfError({ code: 'network_error' });
  const [signIn, other] = created;
  assert.equal(typeof signIn[0], 'string');
  assert.ok(signIn[0].startsWith(notify.PDF_SIGNIN_NOTIFICATION_PREFIX));
  assert.equal(signIn[1].buttons.length, 1);
  assert.equal(typeof other[0], 'object', 'an ordinary failure got an id of its own');
  assert.equal(other[0].buttons, undefined);
});

test('the Sign In button opens the popup\'s own sign-in, and only that button does', () => {
  const jobs = read('background/pdf-jobs.js');
  const arm = jobs.slice(jobs.indexOf('startsWith(PDF_SIGNIN_NOTIFICATION_PREFIX)'));
  assert.match(arm.slice(0, 400), /comicClient\.signIn\(\)/);
  assert.equal([...jobs.matchAll(/comicClient\.signIn\(/g)].length, 1);
});
