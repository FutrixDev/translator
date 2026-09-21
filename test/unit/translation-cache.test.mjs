// shared/translation-cache.js —— 译文缓存。
//
// 这里能把它整个跑通，是因为那个模块对 chrome.storage 之外的一切都不知情：
// 不知道当前用哪个引擎、不知道请求长什么样、不知道谁在调它。所以这份测试只需要
// 一个假的 storage 和一个假的 fetchMissing。
//
// 每个用例自己求值一次模块源码，拿到一份全新的 L1。**这不是小聪明，是这份测试的
// 主要手段**：L1 命中和 L2 命中是两条完全不同的路，共用一个进程内 Map 就只能测到
// 前一条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optionsSource } from './helpers/sources.mjs';

// 被测的那个文件是一段直接往 globalThis 上挂的 IIFE（MV3 的 content script 没有
// 模块系统），所以「再来一份」只能靠把源码再求值一次 —— 每求值一次就是一套新的
// 闭包变量，也就是新的 L1、新的待写队列、新的定时器。
//
// **不能靠给 import 路径加查询串。** package.json 没有 "type": "module"，这个
// .js 在 Node 眼里是 CommonJS，而 CJS 的模块缓存按解析后的文件名记，查询串在那
// 一步就被丢掉了 —— `?case=1` 和 `?case=2` 拿回来的是同一份实例、同一个 L1，
// 于是上面那句话里的两条路测出来会是同一条。
const SOURCE = readFileSync(new URL('../../shared/translation-cache.js', import.meta.url), 'utf8');

/** 还活着的实例。每一份都攥着自己的 500ms 定时器，收尾时要挨个结掉。 */
const live = [];

function loadCache() {
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
  const instance = globalThis.TranslationCache;
  live.push(instance);
  return instance;
}

/**
 * 把上一个用例留下的实例结清。
 *
 * 它们那个 500ms 的攒批定时器随时会醒，而它是从 globalThis.chrome 现取 storage
 * 的 —— 醒过来就写进下一个用例的 store 里。flush() 会清空 pendingWrites，定时器
 * 醒来就无事可做了。
 */
async function settleLive() {
  while (live.length > 0) await live.pop().flush().catch(() => {});
}

/**
 * 一份 chrome.storage.local 假件。
 *
 * 带 onChanged，而且 set/remove 真的把事件发出去 —— 清空缓存的广播走的就是这条
 * 路，一个收不到事件的假件会让「别的上下文也跟着丢」那条用例假绿。
 */
function makeChromeStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, set: 0, remove: 0, bytes: 0 };
  const listeners = [];
  const fire = (changes) => {
    if (Object.keys(changes).length === 0) return;
    for (const listener of [...listeners]) listener(changes, 'local');
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          calls.get += 1;
          if (keys === null || keys === undefined) return Object.fromEntries(store);
          const out = {};
          for (const key of [].concat(keys)) {
            if (store.has(key)) out[key] = store.get(key);
          }
          return out;
        },
        async set(items) {
          calls.set += 1;
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: store.get(key), newValue: value };
            store.set(key, value);
          }
          fire(changes);
        },
        async remove(keys) {
          calls.remove += 1;
          const changes = {};
          for (const key of [].concat(keys)) {
            if (!store.has(key)) continue;
            changes[key] = { oldValue: store.get(key) };
            store.delete(key);
          }
          fire(changes);
        },
        async getBytesInUse(keys) {
          calls.bytes += 1;
          let total = 0;
          for (const key of [].concat(keys)) {
            if (store.has(key)) total += key.length + JSON.stringify(store.get(key)).length;
          }
          return total;
        }
      },
      onChanged: {
        addListener(listener) { listeners.push(listener); }
      }
    }
  };
  return { chrome, store, calls };
}

/** 一份干净的 storage.local 假件 + 一份全新的缓存模块。 */
async function freshCache(seed = {}) {
  await settleLive();
  const { chrome, store, calls } = makeChromeStub(seed);
  globalThis.chrome = chrome;
  return { cache: loadCache(), store, calls };
}

/**
 * 两份模块实例，共用一份 storage —— 也就是设置页和一个开着的标签页。
 *
 * 这是这份测试里唯一一处非造两份不可的地方：L1 和待写队列**每个上下文各有一
 * 份**，一份实例永远量不出「设置页清空了，那个标签页还在按自己的 L1 供货」。
 */
async function freshPair(seed = {}) {
  await settleLive();
  const { chrome, store } = makeChromeStub(seed);
  globalThis.chrome = chrome;
  return { options: loadCache(), tab: loadCache(), store };
}

const FACTORS = {
  targetLang: 'zh-CN',
  // 整页翻译那一路的值：它从不声明源语言。字幕会带一门（轨道自己说的）。
  sourceLang: '',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-mini',
  prompt: '',
  version: '1.0.0'
};

/** fetchMissing 的假件：记下每一次被要到的文本，回 `译:<text>`。 */
function recorder(transform = (text) => `译:${text}`) {
  const batches = [];
  const fn = async (missing) => {
    batches.push([...missing]);
    return missing.map(transform);
  };
  fn.batches = batches;
  fn.total = () => batches.reduce((sum, b) => sum + b.length, 0);
  return fn;
}

test('键因子少一个都不行：每一个都改变键', async () => {
  const { cache } = await freshCache();
  const base = { text: 'hello', ...FACTORS };
  const key = cache.buildKey(base);
  assert.match(key, /^tc:[0-9a-f]{16}$/);
  assert.equal(cache.buildKey({ ...base }), key, '同样的因子必须得到同样的键');

  for (const [name, changed] of Object.entries({
    text: 'hello world',
    targetLang: 'ja',
    sourceLang: 'en',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'gpt-4.1',
    prompt: '请用口语化的中文',
    version: '1.0.1'
  })) {
    assert.notEqual(cache.buildKey({ ...base, [name]: changed }), key,
      `改了 ${name} 还命中同一个键 —— 旧译文会被当成新译文供出去`);
  }
});

test('同一句台词，英语轨和法语轨不是同一条译文', async () => {
  // 字幕是唯一会声明源语言的调用方（轨道自己说得出它是哪门语言，一句台词太短，
  // 测不出来）。"Yes." 这种句子在哪门语言里都长这样 —— 键里没有源语言，第一条
  // 轨道的译文就会被供给所有别的轨道。
  const { cache } = await freshCache();
  const en = { ...FACTORS, text: 'Yes.', sourceLang: 'en' };
  assert.notEqual(cache.buildKey(en), cache.buildKey({ ...en, sourceLang: 'fr' }));
  // 而整页翻译那一路（不声明）和这两条都不是同一个键。
  assert.notEqual(cache.buildKey(en), cache.buildKey({ ...en, sourceLang: '' }));
});

test('因子边界不会滑动：("ab","c") 与 ("a","bc") 不是同一个键', async () => {
  const { cache } = await freshCache();
  assert.notEqual(
    cache.buildKey({ ...FACTORS, text: 'ab', targetLang: 'c' }),
    cache.buildKey({ ...FACTORS, text: 'a', targetLang: 'bc' })
  );
});

test('全新一批：原样发出去，译文按原位置回来', async () => {
  const { cache } = await freshCache();
  const fetchMissing = recorder();
  const out = await cache.serve(['one', 'two', 'three'], FACTORS, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [['one', 'two', 'three']]);
  assert.deepEqual(out, ['译:one', '译:two', '译:three']);
});

test('第二次同样的一批：一个请求都不发（L1）', async () => {
  const { cache } = await freshCache();
  const first = recorder();
  await cache.serve(['alpha', 'beta'], FACTORS, first);
  const second = recorder();
  const out = await cache.serve(['alpha', 'beta'], FACTORS, second);
  assert.deepEqual(second.batches, [], 'L1 命中还发请求');
  assert.deepEqual(out, ['译:alpha', '译:beta']);
});

test('换一个页面（新进程、空 L1）：从 storage 里读回来，仍然不发请求', async () => {
  const first = await freshCache();
  await first.cache.serve(['persisted'], FACTORS, recorder());
  await first.cache.flush();

  // 同一份 store 交给一份全新的模块：L1 是空的，命中只可能来自 L2。
  const store = Object.fromEntries(first.store);
  const { cache } = await freshCache(store);
  const fetchMissing = recorder();
  const out = await cache.serve(['persisted'], FACTORS, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [], 'L2 没命中');
  assert.deepEqual(out, ['译:persisted']);
});

test('换一个因子（比如用户换了模型）：L2 里那条不作数', async () => {
  const first = await freshCache();
  await first.cache.serve(['same text'], FACTORS, recorder());
  await first.cache.flush();

  const { cache } = await freshCache(Object.fromEntries(first.store));
  const fetchMissing = recorder();
  await cache.serve(['same text'], { ...FACTORS, model: 'gpt-4.1' }, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [['same text']], '换了模型还吃旧译文');
});

test('一批里重复的文本只发一次，回填仍然按位置', async () => {
  const { cache } = await freshCache();
  const fetchMissing = recorder();
  const out = await cache.serve(['dup', 'other', 'dup'], FACTORS, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [['dup', 'other']]);
  assert.deepEqual(out, ['译:dup', '译:other', '译:dup']);
});

test('并发两批重叠：重叠的那条只发一次', async () => {
  const { cache } = await freshCache();
  const batches = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchMissing = async (missing) => {
    batches.push([...missing]);
    await gate;
    return missing.map((text) => `译:${text}`);
  };

  const a = cache.serve(['shared', 'onlyA'], FACTORS, fetchMissing);
  // 让第一批走到「已挂上 in-flight、正在等」的状态，第二批才可能看见它。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const b = cache.serve(['shared', 'onlyB'], FACTORS, fetchMissing);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  assert.deepEqual(await a, ['译:shared', '译:onlyA']);
  assert.deepEqual(await b, ['译:shared', '译:onlyB']);
  assert.deepEqual(batches, [['shared', 'onlyA'], ['onlyB']],
    '"shared" 被发了两次 —— in-flight 合并没生效');
});

test('这批失败了：返回 null，什么都不记，下一次重新发', async () => {
  const { cache } = await freshCache();
  assert.equal(await cache.serve(['boom'], FACTORS, async () => null), null);
  await cache.flush();

  const retry = recorder();
  const out = await cache.serve(['boom'], FACTORS, retry);
  assert.deepEqual(retry.batches, [['boom']], '失败的那条被记住了');
  assert.deepEqual(out, ['译:boom']);
});

test('条数对不上：整批当失败，不做任何对齐猜测', async () => {
  const { cache } = await freshCache();
  const out = await cache.serve(['a', 'b'], FACTORS, async () => ['只有一条']);
  assert.equal(out, null, '模型把两段并成一段时，缓存不能挑一条塞给 a');
});

test('失败时在等它的那一批会自己重发，而不是拿到 undefined', async () => {
  const { cache } = await freshCache();
  let attempt = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchMissing = async (missing) => {
    attempt += 1;
    if (attempt === 1) {
      await gate;
      return null;
    }
    return missing.map((text) => `译:${text}`);
  };

  const a = cache.serve(['contested'], FACTORS, fetchMissing);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const b = cache.serve(['contested'], FACTORS, fetchMissing);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  assert.equal(await a, null);
  assert.deepEqual(await b, ['译:contested'], '前一批失败后，等它的那一批必须自己去要');
});

test('空译文原样传回，但不进缓存 —— 它是「这段没译出来」，不是一个答案', async () => {
  const { cache } = await freshCache();
  const out = await cache.serve(['kept', 'blank'], FACTORS,
    async (missing) => missing.map((text) => (text === 'blank' ? '' : `译:${text}`)));
  assert.deepEqual(out, ['译:kept', '']);
  await cache.flush();

  const retry = recorder();
  await cache.serve(['kept', 'blank'], FACTORS, retry);
  assert.deepEqual(retry.batches, [['blank']], '空译文被当成结果记住了');
});

test('过期的条目不作数', async () => {
  const probe = await freshCache();
  const key = probe.cache.buildKey({ ...FACTORS, text: 'stale' });
  const { cache } = await freshCache({
    [key]: { t: '陈年译文', ts: Date.now() - probe.cache.TTL_MS - 1000 }
  });
  const fetchMissing = recorder();
  const out = await cache.serve(['stale'], FACTORS, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [['stale']]);
  assert.deepEqual(out, ['译:stale']);
});

test('sweep 扔掉过期和畸形条目，留下新鲜的，不碰别人的键', async () => {
  const probe = await freshCache();
  const fresh = probe.cache.buildKey({ ...FACTORS, text: 'fresh' });
  const stale = probe.cache.buildKey({ ...FACTORS, text: 'stale' });
  const broken = probe.cache.buildKey({ ...FACTORS, text: 'broken' });
  const { cache, store } = await freshCache({
    [fresh]: { t: '新', ts: Date.now() },
    [stale]: { t: '旧', ts: Date.now() - probe.cache.TTL_MS - 1 },
    [broken]: { t: null, ts: Date.now() },
    'pdf-job:1': { anything: true }
  });

  const result = await cache.sweep();
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 1);
  assert.deepEqual([...store.keys()].sort(), [fresh, 'pdf-job:1'].sort());
});

test('超出字节预算就按时间扔掉最旧的四分之一', async () => {
  const probe = await freshCache();
  const now = Date.now();
  const seed = {};
  const keys = [];
  // 每条都撑得够大，20 条稳稳越过 4 MB 预算。
  const bulk = 'x'.repeat(250 * 1024);
  for (let i = 0; i < 20; i++) {
    const key = probe.cache.buildKey({ ...FACTORS, text: `entry-${i}` });
    keys.push(key);
    seed[key] = { t: bulk, ts: now - (20 - i) * 1000 };
  }
  const { cache, store } = await freshCache(seed);

  const result = await cache.sweep();
  assert.equal(result.removed, 5, '20 条的四分之一');
  assert.equal(result.kept, 15);
  // 扔掉的必须是最旧的那几条，不是随手挑的。
  for (let i = 0; i < 5; i++) assert.equal(store.has(keys[i]), false, `entry-${i} 应被淘汰`);
  for (let i = 5; i < 20; i++) assert.equal(store.has(keys[i]), true, `entry-${i} 不该被淘汰`);
});

test('没超预算就一条都不淘汰', async () => {
  const probe = await freshCache();
  const key = probe.cache.buildKey({ ...FACTORS, text: 'small' });
  const { cache, store } = await freshCache({ [key]: { t: '短', ts: Date.now() } });
  const result = await cache.sweep();
  assert.equal(result.removed, 0);
  assert.equal(store.has(key), true);
});

test('写入是攒起来一次落盘的，不是一条一次', async () => {
  const { cache, calls, store } = await freshCache();
  await cache.serve(['w1', 'w2'], FACTORS, recorder());
  await cache.serve(['w3'], FACTORS, recorder());
  const before = calls.set;
  await cache.flush();
  assert.equal(calls.set - before, 1, '三条译文写了不止一次');
  assert.equal([...store.keys()].length, 3);
});

test('storage 读不出来就当全未命中，而不是让整页翻译崩掉', async () => {
  const { cache } = await freshCache();
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  const fetchMissing = recorder();
  const out = await cache.serve(['resilient'], FACTORS, fetchMissing);
  assert.deepEqual(out, ['译:resilient']);
  assert.deepEqual(fetchMissing.batches, [['resilient']]);
});

test('三份装载清单里都有缓存模块', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = (rel) => readFileSync(root + rel, 'utf8');

  const manifest = JSON.parse(read('manifest.json'));
  const page = manifest.content_scripts.find((cs) => cs.js && cs.js.includes('content/page/batch.js'));
  const order = page.js;
  // 顺序就是依赖图：content/page/batch.js 调 ctx.requestTranslationCached，
  // 那个桥接又要 globalThis.TranslationCache。排错了不会报「未定义」，
  // 只会安静地一条都不缓存。
  const idxShared = order.indexOf('shared/translation-cache.js');
  const idxBridge = order.indexOf('content/content-translation-cache.js');
  const idxEngine = order.indexOf('content/content-translation-engine.js');
  const idxBatch = order.indexOf('content/page/batch.js');
  const idxCaptions = order.indexOf('content/captions/translate.js');
  assert.ok(idxShared >= 0 && idxBridge >= 0, '两个模块都要在 manifest 里');
  assert.ok(idxShared < idxBridge, 'shared/translation-cache.js 必须排在桥接之前');
  assert.ok(idxEngine < idxBridge, '桥接要用 ctx.builtinTranslator，必须排在引擎之后');
  assert.ok(idxBridge < idxBatch, '桥接必须排在 content/page/batch.js 之前');
  assert.ok(idxBridge < idxCaptions, '桥接必须排在 content/captions/translate.js 之前');

  // 桥接要把请求里声明的源语言一起放进因子。字幕带着轨道语言来（见
  // shared/caption-core.js 的 buildTranslationRequest），少了这一条，同一句台词
  // 会在两门源语言之间串味 —— 而且键是对的，永远不会被重译掉。
  assert.match(read('content/content-translation-cache.js'), /sourceLang: message\.sourceLang \|\| ''/,
    '桥接没有把 sourceLang 放进键因子');

  assert.match(read('background/background.js'), /import '\.\.\/shared\/translation-cache\.js';/,
    'background 要 sweep()，就得先加载模块');

  // 设置页是第四份清单：那颗「清除缓存」按钮调的是同一个模块。少了这一行，
  // 按钮会在 ReferenceError 里静静地什么也不做。
  const optionsHtml = read('options/options.html');
  assert.match(optionsHtml, /<script src="\.\.\/shared\/translation-cache\.js"><\/script>/,
    '设置页要 clear()，就得先加载模块');
  assert.match(optionsSource(), /await TranslationCache\.clear\(\);/,
    '设置页按自己的路清缓存，就会漏掉 tc: 前缀这条只有模块知道的事');
});

test('clear 把缓存整块删掉，不碰别人的键，也不让攒着的写偷偷落回来', async () => {
  const probe = await freshCache();
  const a = probe.cache.buildKey({ ...FACTORS, text: 'a' });
  const b = probe.cache.buildKey({ ...FACTORS, text: 'b' });
  const { cache, store } = await freshCache({
    [a]: { t: '甲', ts: Date.now() },
    [b]: { t: '乙', ts: Date.now() },
    'pdf-job:1': { anything: true },
    'comicToken': 'x'
  });

  // 刚翻完一批，攒着的那一条还没落盘 —— 它必须跟着一起没，否则用户按完「清除」
  // 半秒后缓存里又冒出一条。
  await cache.serve(['c'], FACTORS, async (missing) => missing.map((t) => `译:${t}`));

  const result = await cache.clear();
  assert.equal(result.removed, 2);
  // 广播信号自己留了下来 —— 它不带 tc: 前缀正是为了这个：清空和过期清理都按前缀
  // 取键，带上前缀就会把信号本身一起删掉，于是这条广播只发得出第一次。
  assert.deepEqual([...store.keys()].sort(),
    ['comicToken', 'pdf-job:1', 'translationCacheEpoch']);

  await cache.flush();
  assert.deepEqual([...store.keys()].sort(),
    ['comicToken', 'pdf-job:1', 'translationCacheEpoch'], '攒着的那一条不该落盘');

  // L1 也空了：不空的话同一个页面继续拿旧译文，「清除」在这一页上等于没按。
  const fetchMissing = recorder();
  await cache.serve(['a'], FACTORS, fetchMissing);
  assert.deepEqual(fetchMissing.batches, [['a']]);
});

test('一个上下文清空，别的上下文跟着丢 —— 否则那个标签页还在按自己的 L1 供货', async () => {
  const { options, tab, store } = await freshPair();

  // tab 是一个开着的标签页：刚翻完一批，L1 里有两条，待写队列里也有两条
  // （那 500ms 还没到）。
  const first = recorder();
  await tab.serve(['a', 'b'], FACTORS, first);
  assert.deepEqual(first.batches, [['a', 'b']]);

  // options 是设置页，用户在这里按下「清除」。
  const result = await options.clear();
  assert.equal(result.removed, 0, '那一批还没落盘，落盘的这一半本来就是空的');

  // 待写的那两条不许再落回去。少了这一条，用户按下按钮半秒之后缓存自己长回来，
  // 而他看不到任何异样。
  await tab.flush();
  assert.deepEqual([...store.keys()].filter((key) => key.startsWith('tc:')), []);

  // L1 也空了：不空的话这个标签页继续按旧译文供货，那颗按钮在他正看着的那一页
  // 上等于没按。
  const second = recorder();
  await tab.serve(['a', 'b'], FACTORS, second);
  assert.deepEqual(second.batches, [['a', 'b']]);
});

test('clear 失败要让调用方知道 —— 按钮按了没反应不能说成清好了', async () => {
  const { cache } = await freshCache();
  chrome.storage.local.remove = async () => { throw new Error('quota'); };
  const key = cache.buildKey({ ...FACTORS, text: 'a' });
  await chrome.storage.local.set({ [key]: { t: '甲', ts: Date.now() } });
  await assert.rejects(() => cache.clear(), /quota/);
});

// L1 有容量上限（2000 条）。一次足够大的调用会把自己早先放进 L1 的条目挤出去，
// 所以回填**不能**从 L1 里取 —— 取不到的那一格会是 undefined，而上游是按位置
// 插译文的：一个空洞就是从那一格起整段错位。
test('一次超过 L1 容量的调用：先命中的那条不会因为被挤出 L1 而丢失', async () => {
  const probe = await freshCache();
  const key = probe.cache.buildKey({ ...FACTORS, text: 'early hit' });
  const { cache } = await freshCache({ [key]: { t: '早就译好了', ts: Date.now() } });

  const texts = ['early hit', ...Array.from({ length: 2100 }, (_, i) => `filler ${i}`)];
  const out = await cache.serve(texts, FACTORS, recorder());

  assert.equal(out.length, texts.length);
  assert.equal(out[0], '早就译好了');
  assert.equal(out.filter((v) => v === undefined).length, 0, '回填出现空洞');
  assert.equal(out[2100], '译:filler 2099');
});
