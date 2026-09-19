// 整页翻译拆成 content/page/*.js 之后，要一直成立的几条。
//
// 这些文件是 classic script，没有模块系统：跨文件引用全靠运行时读 ctx.x()，
// manifest 的顺序不是依赖图。这意味着两类错误都不会在加载时报出来——
//   1. 新文件忘了写进 manifest：谁调它谁在运行时拿到 undefined，
//      报出来的是三步之后的 TypeError；
//   2. 某个文件直接写了别人的局部名：在浏览器里是 ReferenceError，
//      在 node 单测里可能因为恰好同名而蒙混过去。
// 所以这两条都在这里守着。
//
// 第三条是这次拆分的目的本身：runTranslationPass 只管翻一轮，不碰进度条。
// 自动翻译（PR-6）要跑不露面的增量轮次，那时候同一个函数不能拖着一条进度条。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const MODULE_DIR = 'content/page';
const modules = readdirSync(fileURLToPath(new URL(`../../${MODULE_DIR}`, import.meta.url)))
  .filter((name) => name.endsWith('.js'))
  .sort();
const source = Object.fromEntries(modules.map((name) => [name, repoFile(`${MODULE_DIR}/${name}`)]));

// 注释里点名另一个文件的函数是有用的（读的人才知道这里为什么绕），所以判断
// “谁在用谁”之前先把注释去掉。
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// `ctx.foo = foo;` —— 以本名挂出去的才算导出面。箭头函数包装的（比如
// getManagedSkipCount）拿不到内部名字，本来也没有被别人写成裸名的风险。
const exportedNames = (text) =>
  [...text.matchAll(/ctx\.([A-Za-z_$][\w$]*)\s*=\s*\1\s*;/g)].map((m) => m[1]);

test('每个模块都在 manifest 里，否则它的函数只是运行时的 undefined', () => {
  const bundle = JSON.parse(repoFile('manifest.json')).content_scripts
    .find((entry) => entry.matches.includes('<all_urls>'));
  assert.ok(bundle, 'the <all_urls> content script bundle is gone');
  for (const name of modules) {
    assert.ok(bundle.js.includes(`${MODULE_DIR}/${name}`),
      `${MODULE_DIR}/${name} is not loaded anywhere — everything it exports is undefined at call time`);
  }
  assert.ok(bundle.js.includes('content/content-page-translation.js'));
});

test('跨文件只走 ctx，所以 manifest 的顺序不是依赖图', () => {
  const leaks = [];
  for (const owner of modules) {
    for (const name of exportedNames(source[owner])) {
      for (const other of modules) {
        if (other === owner) continue;
        const bare = stripComments(source[other]).match(new RegExp(`(?<!ctx\\.)\\b${name}\\b`, 'g'));
        if (bare) leaks.push(`${other} → ${name}（${owner} 的局部名，写成 ctx.${name}()）`);
      }
    }
  }
  assert.deepEqual(leaks, []);
});

test('一轮翻译只报数，进度条归页面那一层', () => {
  // 这正是拆出 runTranslationPass 的理由：自动翻译的增量轮次不该露面。
  const batch = source['batch.js'];
  const fn = batch.slice(batch.indexOf('async function runTranslationPass'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.ok(body.includes('onProgress('), 'the pass no longer reports progress to its caller');
  assert.doesNotMatch(body, /translationProgress|PageTranslationProgress/,
    'runTranslationPass reaches back into the page-level progress bar');

  // 页面那一层还在：整页翻译当然要显示进度。
  const facade = repoFile('content/content-page-translation.js');
  assert.match(facade, /onProgress:/);
  assert.match(facade, /ctx\.updatePageTranslationProgress\(/);
});

test('没有一个文件重新长回一千行', () => {
  // thermos 的口径：一个文件长到一千行，就说明它其实是两件事。
  for (const [name, text] of Object.entries(source)) {
    const lines = text.split('\n').length;
    assert.ok(lines < 1000, `${MODULE_DIR}/${name} is ${lines} lines — split it before it splits itself`);
  }
  // 门面只剩“一次整页翻译是怎么一回事”，别的都搬走了。
  assert.ok(repoFile('content/content-page-translation.js').split('\n').length < 200);
});
