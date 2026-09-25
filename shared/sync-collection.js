/**
 * 一条一个 sync 键的集合：`<prefix><id>` 一个键一个条目，按主机取，增量跟随。
 *
 * 双模经典脚本：服务工作者 import 它，内容脚本、设置页用 <script> 装，挂在
 * globalThis.SyncCollection 上。用户站点规则（shared/custom-rules.js，
 * `customRule:`）建在它上面，P1-C 的词表（`glossary:`）也建在它上面 —— 两家的
 * 读、写、缓存、增量逐字相同，写第二遍就是 storage-writer 文件头说的那种漂移。
 *
 * 为什么一条一个键、不是一个数组键：sync 单项上限 8 KiB，数组键很快撞顶；sync 按
 * 键合并，两台设备各改各的条目互不覆盖。没有索引键 —— 两台设备同时新增时索引
 * 会互相覆盖，条目还在却列不出来。最低支持的 Chrome 116 没有 getKeys()，所以
 * 读全部一律 get(null) 再按前缀过滤。
 *
 * 条目的 id 只存在键里，存进去的值不带它：collect 从键上取回来挂到条目上，值
 * 里即使带了 id 也不认；write 存之前去掉；usage 按存进去的形状算。
 *
 * 这个文件在服务工作者、设置页和内容脚本里都加载，所以模块里不读 location：
 * 隐式取主机只在其中一处对。主机一律由调用方传入。
 */
(function (root) {
  'use strict';

  const StorageWriter = root.StorageWriter;
  if (!StorageWriter) throw new Error('sync-collection.js 要先装 shared/storage-writer.js');
  const SiteRules = root.SiteRules;
  if (!SiteRules) throw new Error('sync-collection.js 要先装 shared/site-rules.js');

  // 内容脚本收到增量后等这么久再通知：拾取器连点几下、导入一次写几十个键，
  // 都只触发一轮重排。
  const DEBOUNCE_MS = 150;
  // 首个回话最多等这么久。超时按空集合处理，回话晚到仍照常生效。这个上限只写
  // 在这里，规则和词表共用。
  const READY_CAP_MS = 1500;

  const ID_LENGTH = 8;
  // 键里 id 的形状。newId() 只发 8 位，但读的时候放宽到 32 位：导入文件里手写
  // 的 id 也能用，只要它拼进键名以后不含别的字符。
  const ID_RE = /^[0-9a-z]{1,32}$/;

  function validId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    let id = '';
    for (const byte of bytes) id += (byte % 36).toString(36);
    return id;
  }

  // 存进去的形状：去掉 id。
  function storedValue(entry) {
    const value = Object.assign({}, entry);
    delete value.id;
    return value;
  }

  function syncArea() {
    return root.chrome.storage.sync;
  }

  /**
   * @param {{
   *   prefix: string,
   *   decode: function(*): (Object|null),
   *   hosts: function(Object): string[],
   *   limits: {itemBytes: number, totalBytes: number, maxItems: number},
   *   errors: {tooLarge: string, budgetFull: string},
   * }} spec
   *   decode：把存储里的一项变成条目，坏条目、不认识的 v 返回 null；
   *   hosts：条目作用的主机表，空数组表示所有主机；
   *   errors：超额时抛的两个 i18n 键。
   */
  function create(spec) {
    const { prefix, decode, hosts, limits, errors } = spec || {};
    if (!prefix || typeof decode !== 'function' || typeof hosts !== 'function' || !limits || !errors) {
      throw new Error('SyncCollection.create needs prefix, decode, hosts, limits and errors');
    }

    function keyOf(id) {
      return prefix + id;
    }

    // 一个键一个值 -> 条目，或 null（坏的、不认识的）。id 一律取自键。
    function decodeItem(key, value) {
      const id = key.slice(prefix.length);
      if (!validId(id)) return null;
      const decoded = decode(value);
      if (!decoded) return null;
      return Object.assign({}, decoded, { id });
    }

    // 坏条目跳过，一次最多记一条日志，只写数目：条目内容是用户数据。
    function reportSkipped(operation, skipped) {
      if (skipped) console.warn(`SyncCollection ${prefix} ${operation}: skipped ${skipped} unreadable entries`);
    }

    function collect(items) {
      const entries = [];
      let skipped = 0;
      for (const [key, value] of Object.entries(items || {})) {
        if (!key.startsWith(prefix)) continue;
        const entry = decodeItem(key, value);
        if (entry) entries.push(entry);
        else skipped += 1;
      }
      reportSkipped('collect', skipped);
      return entries;
    }

    function appliesTo(entry, host) {
      const list = hosts(entry);
      return !list.length || list.some((pattern) => SiteRules.hostMatches(host, pattern));
    }

    function forHost(entries, host) {
      return entries.filter((entry) => appliesTo(entry, host));
    }

    /**
     * 把 storage.onChanged 的增量应用成新数组（纯函数，不改传入的数组）：增、替、
     * 删。别的主机的条目忽略；host 为 null 时不按主机过滤（设置页看全部）。
     */
    function applyChanges(entries, changes, host) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      let skipped = 0;
      for (const [key, change] of Object.entries(changes || {})) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        byId.delete(id);
        if (!change || change.newValue === undefined) continue;
        const entry = decodeItem(key, change.newValue);
        if (!entry) {
          skipped += 1;
          continue;
        }
        if (host == null || appliesTo(entry, host)) byId.set(id, entry);
      }
      reportSkipped('applyChanges', skipped);
      return Array.from(byId.values());
    }

    // 一条占多少：键名加上不带 id 的值 —— sync 配额的口径就是 JSON 加键名，
    // StorageWriter.itemBytes 只量值。
    function entryBytes(entry) {
      return new TextEncoder().encode(keyOf(entry.id)).length + StorageWriter.itemBytes(storedValue(entry));
    }

    function usage(entries) {
      let bytes = 0;
      for (const entry of entries) bytes += entryBytes(entry);
      return { bytes, count: entries.length };
    }

    // 额度规则只有这一份：SW 写入和导入预览都调它。超了就拒，不截断。
    function assertFits(entries) {
      if (entries.some((entry) => entryBytes(entry) > limits.itemBytes)) throw new Error(errors.tooLarge);
      const { bytes, count } = usage(entries);
      if (bytes > limits.totalBytes || count > limits.maxItems) throw new Error(errors.budgetFull);
    }

    /**
     * 按 keyOf 合并：键相同就替换，并沿用原来的 id；否则新增，没有 id 的发一个新
     * id。keyOf 返回 null / undefined 的条目一律当新增。
     */
    function merge(existing, incoming, mergeKey) {
      const entries = existing.slice();
      let added = 0;
      let replaced = 0;
      for (const item of incoming) {
        const key = mergeKey(item);
        const at = key == null ? -1 : entries.findIndex((entry) => mergeKey(entry) === key);
        if (at >= 0) {
          entries[at] = Object.assign({}, item, { id: entries[at].id });
          replaced += 1;
        } else {
          entries.push(Object.assign({}, item, { id: item.id || newId() }));
          added += 1;
        }
      }
      return { entries, added, replaced };
    }

    // ------------------------------------------------------------ SW：缓存

    let memo = null;

    function invalidate() {
      memo = null;
    }

    // 记住 collect(get(null)) 的结果。SW 随时可能被回收，这份记忆只是缓存。
    function cached() {
      if (!memo) {
        const pending = syncArea().get(null).then(collect);
        memo = pending;
        pending.catch(() => {
          if (memo === pending) memo = null;
        });
      }
      return memo;
    }

    if (StorageWriter.IN_SERVICE_WORKER) {
      root.chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(prefix))) invalidate();
      });
    }

    /**
     * SW 写队列里的一次读—改—写。compute(entries) 返回 {put, remove, result}：
     * put 是要写的条目（带 id），remove 是要删的 id。额度按写后的集合查，一次
     * 多键 set 加一次 remove，返回 result。
     */
    async function write(compute) {
      const entries = collect(await syncArea().get(null));
      const { put = [], remove = [], result } = await compute(entries);
      for (const entry of put) {
        if (!validId(entry.id)) throw new Error(`SyncCollection ${prefix} write: bad id`);
      }
      const putIds = new Set(put.map((entry) => entry.id));
      const removeIds = new Set(remove.filter((id) => !putIds.has(id)));
      const after = entries
        .filter((entry) => !putIds.has(entry.id) && !removeIds.has(entry.id))
        .concat(put);
      assertFits(after);
      if (put.length) {
        await syncArea().set(Object.fromEntries(put.map((entry) => [keyOf(entry.id), storedValue(entry)])));
      }
      if (removeIds.size) await syncArea().remove(Array.from(removeIds, keyOf));
      // 不等 onChanged：回话之后紧跟着来的读要看到这次写。
      invalidate();
      return result;
    }

    // ------------------------------------------------------------ 内容脚本：镜像

    /**
     * 每个文档一份：只 request() 一次，请求在路上时到的增量按顺序缓冲，回话到了
     * 再依次应用；此后的增量去抖 DEBOUNCE_MS，递增版本号并通知订阅者。
     *
     * host 必须和 SW 回话时用的主机相同（规则：本 frame 的 location.hostname，
     * 与 SW 用 sender.url 取的一致）。
     *
     * @param {{request: function(): Promise<Object[]>, host: string}} options
     *   request：取回这个主机的全部条目（带 id）。
     */
    function mirror({ request, host }) {
      let entries = [];
      let version = 0;
      let arrived = false;
      let queued = [];
      let timer = null;
      const subscribers = new Set();

      let markReady;
      const ready = new Promise((resolve) => {
        markReady = resolve;
      });
      const cap = setTimeout(markReady, READY_CAP_MS);

      function notify() {
        version += 1;
        for (const fn of Array.from(subscribers)) {
          try {
            fn();
          } catch (error) {
            console.error(`SyncCollection ${prefix} subscriber failed:`, error);
          }
        }
      }

      function drain() {
        const pending = queued;
        queued = [];
        for (const changes of pending) entries = applyChanges(entries, changes, host);
      }

      function settle(list) {
        entries = list;
        arrived = true;
        drain();
        clearTimeout(cap);
        markReady();
        notify();
      }

      Promise.resolve()
        .then(request)
        .then(
          (list) => settle(Array.isArray(list) ? list : []),
          (error) => {
            console.warn(`SyncCollection ${prefix} mirror request failed:`, error);
            settle([]);
          },
        );

      function flush() {
        timer = null;
        drain();
        notify();
      }

      function onStorageChange(changes) {
        queued.push(changes);
        if (!arrived) return;
        clearTimeout(timer);
        timer = setTimeout(flush, DEBOUNCE_MS);
      }

      function subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      }

      return {
        whenReady: () => ready,
        onStorageChange,
        entries: () => entries,
        get version() {
          return version;
        },
        subscribe,
      };
    }

    return {
      prefix,
      newId,
      validId,
      collect,
      forHost,
      applyChanges,
      usage,
      assertFits,
      merge,
      write,
      cached,
      mirror,
    };
  }

  root.SyncCollection = { create, DEBOUNCE_MS, READY_CAP_MS };
})(globalThis);
