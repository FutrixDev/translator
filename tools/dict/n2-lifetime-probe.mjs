#!/usr/bin/env node
// Does Chrome's own MV3 lifetime rule stop the extension's service worker while
// it downloads a dictionary pack (N2, docs/delivery/taskbooks/offline-dict-n2.md)?
//
//   node tools/dict/n2-lifetime-probe.mjs --variant v1|v2 [--pair en-zh-CN] [--lang zh-CN]
//        [--seconds 105] [--retries 0] [--settle 180] [--packs <dir>]
//
// Not a gate: it takes minutes, opens a headed browser, and reads real packs from
// build/dict/out (git-ignored, see tools/dict/README.md). Nothing here is Playwright
// and nothing attaches DevTools to the service worker while a pack is in flight:
// an attached DevTools session keeps the worker alive (test/e2e/helpers.js,
// recycleWorker), which is the one thing this probe exists to not do.
//
//   1. A local HTTPS server (self-signed, openssl) stands in for dl.blab-translation.com.
//      The browser reaches it through --host-resolver-rules; the extension's
//      DOWNLOAD_ORIGIN is untouched. The manifest answers at once, its one row built
//      from the bytes served (test/e2e/dict-pack-server.js rowFor). The pack is the
//      real file build/dict/out/<pair>/<pair>.json, Cache-Control: no-store.
//        v1  headers at once, body throttled so the transfer takes --seconds;
//        v2  headers held 35 s, then the body at full speed.
//      Every second the server logs the bytes sent per pack request; a client that
//      closes before EOF is logged with its time.
//   2. The bundled Chromium (Playwright's download, launched with child_process) gets a
//      fresh profile, --lang, the unpacked extension from this checkout and a remote
//      debugging port. A fresh install fires onInstalled, and the preinstall
//      (background/dict-packs.js onDictInstalled) fetches en -> the effective target
//      language: with targetLang unset that is the browser's language.
//   3. While the pack is in flight the probe only polls GET /json/list once a second
//      (plain HTTP, no attach) and logs when the extension's service_worker target
//      appears and disappears.
//   4. The window ends when the pack response has ended (EOF or the client closed) and
//      the worker target is gone (or --settle seconds later). Only then the probe
//      attaches: to the onboarding page the install opened (storage as the stopped
//      worker left it), then, with browser-level auto-attach so the next worker's
//      console is caught, to a newly opened options page, whose load sends
//      DICT_PACK_RECOVER and wakes a worker.
//   5. --retries N: after an interrupted install, N times: send DICT_PACK_WANT from the
//      onboarding page the way a lookup does (attach, send, detach), then the same
//      passive window. The server log says whether each retry downloaded from byte 0.
//
// Exit 0 when the pack is listed in dict:packs at the manifest's version at the end of
// the first window, 1 otherwise (the reason is printed), 2 on a usage error, 128 + the
// signal on SIGINT or SIGTERM. Every way out stops the browser (SIGTERM, SIGKILL if it
// is still running 5 s later) before its profile is removed.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);

const HOST = 'dl.blab-translation.com';
const MANIFEST_PATH = '/dict/v1/manifest.json';
const V2_HEADER_DELAY_S = 35;
const STOP_SLACK_MS = 2500;
const SW_SCRIPT = '/background/background.js';
const T0 = Date.now();

// ---- arguments -----------------------------------------------------------------

function usage(message) {
  console.error(`n2-lifetime-probe: ${message}\nusage: n2-lifetime-probe.mjs --variant v1|v2 `
    + '[--pair en-zh-CN] [--lang zh-CN] [--seconds 105] [--retries 0] [--settle 180] [--packs <dir>]');
  process.exit(2);
}

// The packs are build output of the main checkout (git-ignored); a worktree has none.
function defaultPacksDir() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  return path.join(path.dirname(common), 'build', 'dict', 'out');
}

function parseArgs(argv) {
  const args = { variant: null, pair: 'en-zh-CN', lang: 'zh-CN', seconds: 105, retries: 0, settle: 180, packs: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args) || !argv[i].startsWith('--')) usage(`unknown argument ${argv[i]}`);
    const value = argv[++i];
    if (value === undefined) usage(`--${key} needs a value`);
    args[key] = typeof args[key] === 'number' ? Number(value) : value;
    if (typeof args[key] === 'number' && !(args[key] >= 0)) usage(`--${key} is not a number`);
  }
  if (args.variant !== 'v1' && args.variant !== 'v2') usage('--variant must be v1 or v2');
  args.packs = args.packs || defaultPacksDir();
  return args;
}

// ---- logging -------------------------------------------------------------------

const rel = (at = Date.now()) => `+${((at - T0) / 1000).toFixed(3)}s`;
function log(event, fields = {}) {
  const at = Date.now();
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  console.log(`[${new Date(at).toISOString()} ${rel(at)}] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the stand-in download host ---------------------------------------------------

function selfSignedCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** The manifest row the build writes for these bytes (test/e2e/dict-pack-server.js rowFor). */
function rowFor(bytes) {
  const pack = JSON.parse(bytes.toString('utf8'));
  return {
    src: pack.src,
    tgt: pack.tgt,
    ver: pack.ver,
    url: `dict/v1/${pack.src}-${pack.tgt}/${pack.ver}/pack.json`,
    bytes: bytes.length,
    rawBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    heads: Object.keys(pack.e).length,
  };
}

class PackServer {
  constructor({ tls, bytes, row, variant, rate }) {
    this.bytes = bytes;
    this.row = row;
    this.variant = variant;
    this.rate = rate; // bytes per second for v1
    this.requests = []; // every pack request: {id, start, range, sent, end, eof, closedEarly}
    this.manifestHits = 0;
    this.waiters = new Set();
    this.server = https.createServer(tls, (req, res) => this.handle(req, res));
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    clearInterval(this.ticker);
    this.server.closeAllConnections();
    this.server.close();
  }

  tick() {
    for (const r of this.requests) {
      if (r.end) continue;
      log('server bytes', { req: r.id, sent: r.sent, total: this.bytes.length, pct: +(100 * r.sent / this.bytes.length).toFixed(1) });
    }
  }

  notify() {
    for (const fn of this.waiters) fn();
  }

  /** Resolves with the pack request numbered `id` once its response has ended. */
  ended(id) {
    return new Promise((resolve) => {
      const check = () => {
        const r = this.requests[id - 1];
        if (r && r.end) {
          this.waiters.delete(check);
          resolve(r);
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Resolves once pack request `id` has arrived, or with null after `ms`. */
  arrived(id, ms) {
    return Promise.race([
      new Promise((resolve) => {
        const check = () => {
          if (this.requests[id - 1]) {
            this.waiters.delete(check);
            resolve(this.requests[id - 1]);
          }
        };
        this.waiters.add(check);
        check();
      }),
      sleep(ms).then(() => null),
    ]);
  }

  handle(req, res) {
    const at = new URL(req.url, `https://${HOST}`).pathname;
    if (at === MANIFEST_PATH) {
      this.manifestHits += 1;
      log('server manifest', { hit: this.manifestHits });
      const body = JSON.stringify({ v: 1, packs: [this.row] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (at !== `/${this.row.url}`) {
      log('server 404', { path: at });
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const r = { id: this.requests.length + 1, start: Date.now(), range: req.headers.range || null, sent: 0, end: null, eof: false, closedEarly: false };
    this.requests.push(r);
    log('server pack request', { req: r.id, range: r.range, variant: this.variant });
    this.notify();
    res.on('close', () => {
      if (r.end) return;
      r.end = Date.now();
      r.eof = res.writableFinished;
      r.closedEarly = !res.writableFinished;
      log(r.closedEarly ? 'server client closed before EOF' : 'server pack EOF',
        { req: r.id, sent: r.sent, total: this.bytes.length, seconds: +((r.end - r.start) / 1000).toFixed(3) });
      this.notify();
    });
    this.send(r, res).catch((error) => log('server send error', { req: r.id, error: String(error) }));
  }

  async send(r, res) {
    if (this.variant === 'v2') {
      await sleep(V2_HEADER_DELAY_S * 1000);
      if (res.destroyed) return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': this.bytes.length });
    log('server pack headers sent', { req: r.id });
    const total = this.bytes.length;
    // v1: a slice every 100 ms; v2: as fast as the socket drains.
    const slice = this.variant === 'v1' ? Math.max(1, Math.round(this.rate / 10)) : 256 * 1024;
    while (r.sent < total && !res.destroyed) {
      const next = Math.min(total, r.sent + slice);
      const ok = res.write(this.bytes.subarray(r.sent, next));
      r.sent = next;
      if (!ok) {
        await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      // No pause after the last slice: the client has the whole body and may close first.
      if (this.variant === 'v1' && r.sent < total) await sleep(100);
    }
    if (!res.destroyed) res.end();
  }
}

// ---- the browser -----------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function chromiumPath() {
  // Only the path: the browser itself is spawned below, not through Playwright.
  return require('playwright-core').chromium.executablePath();
}

async function jsonList(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  return response.json();
}

/** A minimal CDP client over the built-in WebSocket; only used after a window ends. */
class Cdp {
  static async connect(url) {
    const cdp = new Cdp(new WebSocket(url));
    await new Promise((resolve, reject) => {
      cdp.ws.addEventListener('open', resolve, { once: true });
      cdp.ws.addEventListener('error', reject, { once: true });
    });
    return cdp;
  }

  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.handlers) fn(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) {
    this.handlers.push(fn);
  }

  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails)}`);
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

const STORAGE_READ = `(async () => {
  const keys = ['dict:status', 'dict:packs', 'dict:declined'];
  const got = await chrome.storage.local.get(keys);
  const all = await chrome.storage.local.getKeys();
  return { status: got['dict:status'] || null, packs: got['dict:packs'] || null, declined: got['dict:declined'] || null,
    pairKeys: all.filter((k) => k.startsWith('d:')).length, language: navigator.language };
})()`;

// ---- the run -----------------------------------------------------------------------

class Probe {
  constructor(args) {
    this.args = args;
    this.worker = null; // {id, since} while the service_worker target is listed
    this.workerSpans = []; // [{targetId, appeared, disappeared}]
    this.extensionId = null;
    this.polling = null;
  }

  async start() {
    const { args } = this;
    const file = path.join(args.packs, args.pair, `${args.pair}.json`);
    if (!existsSync(file)) usage(`no pack at ${file}`);
    const bytes = readFileSync(file);
    const row = rowFor(bytes);
    const rate = Math.round(bytes.length / Math.max(1, args.seconds));
    this.tmp = mkdtempSync(path.join(os.tmpdir(), 'n2-probe-'));
    const tls = selfSignedCert(this.tmp);
    this.server = new PackServer({ tls, bytes, row, variant: args.variant, rate });
    this.port = await this.server.listen();
    this.cdpPort = await freePort();
    this.row = row;
    log('probe start', {
      variant: args.variant, pair: args.pair, ver: row.ver, bytes: bytes.length, sha256: row.sha256,
      rateBytesPerSecond: args.variant === 'v1' ? rate : 'unthrottled', headerDelaySeconds: args.variant === 'v2' ? V2_HEADER_DELAY_S : 0,
      serverPort: this.port, cdpPort: this.cdpPort,
    });
    const profile = path.join(this.tmp, 'profile');
    const chromeArgs = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${this.cdpPort}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      `--lang=${args.lang}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${this.port}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];
    log('chromium launch', { path: chromiumPath(), args: chromeArgs });
    this.chrome = spawn(chromiumPath(), chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.chrome.stderr.on('data', () => {}); // drained, not logged: Chromium is noisy
    this.chrome.on('exit', (code, signal) => log('chromium exit', { code, signal }));
    this.polling = this.poll();
  }

  // GET /json/list once a second: plain HTTP, attaches to nothing.
  async poll() {
    for (;;) {
      if (this.stopped) return;
      let targets = null;
      try {
        targets = await jsonList(this.cdpPort);
      } catch {
        // The browser is not listening yet (or is gone); the next tick asks again.
      }
      if (targets) this.observe(targets);
      await sleep(1000);
    }
  }

  observe(targets) {
    const sw = targets.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith(SW_SCRIPT));
    if (sw && !this.extensionId) {
      this.extensionId = new URL(sw.url).host;
      log('extension id', { id: this.extensionId });
    }
    this.pages = targets.filter((t) => t.type === 'page');
    if (sw && (!this.worker || this.worker.id !== sw.id)) {
      if (this.worker) this.gone();
      this.worker = { id: sw.id, since: Date.now() };
      this.workerSpans.push({ targetId: sw.id, appeared: this.worker.since, disappeared: null });
      log('worker appeared', { targetId: sw.id });
    } else if (!sw && this.worker) {
      this.gone();
    }
  }

  gone() {
    const span = this.workerSpans[this.workerSpans.length - 1];
    span.disappeared = Date.now();
    log('worker disappeared', { targetId: this.worker.id, livedSeconds: +((span.disappeared - span.appeared) / 1000).toFixed(1) });
    this.worker = null;
  }

  async until(predicate, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(250);
    }
    log('timeout', { waitingFor: what, seconds: ms / 1000 });
    return false;
  }

  /**
   * One passive window for pack request `id`: wait for it, for its end, then for the
   * worker to go (or --settle). Returns what the server saw.
   */
  async window(id) {
    const arrived = await this.server.arrived(id, 60_000);
    if (!arrived) return { request: null, reason: 'no pack request within 60 s' };
    const request = await Promise.race([
      this.server.ended(id),
      sleep((V2_HEADER_DELAY_S + this.args.seconds + 300) * 1000).then(() => null),
    ]);
    if (!request) return { request: this.server.requests[id - 1], reason: 'the pack response never ended' };
    log('window: pack response ended', { req: id, eof: request.eof, sent: request.sent });
    await this.until(() => !this.worker, this.args.settle * 1000, 'the worker to stop after the transfer');
    // A stop the 1 s poll sees up to STOP_SLACK_MS after the socket closed is the
    // stop that closed it: the browser tears the worker's fetch down with it.
    const stops = this.workerSpans.filter((s) => s.disappeared && s.disappeared >= request.start && s.disappeared <= request.end + STOP_SLACK_MS);
    log('window: worker stops during the transfer', { req: id, stops: stops.length,
      at: stops.map((s) => rel(s.disappeared)), secondsAfterRequest: stops.map((s) => +((s.disappeared - request.start) / 1000).toFixed(1)) });
    return { request, workerStopsDuringTransfer: stops.length };
  }

  findPage(pathPrefix) {
    return (this.pages || []).find((t) => t.url.startsWith(`chrome-extension://${this.extensionId}${pathPrefix}`));
  }

  /** Storage through an already open extension page: attaches the page only. */
  async readThroughPage(pathPrefix) {
    const page = this.findPage(pathPrefix);
    if (!page) return null;
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    try {
      return await cdp.evaluate(STORAGE_READ);
    } finally {
      cdp.close();
    }
  }

  /**
   * Open the settings page with browser-level auto-attach on, so the worker its
   * DICT_PACK_RECOVER wakes is caught from its first line; read storage there once the
   * recovery has had its turn; detach everything and close the page.
   */
  async readAfterWake() {
    const version = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`)).json();
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const sessions = new Map(); // sessionId -> {type, url}
    const consoleLines = [];
    cdp.on((msg) => {
      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo, waitingForDebugger } = msg.params;
        sessions.set(sessionId, targetInfo);
        const go = async () => {
          if (targetInfo.type === 'service_worker') await cdp.send('Runtime.enable', {}, sessionId);
          if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        };
        go().catch((error) => log('attach error', { type: targetInfo.type, error: String(error) }));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && sessions.get(msg.sessionId)?.type === 'service_worker') {
        const text = msg.params.args.map((a) => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.preview ? JSON.stringify(Object.fromEntries((a.preview.properties || []).map((p) => [p.name, p.value]))) : a.description)).join(' ');
        consoleLines.push({ type: msg.params.type, text });
        log('worker console', { type: msg.params.type, text });
      }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${this.extensionId}/options/options.html` });
    await sleep(8000); // DICT_PACK_RECOVER: one queued job of a few storage calls
    const pageSession = [...sessions.entries()].find(([, info]) => info.targetId === targetId);
    let storage = null;
    if (pageSession) storage = await cdp.evaluate(STORAGE_READ, pageSession[0]);
    await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    for (const sessionId of sessions.keys()) {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    await cdp.send('Target.closeTarget', { targetId });
    cdp.close();
    return { storage, consoleLines };
  }

  /** DICT_PACK_WANT from the onboarding page, as a lookup sends it; the page is detached at once. */
  async sendWant() {
    const page = this.findPage('/onboarding/');
    if (!page) throw new Error('the onboarding page is not open');
    const { src, tgt } = this.row;
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    try {
      return await cdp.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'DICT_PACK_WANT', src, tgt })})`);
    } finally {
      cdp.close();
    }
  }

  installed(storage) {
    const item = storage && storage.packs && storage.packs[this.args.pair];
    return Boolean(item) && item.ver === this.row.ver;
  }

  summary(label, result, before, after) {
    const r = result.request;
    log(`RESULT ${label}`, {
      serverRequest: r ? { id: r.id, range: r.range, sent: r.sent, total: this.row.bytes, eof: r.eof, closedEarly: r.closedEarly,
        startedAt: rel(r.start), endedAt: r.end ? rel(r.end) : null } : null,
      workerSpans: this.workerSpans.map((s) => ({ targetId: s.targetId.slice(0, 8), appeared: rel(s.appeared), disappeared: s.disappeared ? rel(s.disappeared) : null })),
      storageBeforeWake: before,
      storageAfterWake: after && after.storage,
      interruptedWarnings: after ? after.consoleLines.filter((l) => l.text.includes('dictionary pack interrupted')).length : null,
    });
  }

  async run() {
    await this.start();
    if (!(await this.until(() => this.extensionId, 30_000, 'the extension service worker'))) return { code: 1, reason: 'no service worker' };
    log('trigger', { how: 'onInstalled preinstall (fresh profile, targetLang unset, --lang)' });
    const first = await this.window(1);
    if (!first.request) return { code: 1, reason: first.reason };
    const before = await this.readThroughPage('/onboarding/');
    log('storage before wake (onboarding page)', before);
    const after = await this.readAfterWake();
    this.summary('first install', first, before, after);
    const ok = this.installed(after.storage);
    let reason = 'installed';
    if (!ok) {
      const r = first.request;
      reason = [
        first.workerStopsDuringTransfer ? `the worker stopped ${first.workerStopsDuringTransfer}x during the transfer` : 'the worker was not seen stopping during the transfer',
        r.closedEarly ? `client closed after ${r.sent}/${this.row.bytes} bytes` : `server sent EOF (${r.sent} bytes)`,
        `status after wake: ${JSON.stringify((after.storage && after.storage.status) || null)}`,
      ].join('; ');
    }
    const retries = [];
    for (let n = 1; n <= this.args.retries; n++) {
      // A worker the read above woke is left to stop by itself first, so the retry's
      // worker is as fresh as a lookup's on a new page.
      await this.until(() => !this.worker, this.args.settle * 1000, 'the woken worker to stop before the retry');
      const reply = await this.sendWant();
      log(`retry ${n}: DICT_PACK_WANT`, { reply });
      if (!reply || reply.state !== 'queued') {
        retries.push({ n, reply, request: null });
        break;
      }
      const result = await this.window(this.server.requests.length + 1);
      const rb = await this.readThroughPage('/onboarding/');
      const ra = await this.readAfterWake();
      this.summary(`retry ${n}`, result, rb, ra);
      const r = result.request;
      retries.push({ n, reply, range: r && r.range, sent: r && r.sent, eof: r && r.eof, installed: this.installed(ra.storage) });
      if (this.installed(ra.storage)) break;
    }
    if (this.args.retries) log('RESULT retries', { retries });
    return { code: ok ? 0 : 1, reason };
  }

  /** Once, whoever asks first (the run's end or a signal); later calls share it. */
  stop() {
    if (!this.stopping) this.stopping = this.shutDown();
    return this.stopping;
  }

  async shutDown() {
    this.stopped = true;
    const chrome = this.chrome;
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
        log('chromium still running 5 s after SIGTERM: SIGKILL', { pid: chrome.pid });
        chrome.kill('SIGKILL');
        await exited;
      }
    }
    if (this.server) this.server.close();
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }
}

const probe = new Probe(parseArgs(process.argv.slice(2)));
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 };
for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
  process.once(signal, async () => {
    log('probe interrupted', { signal });
    await probe.stop();
    process.exit(code);
  });
}
let outcome;
try {
  outcome = await probe.run();
} catch (error) {
  outcome = { code: 1, reason: `probe error: ${error.stack || error}` };
} finally {
  await probe.stop();
}
log(outcome.code === 0 ? 'PROBE installed' : 'PROBE not installed', { reason: outcome.reason });
process.exit(outcome.code);
