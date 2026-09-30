// 只写给读屏器的字（content/page/reader-hidden.js）：给一份计算样式，答「眼睛看不看
// 得见」。样式按 Chrome 计算样式的写法给（`rect(0px, 0px, 0px, 0px)`、`1px`），页面上
// 的整条旅程——Reddit 按钮里的读屏说明不被收、不被译——归
// test/e2e/page-translation-reader-hidden.spec.js。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { AI_TRANSLATOR_CONTENT: {} };
await import('../../content/page/reader-hidden.js');
const { hiddenFromReaders } = globalThis.window.AI_TRANSLATOR_CONTENT;

const visible = { position: 'static', overflow: 'visible', width: '120px', height: '20px', clip: 'auto', clipPath: 'none' };
const at = (patch) => hiddenFromReaders({ ...visible, ...patch });

test('Reddit faceplate-screen-reader-content is hidden', () => {
  assert.equal(at({
    position: 'absolute', overflow: 'hidden', width: '1px', height: '1px',
    clip: 'rect(0px, 0px, 0px, 0px)', clipPath: 'inset(50%)',
  }), true);
});

test('each of the three ways of hiding is enough on its own', () => {
  assert.equal(at({ clipPath: 'inset(50%)' }), true, 'clip-path inset(50%)');
  assert.equal(at({ position: 'absolute', clip: 'rect(0px, 0px, 0px, 0px)' }), true, 'zero clip');
  assert.equal(at({ position: 'fixed', clip: 'rect(1px, 1px, 1px, 1px)' }), true, 'the old .visually-hidden clip');
  assert.equal(at({ position: 'absolute', overflow: 'hidden', width: '1px', height: '1px' }), true, '1px box');
  assert.equal(at({ position: 'absolute', overflow: 'clip', width: '0px' }), true, '0 wide');
});

test('ordinary visible text is not hidden', () => {
  assert.equal(at({}), false);
  // 角标、提示框：绝对定位 + 溢出裁掉，但是正常大小。
  assert.equal(at({ position: 'absolute', overflow: 'hidden' }), false);
  // 裁出一块有面积的矩形。
  assert.equal(at({ position: 'absolute', clip: 'rect(0px, 100px, 100px, 0px)' }), false);
  assert.equal(at({ clipPath: 'inset(10%)' }), false);
  // 1px 宽但溢出照常显示：字画在盒子外面，眼睛看得见。
  assert.equal(at({ position: 'absolute', width: '1px' }), false);
  // 淡入动画的起点、悬停才出现的菜单：不算隐藏。
  assert.equal(at({ opacity: '0' }), false);
});

test('clip-path inset hides only when opposite sides cut away 100% together', () => {
  for (const clipPath of ['inset(50%)', 'inset(50% 50%)', 'inset(50% 0px)', 'inset(100% 0px 0px)', 'inset(0px 60% 0px 40%)', 'inset(50% round 4px)', 'inset(0px 50%)']) {
    assert.equal(at({ clipPath }), true, clipPath);
  }
  // 只切掉上面六成：下面四成照样看得见。
  for (const clipPath of ['inset(60% 0px 0px)', 'inset(49%)', 'inset(0px 40%)', 'inset(10px)', 'inset(40% 0px 50%)']) {
    assert.equal(at({ clipPath }), false, clipPath);
  }
});

test('clip only counts where it applies (absolute or fixed)', () => {
  assert.equal(at({ clip: 'rect(0px, 0px, 0px, 0px)' }), false);
  assert.equal(at({ position: 'relative', overflow: 'hidden', width: '1px' }), false);
});

test('a style with none of these properties reads as visible', () => {
  // 单测里的假 DOM 只给 display：缺属性就是没写，不能当成隐藏。
  assert.equal(hiddenFromReaders({ display: 'inline' }), false);
  assert.equal(hiddenFromReaders({}), false);
});
