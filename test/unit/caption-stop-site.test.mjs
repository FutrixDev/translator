// 「不再自动翻译 {site}」那一行什么时候露 —— content/captions/activation.js 的
// stopSiteOffered()，播放器菜单（controls.sync 的 stopSite）和 popup
// （AUTO_PAGE_STATE 的 captionStopSite）问的是它同一份。
//
// 它补的是闸门和站点规则中间那一片 ask：没设过规则的视频站上闸门开着、字幕照翻，
// 第一行却印着「关」。这里执行真代码而不是对着源文件比正则 —— 这一行的每一个条
// 件都是「什么时候**不**露」，写错了看不出来。activation.js 是个 IIFE，挂在
// window / document / location 上，所以拿 vm 给它造一个最小的页面；SiteRules 用
// 真的（siteRuleWritable 的判断就在那里）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SOURCES = [
  'shared/lang-tags.js',
  'shared/site-rules-builtin.js',
  'shared/site-rules.js',
  'content/captions/activation.js',
].map((rel) => [rel, read(rel)]);

const PROVIDER = { id: 'youtube' };

/**
 * 装一页。`snap` 是调度层快照（null = 调度层还没起来），`provider` 是这一页的
 * 候选 provider（null = 没有字幕可翻），`state` 是引擎上一拍记下的闸门和站点规则。
 */
function load({ hostname = 'www.youtube.com', pathname = '/watch', snap, provider = PROVIDER,
                state = {} } = {}) {
  const synced = [];
  const ctx = {
    captionProviders: provider ? [provider] : [],
    captionControls: { sync: (info) => synced.push(info), unmount() {} },
    autoTranslate: snap === null ? undefined : { state: () => snap },
    captions: {
      state: { enabled: false, siteAuto: false, provider: null, cues: [], ...state },
      getSetting: () => undefined,
      sameLanguage: () => false,
    },
  };
  const sandbox = {
    window: { AI_TRANSLATOR_CONTENT: ctx },
    // 没有 <video>：syncControls 就不起心跳，测试里不留计时器。
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    location: { hostname, pathname },
    console,
    CaptionCore: { selectProvider: (list) => list[0] || null },
  };
  vm.createContext(sandbox);
  for (const [filename, source] of SOURCES) vm.runInContext(source, sandbox, { filename });
  return { ctx, synced };
}

const UNDECIDED = { siteAuto: false, siteRefused: false };

test('没设过规则的站点上字幕照翻：那一行露出来', () => {
  const { ctx } = load({ snap: UNDECIDED });
  assert.equal(ctx.captionStopSiteOffered(), true);
});

test('站点已经是「自动」：第一行自己就是关的路，这一行不露', () => {
  const { ctx } = load({ snap: { siteAuto: true, siteRefused: false } });
  assert.equal(ctx.captionStopSiteOffered(), false);
});

test('站点已经被拒绝：字幕本来就不翻，这一行不露', () => {
  const { ctx } = load({ snap: { siteAuto: false, siteRefused: true } });
  assert.equal(ctx.captionStopSiteOffered(), false);
});

test('问不到调度层就当是拒绝 —— 和闸门同一个口径', () => {
  assert.equal(load({ snap: null }).ctx.captionStopSiteOffered(), false);
  // 快照里没有 siteRefused 这个字段也算说不准。
  assert.equal(load({ snap: { siteAuto: false } }).ctx.captionStopSiteOffered(), false);
});

test('这一页没有字幕可翻：说的是一件没在发生的事，不露', () => {
  const { ctx } = load({ snap: UNDECIDED, provider: null });
  assert.equal(ctx.captionStopSiteOffered(), false);
});

test('规则写不进去的页面不露 —— 按下去 setSiteAuto 会抛', () => {
  // file:// 上 location.hostname 是空串，normalizeHost 给不出键。
  const { ctx } = load({ hostname: '', pathname: '/Users/me/clip.html', snap: UNDECIDED });
  assert.equal(ctx.captionStopSiteOffered(), false);
});

test('菜单那一路拿的是和第一行同一拍的 state，不是再问一遍调度层', () => {
  // 快照已经翻篇（站点被拒绝了），可引擎还没重来一遍：菜单那一拍画的第一行和
  // 这一行得是同一个答案，都出自 state。
  const { ctx, synced } = load({
    snap: { siteAuto: false, siteRefused: true },
    state: { enabled: true, siteAuto: false },
  });
  ctx.captions.syncControls();
  assert.equal(synced.length, 1);
  assert.equal(synced[0].enabled, true);
  assert.equal(synced[0].siteAuto, false);
  assert.equal(synced[0].stopSite, true);

  ctx.captions.state.siteAuto = true;
  ctx.captions.syncControls();
  assert.equal(synced[1].stopSite, false);

  ctx.captions.state.siteAuto = false;
  ctx.captions.state.enabled = false;
  ctx.captions.syncControls();
  assert.equal(synced[2].stopSite, false);
});
