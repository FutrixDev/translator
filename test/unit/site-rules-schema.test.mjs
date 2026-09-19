// 内置规则表坏掉的时候，扩展该怎么坏。
//
// 这张表是手写的数据，会因为“某站改版了”被反复编辑，所以写错是迟早的事。写错
// 的代价必须是**翻得碎**（退回通用启发式），不是翻不了，更不是内容脚本在
// 别人的页面上抛异常——那会连带着把选中翻译、字幕、OCR 一起拖下水。
//
// 整表回退而不是逐条剔除，是这里唯一一个需要解释的决定：一条规则的字段名写错
// 了，说明这次改动没经过测试，剩下的规则同样不可信。挑着用比全不用更难排查
// ——线上一半站点的行为变了，而日志里什么都没有。
//
// 黑名单是唯一的例外面：它是安全侧的东西，坏表也要把能认的那些留下。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
const { SiteRules, SiteRulesBuiltin } = globalThis;

const repoFile = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const rule = (over = {}) => Object.assign({
  match: 'example.com',
  state: 'always',
  atomicBlockSelectors: [],
  excludeSelectors: [],
  blockIdAttr: null,
}, over);

const table = (over = {}) => Object.assign({
  schemaVersion: 1,
  rulesVersion: 'test',
  blocklist: ['bank.example'],
  rules: [rule()],
}, over);

test('a table that is right is passed through untouched', () => {
  const loaded = SiteRules.loadTable(table());
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.rules.length, 1);
  assert.deepEqual(loaded.blocklist, ['bank.example']);
});

test('one malformed rule rolls back the whole table, and keeps the blocklist', () => {
  const broken = [
    rule({ state: 'sometimes' }),               // 不是 always/never
    rule({ match: '' }),                        // 空 match 会匹配到所有站点
    rule({ match: 42 }),
    rule({ atomicBlockSelectors: '.abstract' }), // 字符串不是数组：.some 会抛
    rule({ excludeSelectors: [null] }),
    rule({ blockIdAttr: 7 }),
    'not an object',
    null,
  ];
  for (const bad of broken) {
    const loaded = SiteRules.loadTable(table({ rules: [rule({ match: 'good.example' }), bad] }));
    assert.equal(loaded.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.ok(loaded.errors.length > 0);
    // 好的那条也一起退掉——半张表比没有表更难排查。
    assert.deepEqual(loaded.rules, []);
    // 安全侧的东西留下。
    assert.deepEqual(loaded.blocklist, ['bank.example']);
  }
});

test('a schema bump is a rollback, not a silent reinterpretation', () => {
  // 字段含义变了而代码还是老的，照着读比不读更危险。
  for (const schemaVersion of [0, 2, '1', undefined]) {
    const loaded = SiteRules.loadTable(table({ schemaVersion }));
    assert.equal(loaded.ok, false);
    assert.deepEqual(loaded.rules, []);
  }
});

test('two rules for the same match are a merge accident, and are caught', () => {
  // 同一个 match 写两遍，赢的那条取决于声明顺序——而顺序是这套匹配里唯一不该
  // 有意义的东西（命中多条时取最长的那条）。
  const loaded = SiteRules.loadTable(table({ rules: [rule(), rule({ excludeSelectors: ['.x'] })] }));
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join(' '), /duplicate/);
});

test('a table that is not a table at all degrades instead of throwing', () => {
  for (const raw of [undefined, null, 'x', 42, [], {}]) {
    const loaded = SiteRules.loadTable(raw);
    assert.equal(loaded.ok, false);
    assert.deepEqual(loaded.rules, []);
    assert.deepEqual(loaded.blocklist, []);
  }
  // rules 不是数组时，剩下的字段照常读。
  const loaded = SiteRules.loadTable(table({ rules: 'nope' }));
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.blocklist, ['bank.example']);
});

test('the blocklist drops the entries it cannot read, and keeps the rest', () => {
  // 黑名单里混进一个 null，不该让另外二十个域名失去保护。
  const loaded = SiteRules.loadTable(table({ blocklist: ['a.example', null, '', 7, 'b.example'] }));
  assert.deepEqual(loaded.blocklist, ['a.example', 'b.example']);
});

test('the shipped table loads clean — this is the one that would ship broken', () => {
  const loaded = SiteRules.loadTable(SiteRulesBuiltin);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.rules.length, SiteRulesBuiltin.rules.length);
});

// ------------------------------------------------------------- 两条不变量

test('the rules file is data — no functions, no fetch, no storage', () => {
  // 规则从远端拉是 Chrome 的 remote-hosted-code 政策明令禁止的，规则更新就是
  // 发一次版。这一条写在文件的注释里，这里让它有牙齿。
  const src = repoFile('shared/site-rules-builtin.js');
  const body = src.replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /chrome\.storage/, /=>/, /\bfunction\b(?!\s*\(root\))/]) {
    assert.doesNotMatch(body, forbidden, `site-rules-builtin.js grew ${forbidden}`);
  }
});

test('both files are in the content scripts, data before the code that reads it', () => {
  // 内容脚本没有模块系统，清单顺序就是依赖图。site-rules.js 读表是懒的，但让
  // 顺序反过来只会在将来某次“提前读一下”的改动里炸，而且炸得很难看。
  const js = JSON.parse(repoFile('manifest.json')).content_scripts
    .find((entry) => entry.matches.includes('<all_urls>')).js;
  const data = js.indexOf('shared/site-rules-builtin.js');
  const code = js.indexOf('shared/site-rules.js');
  assert.ok(data >= 0, 'site-rules-builtin.js is not in the content scripts');
  assert.ok(code >= 0, 'site-rules.js is not in the content scripts');
  assert.ok(data < code);
});
