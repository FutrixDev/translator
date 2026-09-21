import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 三族内容脚本共用同一种架子：跨文件的名字挂到 `ctx.<族>` 上，取值发生在调用时，
 * 装载顺序因此无关紧要。**代价是编译器帮不上忙** —— 普通脚本各自一个 IIFE，裸着
 * 叫一个住在别处的名字不会在装载时报错，要等到那条路真被走到才抛 ReferenceError。
 *
 * 拆族时就这么漏过一个：`...newEntry(img)` 里的展开运算符，前一个字符正好是 `.`，
 * 加前缀的工具把它当成属性访问放过了。于是「重载后接回在跑的漫画任务」这条路整个
 * 断掉，而三族全部单元测试都是绿的 —— 只有一条 e2e 走到了那里。
 *
 * 这一份就是那个编译器：每个文件里，凡是出现在架子上的名字，要么是本文件自己声明
 * 的，要么必须带前缀。
 */
const FAMILIES = [
  { dir: 'content/comic', entry: 'content/content-comic-translation.js', alias: 'comic' },
  { dir: 'content/captions', entry: 'content/content-video-captions.js', alias: 'caps' },
  { dir: 'content/hover', entry: 'content/content-hover-translation.js', alias: 'hov' },
];

/** 注释和字面量里的字不是标识符，先抹掉，免得一句中文注释提到某个函数名就算数。 */
function stripLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function exportBlocks(source, alias) {
  return [...source.matchAll(new RegExp(`Object\\.assign\\(${alias},\\s*\\{[\\s\\S]*?\\n {2}\\}\\)`, 'g'))]
    .map((m) => m[0]);
}

function familyFiles({ dir, entry }) {
  return [
    ...readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.js')).sort().map((n) => `${dir}/${n}`),
    entry,
  ];
}

for (const family of FAMILIES) {
  const { alias } = family;
  const files = familyFiles(family);
  const sources = new Map(files.map((rel) => [rel, stripLiterals(readFileSync(path.join(ROOT, rel), 'utf8'))]));

  // 架子上有什么，由 Object.assign 的那几块说了算。
  const shelf = new Set();
  for (const source of sources.values()) {
    for (const block of exportBlocks(source, alias)) {
      for (const name of block.slice(block.indexOf('{') + 1).match(/[A-Za-z_$][\w$]*/g) || []) shelf.add(name);
    }
  }

  test(`${alias}：架子上不是空的`, () => {
    assert.ok(shelf.size > 5, `${alias} 的 Object.assign 没解析出名字，检查导出块的写法`);
  });

  for (const [rel, source] of sources) {
    // 导出块本身列的就是裸名字，不算引用。
    let body = source;
    for (const block of exportBlocks(source, alias)) body = body.replace(block, '');

    const local = new Set();
    for (const m of body.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
    for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
    // 解构出来的也是本文件的局部名。
    for (const m of body.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
      for (const name of m[1].match(/[A-Za-z_$][\w$]*/g) || []) local.add(name);
    }

    test(`${rel}：跨文件的名字都带 ${alias}. 前缀`, () => {
      const offenders = [];
      for (const name of shelf) {
        if (local.has(name)) continue;
        for (const m of body.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g'))) {
          const before = body.slice(Math.max(0, m.index - 3), m.index);
          // `foo.bar` 是属性访问；`...bar` 不是 —— 这就是当初漏掉的那一种。
          if (/\.$/.test(before) && !/\.\.\.$/.test(before)) continue;
          if (body.slice(m.index + name.length).trimStart().startsWith(':')) continue;
          offenders.push(`${name}（第 ${body.slice(0, m.index).split('\n').length} 行附近）`);
        }
      }
      assert.deepEqual(
        offenders, [],
        `${rel} 里这些名字住在别的文件，要写成 ${alias}.<名字>：${offenders.join('、')}`,
      );
    });
  }
}
