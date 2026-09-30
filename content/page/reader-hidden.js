// Blab Translation — 整页翻译：只写给读屏器的字
//
// 页面上有一类字眼睛看不见、只有读屏器会念：Reddit 按钮里的
// <faceplate-screen-reader-content>「12 条评论，前往帖子」、Bootstrap 的 .sr-only、
// Tailwind 的 sr-only 写法。收集器把它们当正文收进来，译文就排在按钮、链接旁边，
// 成了一串谁也没写过的可见文字（D-429）。
//
// 认的是计算样式，不是类名：各家的类名互不相同，落到样式上是同几种裁法——
//
// - `clip-path: inset(50%)`：盒子从两边各切掉一半，面积为 0；
// - 绝对 / 固定定位下 `clip` 是零面积矩形（`rect(0 0 0 0)`、`rect(1px 1px 1px 1px)`）；
// - 绝对 / 固定定位、溢出裁掉，宽或高不过 1px。
//
// `clip` 只对绝对 / 固定定位生效（静态元素上计算样式照样报它写的值），所以那两条
// 先问定位。`opacity: 0` 不算：淡入动画的起点、悬停才显出来的菜单都是它。
// 收块（collect.js 的 processElement）和读文本（processNode）共用这一条。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const RECT = /^rect\(\s*([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px\s*\)$/;
  const INSET = /^inset\(\s*([\d.]+)%/;

  function hiddenFromReaders(style) {
    const inset = INSET.exec(style.clipPath || '');
    if (inset && +inset[1] >= 50) return true;
    if (style.position !== 'absolute' && style.position !== 'fixed') return false;
    // rect(上 右 下 左)：下不过上、或右不过左，面积就是 0。
    const clip = RECT.exec(style.clip || '');
    if (clip && (+clip[3] <= +clip[1] || +clip[2] <= +clip[4])) return true;
    return !!style.overflow && style.overflow !== 'visible' &&
      (parseFloat(style.width) <= 1 || parseFloat(style.height) <= 1);
  }

  ctx.hiddenFromReaders = hiddenFromReaders;
})();
