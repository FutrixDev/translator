// 不是正文的字（content/page/not-prose.js）：纯数字，和控件上的短标签。组合树工具
// （closestComposed / composedChildNodes / inHiddenSlot）用一棵带父指针的小树顶替，
// 它们自己的行为归 page-coverage 那几份测试；读屏说明的判定用真的 reader-hidden.js。
// 页面上的整条旅程——Reddit 按钮、投票数、规则序号不被收——归
// test/e2e/page-translation-not-prose.spec.js。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const TEXT = 3;
const ELEMENT = 1;
globalThis.Node = { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT };

const shown = { display: 'inline', position: 'static', overflow: 'visible', width: '40px', height: '16px', clip: 'auto', clipPath: 'none' };
const srOnly = { ...shown, position: 'absolute', overflow: 'hidden', width: '1px', height: '1px', clip: 'rect(0px, 0px, 0px, 0px)' };

globalThis.window = {
  AI_TRANSLATOR_CONTENT: {},
  getComputedStyle: (el) => el.style,
};
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

// 选择器只认两种写法：标签名、[role=x]——not-prose.js 的控件串就只用这两种。
function matches(el, selector) {
  return selector.split(',').some((part) => {
    const role = /^\[role=(\w+)\]$/.exec(part);
    return role ? el.role === role[1] : el.tagName === part.toUpperCase();
  });
}
ctx.closestComposed = (el, selector) => {
  for (let node = el; node; node = node.parent) if (matches(node, selector)) return node;
  return null;
};
ctx.composedChildNodes = (el) => el.children;
ctx.inHiddenSlot = () => false;

await import('../../content/page/reader-hidden.js');
await import('../../content/page/not-prose.js');
const { notProse } = ctx;

function el(tagName, children = [], { role, style = shown } = {}) {
  const node = { nodeType: ELEMENT, tagName, role, style, children: [], parent: null };
  for (const child of children) {
    const kid = typeof child === 'string' ? { nodeType: TEXT, textContent: child } : child;
    kid.parent = node;
    node.children.push(kid);
  }
  return node;
}
// 控件里的一个 <span>，返回这个 span（收集器收到的就是它）。
function labelIn(control) {
  return control.children.find((c) => c.nodeType === ELEMENT) || control;
}

test('number-only text is not prose, whatever the tag', () => {
  const p = el('P', ['x']);
  for (const text of ['12', '1', '94.2%', '±0.02', '1,234', '24–17', '3:45', '$1.99']) {
    assert.equal(notProse(p, text), true, text);
  }
  for (const text of ['N/A', '—', 'Top 10 plays of week 4', 'Q3', '']) {
    assert.equal(notProse(p, text), false, JSON.stringify(text));
  }
});

test('a short label on a button is not prose', () => {
  const button = el('BUTTON', [el('SPAN', ['Share'])]);
  assert.equal(notProse(labelIn(button), 'Share'), true);
  // 元素就是控件本身。
  assert.equal(notProse(el('BUTTON', ['Join']), 'Join'), true);
  // 三个词、30 个字符，都还算短标签。
  assert.equal(notProse(el('BUTTON', ['Join the conversation']), 'Join the conversation'), true);
});

test('each control role counts; links do not', () => {
  for (const role of ['button', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'switch']) {
    assert.equal(notProse(el('DIV', ['Best'], { role }), 'Best'), true, role);
  }
  assert.equal(notProse(el('A', ['Best']), 'Best'), false, '<a>');
  assert.equal(notProse(el('SPAN', ['Best'], { role: 'link' }), 'Best'), false, 'role=link');
});

test('the screen-reader sentence inside a button does not make its label long', () => {
  // Reddit 的原样结构：看得见的是 Share，读屏说明是一整句。
  const button = el('BUTTON', [
    el('SPAN', ['Share']),
    el('FACEPLATE-SCREEN-READER-CONTENT', ['Share this post with other people'], { style: srOnly }),
  ]);
  assert.equal(notProse(labelIn(button), 'Share'), true);
  // display:none 的子树同样不算。
  const menu = el('BUTTON', [el('SPAN', ['More']), el('DIV', ['Award Share Report Save Hide'], { style: { ...shown, display: 'none' } })]);
  assert.equal(notProse(labelIn(menu), 'More'), true);
});

test('a control whose visible text is prose is not skipped', () => {
  // 整张卡片写成 role=button：卡片里的标题、正文要照译。
  const card = el('DIV', [
    el('H3', ['Which quarterback has quietly improved the most']),
    el('P', ['Every week the numbers say one thing.']),
  ], { role: 'button' });
  assert.equal(notProse(card.children[0], 'Which quarterback has quietly improved the most'), false);
  // 四个词。
  assert.equal(notProse(el('BUTTON', ['Show more of this']), 'Show more of this'), false);
  // 句末标点：一句话。
  assert.equal(notProse(el('BUTTON', ['Try again.']), 'Try again.'), false);
  assert.equal(notProse(el('BUTTON', ['稍后再试。']), '稍后再试。'), false);
  // 省略号、版本号里的点不是句号。
  assert.equal(notProse(el('BUTTON', ['Loading…']), 'Loading…'), true);
  assert.equal(notProse(el('BUTTON', ['v1.2']), 'v1.2'), true);
});

test('two CJK characters count as one word', () => {
  for (const label of ['分享', '加入', '查看全部评论', 'もっと見る', '공유하기', '分享 3']) {
    assert.equal(notProse(el('BUTTON', [label]), label), true, label);
  }
  // 七个字已经是四个词；一句二十个字的标题更不是标签。
  const headline = '本周最值得关注的二十条新闻合集来了看看吧';
  assert.equal(notProse(el('BUTTON', ['查看全部七条评论']), '查看全部七条评论'), false);
  assert.equal(notProse(el('DIV', [headline], { role: 'button' }), headline), false);
});

test('a control holding a heading or a paragraph is a card, not a label', () => {
  // 一句三个词的标题，单独放在 role=button 的卡片里，照样要译。
  const card = el('DIV', [el('H3', ['Quarterback rankings updated'])], { role: 'button' });
  assert.equal(notProse(card.children[0], 'Quarterback rankings updated'), false);
  const cardP = el('DIV', [el('SPAN', ['Hot']), el('P', ['New thread'])], { role: 'button' });
  assert.equal(notProse(cardP.children[1], 'New thread'), false);
  // 控件本身就是标题。
  assert.equal(notProse(el('H2', ['Top stories'], { role: 'button' }), 'Top stories'), false);
});

test('text inside an <svg> is not a visible label', () => {
  // <title> 不画出来：按钮看得见的只有 Share。
  const button = el('BUTTON', [
    el('svg', [el('title', ['Share this post with the people you follow'])]),
    el('SPAN', ['Share']),
  ]);
  assert.equal(notProse(button.children[1], 'Share'), true);
});

test('text outside any control is prose', () => {
  assert.equal(notProse(el('P', ['Share']), 'Share'), false);
});
