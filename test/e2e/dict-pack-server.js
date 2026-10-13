/**
 * A stand-in for the dictionary download host, https://dl.blab-translation.com/,
 * served through context.route: a v1 manifest and the pack files it lists. The
 * real host is never reached (fixtures.js maps it to nothing), and nothing in
 * the extension knows it is talking to this.
 *
 * A manifest row is built from the bytes it serves, the way the build pipeline
 * builds it: sha256 and byte length of the file, the head count, and the path
 * dict/v1/<src>-<tgt>/<ver>/pack.json. `publish(bytes, { serve })` can serve
 * other bytes than the row was built from, which is how a tampered pack looks.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://dl.blab-translation.com/';
const MANIFEST_PATH = 'dict/v1/manifest.json';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'dict-runtime');

/** A hand-made v1 pack from test/fixtures/dict-runtime, as parsed JSON. */
function fixturePack(pair) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${pair}.json`), 'utf8'));
}

/** Pack JSON as the bytes a server sends. */
function packBytes(pack) {
  return Buffer.from(JSON.stringify(pack), 'utf8');
}

/** The manifest row the build would write for these bytes. */
function rowFor(bytes) {
  const pack = JSON.parse(bytes.toString('utf8'));
  return {
    src: pack.src,
    tgt: pack.tgt,
    ver: pack.ver,
    url: `dict/v1/${pack.src}-${pack.tgt}/${pack.ver}/pack.json`,
    bytes: bytes.length,
    rawBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    heads: Object.keys(pack.e).length,
  };
}

class DictPackServer {
  constructor() {
    this.rows = new Map(); // pair -> manifest row
    this.files = new Map(); // path under ORIGIN -> bytes
    this.hits = []; // every path requested, in order
  }

  /**
   * List `bytes` in the manifest, replacing the pair's row, and serve
   * `serve` (default: the same bytes) at the row's url.
   * @returns {object} the manifest row
   */
  publish(bytes, { serve = bytes } = {}) {
    const row = rowFor(bytes);
    this.rows.set(`${row.src}-${row.tgt}`, row);
    this.files.set(row.url, serve);
    return row;
  }

  /** Publish a fixture pack as it is on disk (re-serialised, same content). */
  publishFixture(pair) {
    return this.publish(packBytes(fixturePack(pair)));
  }

  hitsOf(pathUnderOrigin) {
    return this.hits.filter((p) => p === pathUnderOrigin).length;
  }

  /** @param {import('@playwright/test').BrowserContext} context */
  async attach(context) {
    await context.route(`${ORIGIN}**`, (route) => {
      const at = new URL(route.request().url()).pathname.replace(/^\//, '');
      this.hits.push(at);
      if (at === MANIFEST_PATH) {
        const manifest = { v: 1, packs: [...this.rows.values()] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
      }
      const file = this.files.get(at);
      if (!file) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: file });
    });
  }
}

module.exports = { DictPackServer, MANIFEST_PATH, fixturePack, packBytes, rowFor };
