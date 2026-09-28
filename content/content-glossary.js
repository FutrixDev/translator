// Blab Translation — 本页的术语表镜像（ctx.glossary）
//
// 词条存在 sync 里，一条一个 `glossary:<id>` 键（shared/glossary.js）。这个文件只
// 建本页的镜像：向 SW 要一次本主机生效的词条（GLOSSARY_FOR_HOST，主机取发信那一
// 帧的地址），此后跟着 bootstrap 转来的增量走（ctx.syncMirrors 登记表）。
//
// **只有顶层帧建镜像。** 子帧的翻译请求经 frames/child.js 的信封交给顶层执行，
// 词表在顶层加；子帧既不建镜像、也不登记 glossary: 前缀 —— 一个什么也不做的登记
// 只是兼容层。没有镜像的地方（子帧、设置页、Node 测试台）entries() 是空表，
// whenReady() 立即 resolve：那里本来就没有词表，不是出错后的兜底。
//
// 哪些词条命中哪段文字、怎么写进提示词或占位，是引擎那一族的事
// （content/engine/glossary.js 的快照），不在这里。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const Glossary = globalThis.Glossary;
  const EMPTY = Object.freeze([]);

  let mirror = null;
  // 订阅者单独记：引擎和缓存层在加载时就订阅，那时 init() 还没跑、镜像还没有。
  const subscribers = new Set();

  function notify() {
    for (const fn of Array.from(subscribers)) {
      try {
        fn();
      } catch (error) {
        console.error('Blab Translation: glossary subscriber failed', error);
      }
    }
  }

  function request() {
    return chrome.runtime.sendMessage({ type: 'GLOSSARY_FOR_HOST' }).then((reply) => {
      if (!reply) throw new Error('GLOSSARY_FOR_HOST got no reply');
      if (reply.error) throw new Error(reply.error);
      if (!Array.isArray(reply.entries)) throw new Error('GLOSSARY_FOR_HOST reply has no entries list');
      return reply.entries;
    });
  }

  function init() {
    if (mirror || ctx.frameRole !== 'top') return;
    mirror = Glossary.mirror({ request, host: location.hostname });
    mirror.subscribe(notify);
    ctx.syncMirrors.push({
      prefix: Glossary.KEY_PREFIX,
      onStorageChange: ctx.glossary.onStorageChange,
    });
  }

  ctx.glossary = {
    init,
    whenReady: () => (mirror ? mirror.whenReady() : Promise.resolve()),
    entries: () => (mirror ? mirror.entries() : EMPTY),
    get version() {
      return mirror ? mirror.version : 0;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    onStorageChange: (changes) => {
      if (mirror) mirror.onStorageChange(changes);
    },
  };
})();
