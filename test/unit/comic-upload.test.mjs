// How a comic page reaches the service: a ticket, a PUT of the bytes to the
// ticket's presigned URL, and only then a create naming the stored key
// (background/comic-client.js uploadPage / putPresigned). No bytes ride in a
// JSON body any more, and a stalled PUT is an error of its own, never a quiet
// second try down some other path.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const HTML = new TextEncoder().encode('<html><body>Hotlinking is not allowed</body></html>');

globalThis.chrome = {
  storage: {
    local: {
      get: async (defaults) => ({ ...defaults, comicToken: 'tok-test', comicTokenExpiresAt: Date.now() + 3_600_000 }),
      set: async () => {},
      remove: async () => {}
    }
  }
};

const comic = await import('../../background/comic-client.js');

/**
 * A fake network. `image` answers the page's own image URL, `put` answers the
 * presigned PUT; every request is recorded with the headers that matter.
 */
function installFetch({ image = PNG, put = () => new Response('', { status: 200 }) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (call.url.endsWith('/api/comic/uploads')) {
      const { operationId, pages: [{ index, format }] } = JSON.parse(init.body);
      return Response.json({
        operationId,
        maxBytes: 20 * 1024 * 1024,
        tickets: [{ index, sourceKey: `comic-src/${operationId}/${index}.${format}`, uploadUrl: 'https://store.test/put?sig=s', contentType: `image/${format}` }]
      });
    }
    if (call.url.startsWith('https://store.test/')) return put(init);
    if (call.url.startsWith('https://comics.test/')) return new Response(image, { status: 200 });
    throw new Error(`unexpected request ${call.url}`);
  };
  return calls;
}

test('the worker fetches the page, takes a ticket, PUTs the bytes, and returns the key', async () => {
  const calls = installFetch();
  const result = await comic.uploadPage({ operationId: 'op-1', imageUrl: 'https://comics.test/p1.png' });

  assert.deepEqual(result, { sourceKey: 'comic-src/op-1/0.png' });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`),
    ['GET /p1.png', 'POST /api/comic/uploads', 'PUT /put?sig=s']);
  assert.deepEqual(JSON.parse(calls[1].body).pages, [{ index: 0, format: 'png', byteSize: PNG.byteLength }]);
  const put = calls[2];
  assert.deepEqual(put.headers, { 'content-type': 'image/png' }, 'the signature is the authorization: no bearer');
  assert.deepEqual(Array.from(put.body), Array.from(PNG));
});

test('a 200 that is not an image asks the page for its pixels, before any ticket', async () => {
  const calls = installFetch({ image: HTML });
  await assert.rejects(
    comic.uploadPage({ operationId: 'op-2', imageUrl: 'https://comics.test/p1.png' }),
    (error) => error.code === 'needs_page_bytes' && error.details.needsPageBytes === true
  );
  assert.equal(calls.length, 1);
});

test('the page\'s canvas capture is decoded and uploaded the same way', async () => {
  const calls = installFetch();
  const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
  const result = await comic.uploadPage({ operationId: 'op-3', pageBytes: dataUrl });

  assert.deepEqual(result, { sourceKey: 'comic-src/op-3/0.png' });
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PUT']);
  assert.deepEqual(Array.from(calls[1].body), Array.from(PNG));
});

test('a capture that is not an image is refused without touching the network', async () => {
  const calls = installFetch();
  await assert.rejects(
    comic.uploadPage({ operationId: 'op-4', pageBytes: 'data:text/html;base64,PGh0bWw+' }),
    (error) => error.code === 'image_unreadable'
  );
  assert.equal(calls.length, 0);
});

test('a PUT that does not finish in time is upload_timeout, and nothing is retried', async () => {
  const calls = installFetch({
    put: (init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })
  });
  await assert.rejects(
    comic.putPresigned('https://store.test/put?sig=s', PNG, { contentType: 'image/png', operationId: 'op-5', label: 'comic', timeoutMs: 20 }),
    (error) => error.code === 'upload_timeout'
  );
  assert.equal(calls.length, 1);
});

test('a refused PUT is upload_failed with its status', async () => {
  installFetch({ put: () => new Response('denied', { status: 403 }) });
  await assert.rejects(
    comic.uploadPage({ operationId: 'op-6', imageUrl: 'https://comics.test/p1.png' }),
    (error) => error.code === 'upload_failed' && error.status === 403
  );
});

test('a create without the uploaded key is a programming error, not a request', () => {
  installFetch();
  assert.throws(() => comic.createJob({ operationId: 'op-7', pageUrl: 'https://comics.test/ch1' }), /sourceKey/);
});
