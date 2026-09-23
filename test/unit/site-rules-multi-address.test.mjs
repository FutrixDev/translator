// 一条规则、一组门牌时，matchBuiltin 怎么挑「最具体的那条」。
//
// 单独一个文件，因为这里要的是一张自己造的表：matchBuiltin 读的是进程里那一份
// SiteRulesBuiltin，第一次读就缓存下来，而 node --test 每个文件一个进程 —— 在
// 装 site-rules.js 之前换掉它，这个进程里就只有这张表。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/lang-tags.js');
const rule = (match, tag) => ({
  match, state: 'always', atomicBlockSelectors: [], excludeSelectors: [tag], blockIdAttr: null,
});
globalThis.SiteRulesBuiltin = {
  schemaVersion: 1,
  rulesVersion: 'test',
  blocklist: [],
  rules: [
    // 一组门牌里有一个特别长的域名 —— 它只该让这条规则在**那个**门牌上显得具体。
    rule(['docs.example/guide/*', 'a-very-long-mirror-hostname-for-padding.example'], '.wide'),
    rule('docs.example/guide/api/*', '.narrow'),
    rule(['news.example.jp', 'news.example.de'], '.mirror'),
  ],
};
await import('../../shared/site-rules.js');
const { SiteRules } = globalThis;

const picked = (host, path) => {
  const hit = SiteRules.matchBuiltin(host, path);
  return hit && hit.excludeSelectors[0];
};

test('the more specific address wins, not the rule with the longest address somewhere in it', () => {
  // 两条都命中：左边那条凭的是 20 个字的 docs.example/guide/*，右边是 24 个字的
  // docs.example/guide/api/*。拿规则里最长的那个门牌（47 个字）去比，赢的会是左边。
  assert.equal(picked('docs.example', '/guide/api/fetch'), '.narrow');
  assert.equal(picked('docs.example', '/guide/intro'), '.wide');
  assert.equal(picked('a-very-long-mirror-hostname-for-padding.example', '/'), '.wide');
});

test('every address in the list matches, and only those', () => {
  assert.equal(picked('news.example.jp', '/'), '.mirror');
  assert.equal(picked('www.news.example.de', '/story/1'), '.mirror');
  assert.equal(picked('news.example.fr', '/'), null);
  assert.equal(picked('news.example.jp.evil.net', '/'), null);
});
