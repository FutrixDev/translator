// Blab Translation 漫画翻译 —— 交页
//
// 把一页漫画的像素交到存储里：先让后台去取，取不到再由页面自己取，再不行就从
// 画布上读。只回答「这一页的字节怎么上去」，不认识任务、不碰浮层。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  /**
   * Put the page in storage: `{ ok, data: { sourceKey } }`.
   *
   * Three rungs, each tried only when the one before cannot read the page:
   *
   *  1. the worker fetches `imageUrl` with the user's cookies — login-gated CDNs;
   *  2. this page fetches it — the request carries the page's Referer, which
   *     hotlink-guarded CDNs (webtoons' pstatic) demand and the worker cannot
   *     send; it needs the CDN to allow CORS, which such CDNs usually do;
   *  3. the canvas re-encodes the pixels the page decoded — a blob:/data: src,
   *     or any image that is not cross-origin-tainted.
   */
  async function uploadPage(entry, imageUrl) {
    const fromWorker = await sendUpload(entry, { imageUrl });
    if (fromWorker.ok || !fromWorker.error.needsPageBytes) return fromWorker;
    const { maxBytes } = fromWorker.error;

    const fetched = await fetchPageBytesHere(imageUrl, maxBytes);
    if (fetched.code) return { ok: false, error: { code: fetched.code } };
    if (fetched.dataUrl) {
      const sent = await sendUpload(entry, { pageBytes: fetched.dataUrl });
      // Bytes that are not a picture the service takes (AVIF, an HTML error
      // page) still have a canvas rung: the page may have decoded something.
      if (sent.ok || sent.error.code !== 'image_unreadable') return sent;
    }

    // Only from the element still holding this page. Sign-in or a slow fetch
    // can have taken long enough for the reader to turn away, and a recycled
    // slot would hand over another page's pixels under this job's name.
    const capture = comic.entryMatchesImage(entry, entry.img)
      ? capturePageBytes(entry.img, maxBytes)
      : { code: 'image_unreadable' };
    if (capture.code) return { ok: false, error: { code: capture.code } };
    return sendUpload(entry, { pageBytes: capture.dataUrl });
  }

  /**
   * Fetch the page's image from the page itself: `{ dataUrl }`, `{ code:
   * 'image_too_large' }`, or `{}` when this rung cannot read it.
   *
   * The default credentials mode is the right one: cookies for a same-origin
   * image, none cross-origin, where `Access-Control-Allow-Origin: *` would
   * refuse a credentialed read. The data URL is labelled `image/page` because
   * the worker sniffs the format from the bytes, not from whatever
   * content-type the CDN claimed.
   */
  async function fetchPageBytesHere(imageUrl, maxBytes) {
    if (!/^https?:/i.test(imageUrl || '')) return {};
    let blob;
    try {
      const response = await fetch(imageUrl, { cache: 'force-cache' });
      if (!response.ok) {
        console.warn(`[comic] page fetch of the image got HTTP ${response.status}; trying the canvas`);
        return {};
      }
      blob = await response.blob();
    } catch (error) {
      // CORS refusals land here; the canvas is the next rung, not a failure.
      console.warn(`[comic] page fetch of the image failed (${error?.message || error}); trying the canvas`);
      return {};
    }
    if (!blob.size) return {};
    if (blob.size > maxBytes) return { code: 'image_too_large' };
    return { dataUrl: await blobDataUrl(new Blob([blob], { type: 'image/page' })) };
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function sendUpload(entry, source) {
    return comic.sendMessage({
      type: 'COMIC_PAGE_UPLOAD',
      consent: entry.consent === true,
      page: { operationId: entry.operationId, ...source }
    });
  }

  /**
   * Read the pixels the page already has: `{ dataUrl }`, or `{ code }` when
   * there is nothing to send.
   *
   * Only works when the image is not cross-origin-tainted — canvas will throw
   * on read otherwise, which is the browser's whole point. That case ends as
   * "cannot translate this image", not as a silent failure. `maxBytes` is the
   * worker's cap, handed over with its request for the pixels; a page still
   * above it as a JPEG is too large, which the service would refuse anyway.
   */
  function capturePageBytes(img, maxBytes) {
    if (!(maxBytes > 0)) throw new Error('capturePageBytes needs the worker\'s maxBytes');
    if (!img.naturalWidth || !img.naturalHeight) return { code: 'image_unreadable' };
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch {
      return { code: 'image_unreadable' }; // tainted canvas
    }
    if (base64Bytes(dataUrl) > maxBytes) {
      // PNG of a scanned page is often several times its JPEG original.
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      if (base64Bytes(dataUrl) > maxBytes) return { code: 'image_too_large' };
    }
    return { dataUrl };
  }

  function base64Bytes(dataUrl) {
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Math.floor(payload.length * 0.75);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, { uploadPage });
})();
