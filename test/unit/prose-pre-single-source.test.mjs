// 散文 <pre> 和代码的判定只有一处（content/page/not-prose.js、prose-pre.js、insert.js）。
//
// 悬停翻译以前自带一份不翻的标签串，里面有 pre，于是整篇文章装在一个 <pre> 里的
// 页面（antirez.com 一类），整页能译、悬停一段都译不了；它的译文样式也自带一份位置类
// 的正则。整页收集和悬停必须问同一个答案：哪个标签不翻、什么是代码、什么是代码块
// 容器、译文抄哪些 class。这里扫全部产品源码，任何一样再在第二处写出来就失败。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { productSourceFiles, repoSource } from './helpers/sources.mjs';

const SINGLE_SOURCES = [
  { what: 'the skipped-tag list', re: /['"]script, style, noscript, iframe, textarea/g, home: 'content/page/prose-pre.js' },
  { what: 'the code test', re: /function looksLikeCode\b/g, home: 'content/page/not-prose.js' },
  { what: 'the code-or-URL test', re: /function looksLikeCodeOrUrl\b/g, home: 'content/page/not-prose.js' },
  { what: 'the code-block container test', re: /function isInsideCodeContainer\b/g, home: 'content/page/not-prose.js' },
  { what: 'the position classes a translation must not copy', re: /\(absolute\|fixed\|sticky/g, home: 'content/page/insert.js' },
];

test('prose <pre>, code and translation-class rules are each written in one file', () => {
  const files = productSourceFiles();
  for (const { what, re, home } of SINGLE_SOURCES) {
    const hits = files.flatMap((rel) => (repoSource(rel).match(re) || []).map(() => rel));
    assert.deepEqual(hits, [home], `${what} is written in ${hits.join(', ') || 'no file'}, not once in ${home}`);
  }
});
