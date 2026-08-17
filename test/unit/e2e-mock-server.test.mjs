// Guards for the E2E mock server — test/e2e/mock-server.js.
//
// The bug these exist for: `new Promise(done => server.close(done))`. Node stops
// listening at once and reaps idle keep-alive sockets, but a socket that has
// connected and sent no request bytes counts as a request still arriving, and it
// is held until `server.headersTimeout` — 60 seconds by default. Chrome opens
// exactly such a socket: it speculatively preconnects a second connection to the
// origin it is navigating to, and often sends nothing on it.
//
// So `await service.close()` in a spec's finally block returned instantly almost
// always, and once in every dozen full-suite runs sat there for the whole
// minute. The test had already passed every assertion in its body; Playwright
// killed it at the test timeout and reported a bare "Test timeout of 60000ms
// exceeded" with no call log, because the hang was not inside a Playwright call.
// It reproduced only under a loaded full-suite run and never when the file ran
// alone, which is what made it read as a browser race rather than teardown.
//
// The first test below is that failure, in a form that takes milliseconds: hold
// one silent socket open and require close() to resolve anyway. It fails — by
// timing out — against the old teardown.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const require = createRequire(import.meta.url);

const { startMockServer } = require('../e2e/mock-server.js');

/** Resolves to 'timeout' if the promise has not settled by `ms`. */
const within = (promise, ms) => Promise.race([
  promise.then(() => 'settled'),
  new Promise(resolve => setTimeout(() => resolve('timeout'), ms).unref?.()),
]);

test('close() returns even while a connection that sent no request is open', async () => {
  const service = await startMockServer((req, res) => { res.writeHead(200); res.end('ok'); });

  // A real request first, so the server has a live keep-alive socket too.
  assert.equal(await (await fetch(`${service.origin}/`)).text(), 'ok');

  // And the one Chrome adds by preconnecting: connected, silent, never used.
  const silent = net.connect(service.port, '127.0.0.1');
  await new Promise((resolve, reject) => { silent.on('connect', resolve); silent.on('error', reject); });

  const closed = service.close();
  try {
    assert.equal(await within(closed, 2000), 'settled',
      'close() is waiting out headersTimeout on the silent socket — the 60s teardown hang is back');
  } finally {
    // Unblocks a close() that is failing this test, so it fails by reporting
    // rather than by holding the event loop open for the next 58 seconds.
    silent.destroy();
    await closed;
  }
});

test('close() resolves only once the port is free again', async () => {
  // The point of awaiting it at all: a close() that resolved early would leave
  // the next test racing a listener that is still up.
  const service = await startMockServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await (await fetch(`${service.origin}/`)).text();
  await service.close();

  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(service.port, '127.0.0.1', () => probe.close(resolve));
  });
});

test('the handler is handed its own origin', async () => {
  // comic-translation and pdf-translation mocks hand out URLs pointing back at
  // themselves (a presigned result, an upload sink), which cannot be written
  // before the port is known.
  const service = await startMockServer((req, res, origin) => {
    res.writeHead(200);
    res.end(origin);
  });
  assert.equal(await (await fetch(`${service.origin}/`)).text(), service.origin);
  assert.match(service.origin, /^http:\/\/127\.0\.0\.1:\d+$/,
    'the origin has to match the bind address — localhost can resolve to ::1, where nothing is listening');
  await service.close();
});

const e2eFiles = () => readdirSync(fileURLToPath(new URL('../e2e/', import.meta.url)))
  .filter(name => name.endsWith('.js') && name !== 'mock-server.js');

// Every one of these mocks was written the same way, and three of them had grown
// a private closeAllConnections() while the fourth — the one that was flaking —
// had not. A spec that stands up its own server is a spec that has to remember
// the teardown for itself, so the way to stop the fix from being half-applied
// again is to leave nowhere else to create one.
test('no E2E file stands up an HTTP server of its own', () => {
  const offenders = e2eFiles()
    .filter(name => /createServer\(/.test(repoFile(`test/e2e/${name}`)));
  assert.deepEqual(offenders, [],
    'use startMockServer from test/e2e/mock-server.js — its close() is the fix for the 60s teardown hang');
});

test('no E2E file closes a server by hand', () => {
  // `server.close()`, bare and un-awaited, is how five specs used to end: it
  // neither drops the sockets nor waits for the port, so a listener outlives
  // the test that made it. `closeAllConnections` is the private copy of the fix
  // three specs had grown.
  const offenders = e2eFiles()
    .filter(name => /server\.close\(|closeAllConnections/.test(repoFile(`test/e2e/${name}`)));
  assert.deepEqual(offenders, [],
    'teardown belongs to startMockServer, not to the spec that happened to need it first');
});
