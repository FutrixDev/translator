// 单修饰键快捷键的那道闸门（content/content-utils.js 的 armModifierTap）。
//
// 这套机制存在的理由只有一条：划词 / 悬停的快捷键是**单独一个修饰键**，而
// Alt+A 的第一下 keydown 和「只按了 Alt」在事件上完全一样。立刻动手，用户按一
// 次 Alt+A 就会既译一段又译一页——两次请求，用自己的 API 就是两份钱。
//
// 这里执行真代码，不是对着源文件比正则：闸门的每一条都是「什么时候**不**动手」，
// 而那种规则写错了看不出来，只有跑一遍才知道。content-utils.js 是个 IIFE，挂在
// window / document / chrome 上，所以下面拿 vm 给它造一套最小的浏览器——包括可
// 以手动拨的 setTimeout，免得每条用例都真等 220ms。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content/content-utils.js'), 'utf8');

// 造一个 content-utils 跑得起来的世界。`commands` 是 manifest 里声明的那份建议
// 键位，`liveShortcuts` 是服务工作者答回来的那份真实绑定（null = 不答）。
function load({ commands = { 'toggle-translate-page': { suggested_key: { default: 'Alt+A' } } },
                liveShortcuts = null } = {}) {
  const listeners = { window: {}, document: {} };
  const timers = new Map();
  let nextTimer = 1;

  const target = (bag) => ({
    addEventListener: (type, fn) => { (bag[type] = bag[type] || []).push(fn); },
    removeEventListener: () => {},
  });

  const ctx = {};
  const sent = [];
  let live = liveShortcuts;
  let hidden = false;
  let clock = 1_000_000;
  const sandbox = {
    window: { AI_TRANSLATOR_CONTENT: ctx, ...target(listeners.window) },
    document: {
      ...target(listeners.document),
      get hidden() { return hidden; },
      createElement: () => ({ set textContent(v) {}, innerHTML: '' }),
    },
    navigator: {},
    console,
    Date: { now: () => clock },
    chrome: {
      runtime: {
        lastError: null,
        getManifest: () => ({ commands }),
        sendMessage: (message, callback) => {
          sent.push(message);
          if (live === null) return;
          // 真实世界里这是异步的，但测试要的是「答回来之后名单对不对」，
          // 所以同步交付，省掉每条用例一个 await。
          callback({ shortcuts: live });
        },
      },
    },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: 'content/content-utils.js' });

  return {
    ctx,
    sent,
    // 把已经排上的按住计时器全部拨到点。
    elapse() { const due = [...timers.values()]; timers.clear(); for (const t of due) t.fn(); },
    pending: () => timers.size,
    key(type, key) { for (const fn of listeners.window[type] || []) fn({ key }); },
    // 用户跑去 chrome://extensions/shortcuts 改了键位，再回到这一页。
    rebind(shortcuts) { live = shortcuts; },
    focus() { for (const fn of listeners.window.focus || []) fn({}); },
    reveal() { hidden = false; for (const fn of listeners.document.visibilitychange || []) fn({}); },
    tick(ms) { clock += ms; },
  };
}

// 按住某个修饰键够久，动没动手。
function heldRun(world, key) {
  let ran = 0;
  world.ctx.armModifierTap(key, () => { ran += 1; }, { hold: true, onChord: () => {} });
  world.elapse();
  return ran;
}

test('命令键位占着的修饰键不开按住档 —— Alt+A 的那半秒不该先译一段', () => {
  const world = load();
  assert.equal(heldRun(world, 'Alt'), 0, '按住 Alt 超过一瞬就动手，Alt+A 会既译一段又译一页');
  assert.equal(world.pending(), 0, '不动手的那一档连计时器都不该排，留着就是留着一条别的路');
});

test('没被命令占着的修饰键照旧：默认的 Shift 按住够久就算数', () => {
  const world = load();
  assert.equal(heldRun(world, 'Shift'), 1, '默认悬停键位是 Shift，按住档是它本来的手势');
});

test('闸门认的是键位，不是写死的 Alt —— 改成 Ctrl+Shift+Y 就换 Shift 闭嘴', () => {
  // 这条是整层的意义所在：键位在 chrome://extensions/shortcuts 里改得掉，改完
  // 撞上的就是默认的悬停键位 Shift。写死 'Alt' 的实现在这里全红。
  const world = load({ liveShortcuts: ['Ctrl+Shift+Y'] });
  assert.equal(heldRun(world, 'Shift'), 0, '命令改成 Ctrl+Shift+Y 之后，按住 Shift 会抢在 Y 前面动手');
  assert.equal(heldRun(world, 'Control'), 0);
  assert.equal(heldRun(world, 'Meta'), 1, '没被占的那些一个都不该跟着遭殃');
});

test('macOS 上 Chrome 把键位印成符号（⌥A），一样要认出来', () => {
  const world = load({ commands: {}, liveShortcuts: ['⌘⇧Y'] });
  assert.equal(heldRun(world, 'Meta'), 0);
  assert.equal(heldRun(world, 'Shift'), 0);
  assert.equal(heldRun(world, 'Alt'), 1);
});

test('页面刚打开、还没问到答案的那几百毫秒也得是对的', () => {
  // 服务工作者可能正在冷启动，而用户伸手按快捷键恰恰就在这个时候。manifest 里
  // 声明的那份建议键位先垫着，答案回来只会把名单变长。
  const world = load({ liveShortcuts: null });
  assert.equal(heldRun(world, 'Alt'), 0, 'manifest 声明的 Alt+A 没垫上，冷启动窗口里这层等于没装');
  // sent 里的对象是 vm 里造的，原型不是宿主那一个，所以按字段比。
  assert.deepEqual(world.sent.map((m) => m.type), ['COMMAND_SHORTCUTS'], '真实绑定得去问，manifest 那份只是建议值');
});

test('答案只会把名单变长，不会把 manifest 声明的那个摘掉', () => {
  // 摘掉换来的是「悬停键位也改成了 Alt」的人少松一次手，赌的却是这条消息在每
  // 台机器上都答得又对又准。不值。
  const world = load({ liveShortcuts: ['Ctrl+Shift+Y'] });
  assert.equal(heldRun(world, 'Alt'), 0);
});

test('答不上来（服务工作者没醒 / 上下文没了）不该把闸门连同内容脚本一起带塌', () => {
  const world = load({ commands: null, liveShortcuts: [] });
  assert.equal(typeof world.ctx.armModifierTap, 'function');
  assert.equal(heldRun(world, 'Alt'), 1, '一个命令都没绑着的时候，按住档没有理由关着');
});

test('按住档之外的三种了结不受影响：松开算数、来了别的键作废、被划花掉就收回', () => {
  const world = load();
  const log = [];

  // 松开才算数 —— 命令占着的 Alt 只剩这一条路，而 Alt+A 永远走不到。
  world.ctx.armModifierTap('Alt', () => log.push('run'), { onChord: () => log.push('chord') });
  world.key('keyup', 'Alt');
  assert.deepEqual(log, ['run']);

  // 来了别的键：这是一个和弦，这一下作废。
  log.length = 0;
  world.ctx.armModifierTap('Alt', () => log.push('run'), { onChord: () => log.push('chord') });
  world.key('keydown', 'a');
  world.key('keyup', 'Alt');
  assert.deepEqual(log, ['chord'], 'Alt+A 里那一下必须作废，且松手不能补译一次');

  // 已经被「按住划」花掉了：收回，松手不该把刚划出来的译文再切掉。
  log.length = 0;
  world.ctx.armModifierTap('Alt', () => log.push('run'), { onChord: () => log.push('chord') });
  world.ctx.disarmModifierTap();
  world.key('keyup', 'Alt');
  assert.deepEqual(log, []);

  // 花掉了也还盯着：键还按着，和弦可以来得更晚。
  log.length = 0;
  world.ctx.armModifierTap('Alt', () => log.push('run'), { onChord: () => log.push('chord') });
  world.ctx.disarmModifierTap();
  world.key('keydown', 'a');
  assert.deepEqual(log, ['chord'], '晚到的和弦得把「按住了」收回，否则松手前划过的每一段都还在译');
});

test('真实键位只有服务工作者答得上来 —— 那半边也得在', () => {
  // chrome.commands 不对内容脚本开放，所以闸门的另一半装在后台。这条比对源文件
  // 而不是跑：上面那套 vm 里的 chrome 是假的，真正会不会有人应答，只有这里看得出。
  const bg = fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8');
  const arm = bg.slice(bg.indexOf("case 'COMMAND_SHORTCUTS':"));
  assert.ok(arm.startsWith("case 'COMMAND_SHORTCUTS':"), '后台没有人应答这条消息，名单就永远只有 manifest 那份');
  assert.match(arm.slice(0, 600), /chrome\.commands\.getAll\(/, '答的必须是现在真的绑着的键位，不是 manifest 的建议值');
  assert.match(arm.slice(0, 600), /sendResponse\(\{ shortcuts:[\s\S]*?\}\);\s*\}\);\s*return true;/,
    'getAll 是异步的，不 return true 这条消息的通道当场就关了，回调答给空气');
});

test('键位是在别的标签页改的 —— 回到这一页要重问一次', () => {
  // chrome://extensions/shortcuts 是另一个标签页，而此刻已经开着的每一页手里都
  // 还是装载时那份名单。只问一次的话，改成 Ctrl+Shift+Y 的人回到这一页按住
  // Shift，这一层要挡的那次重复请求原样回来 —— 而且要一直回来到他刷新为止。
  const world = load({ liveShortcuts: [] });
  assert.equal(heldRun(world, 'Shift'), 1, '一个命令都没绑着的时候，Shift 本来就该有按住档');

  world.rebind(['Ctrl+Shift+Y']);
  world.tick(2000);
  world.focus();
  assert.equal(heldRun(world, 'Shift'), 0, '回到这一页没重问，旧名单会一直用到他刷新');
});

test('标签页重新露头也算回来了', () => {
  // 同一个窗口里切标签页只发 visibilitychange，不一定有 focus。
  const world = load({ liveShortcuts: [] });
  world.rebind(['Ctrl+Shift+Y']);
  world.tick(2000);
  world.reveal();
  assert.equal(heldRun(world, 'Shift'), 0);
});

test('focus 和 visibilitychange 成对到达时只问一次', () => {
  // 切回一个标签页常常两下一起来，来回点窗口更密。一次按键换一条消息不值当。
  const world = load({ liveShortcuts: [] });
  assert.equal(world.sent.length, 1, '装载时问的那一次');
  world.focus();
  world.reveal();
  assert.equal(world.sent.length, 1, '一秒之内的第二第三下该被并掉');

  world.tick(2000);
  world.focus();
  assert.equal(world.sent.length, 2);
});
