/**
 * The one HTTP server every E2E mock is built on.
 *
 * It exists for its close(). `server.close(cb)` on its own does not reliably
 * come back: Node stops listening and reaps *idle* keep-alive sockets at once,
 * but a socket that has connected and sent no request bytes counts as a request
 * still arriving, and it is held until `server.headersTimeout` — 60 seconds by
 * default. Chrome opens exactly such a socket: alongside a navigation it
 * speculatively preconnects a second connection to the same origin, and often
 * sends nothing on it. Whether the browser's pool has dropped that socket by
 * the time a test tears down is a race, so `await service.close()` returned in
 * under a millisecond almost always and blocked for a full minute now and
 * then — inside the test's own 60s budget, with every assertion in the body
 * already passed.
 *
 * That is the flake this module was extracted for: comic-account.spec.js failing
 * as a bare "Test timeout of 60000ms exceeded" with no Playwright call log, only
 * under a loaded full-suite run, never when the file ran alone.
 * closeAllConnections() destroys those sockets instead of waiting them out.
 * Three specs had already grown a private copy of that call and the fourth had
 * not, which is why the server now has one home.
 *
 * Guarded by test/unit/e2e-mock-server.test.mjs: it holds a silent socket open
 * and requires close() to resolve anyway, and it fails any spec that stands up
 * an http server of its own.
 *
 * The origin is 127.0.0.1 rather than localhost, matching the bind address —
 * `localhost` can resolve to ::1 first, and nothing is listening there.
 *
 * @param {(req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          origin: string) => void} handler
 *   The request listener. Its third argument is this server's own origin, for
 *   mocks that hand out URLs pointing back at themselves (a presigned result
 *   URL, an upload sink) and so cannot be written before the port is known.
 * @returns {Promise<{port: number, origin: string, close: () => Promise<void>}>}
 */
const http = require('node:http');

function startMockServer(handler) {
  return new Promise((resolve) => {
    let origin = '';
    const server = http.createServer((req, res) => handler(req, res, origin));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      origin = `http://127.0.0.1:${port}`;
      resolve({
        port,
        origin,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { startMockServer };
