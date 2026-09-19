// 「这一页现在该不该自己翻译」只有一个答案，在 shared/site-rules.js。
//
// 这一套测试守的是那条阶梯的**顺序**——顺序才是这个模块里唯一会出事的东西。
// 每一条判断单独看都对；错都错在谁在谁前面：黑名单排在用户的“总是翻译”后面，
// 就等于用户在某个域名上点过一次，我们此后往他的邮箱里插节点。
//
// 另外守两件事：主机名的归一化只会少剥不会多剥（多剥一层就是把整个后缀圈进
// 来），以及 reason 是枚举不是人话（拼出来的句子没法测，也没法翻译）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
await import('../../shared/caption-core.js');
const { SiteRules, SiteRulesBuiltin, CaptionCore } = globalThis;
const R = SiteRules.REASONS;

// 一页普通的英文网页，开着自动翻译，什么规则都没命中——阶梯的中性起点。
const ask = (over = {}) => Object.assign({
  host: 'example.com',
  path: '/article/1',
  pageLang: 'en',
  targetLang: 'zh-CN',
  userRules: {},
  settings: { autoTranslate: true, autoTranslateLangs: [] },
  explicit: false,
}, over);

const verdict = (over) => SiteRules.decide(ask(over));

// ------------------------------------------------------------ 阶梯的顺序

test('the blocklist outranks the user own always — that is what it is for', () => {
  // 用户在 google.com 上点过“总是翻译”，父域查找会让它命中 mail.google.com。
  // 这正是黑名单存在的那一刻：它防的不是“用户想翻银行页面”，是“一次点击换来
  // 我们往他的收件箱里插节点”。
  const inbox = verdict({ host: 'mail.google.com', userRules: { 'google.com': 'always' } });
  assert.equal(inbox.verdict, 'off');
  assert.equal(inbox.reason, R.BLOCKLIST);

  // 同一条用户规则在没被拉黑的子域上照常生效，否则上面那条就成了“误伤”。
  const docs = verdict({ host: 'news.google.com', userRules: { 'google.com': 'always' } });
  assert.equal(docs.verdict, 'auto');
  assert.equal(docs.reason, R.USER_ALWAYS);
});

test('the blocklist matches subdomains, and does not match a longer public suffix', () => {
  assert.equal(verdict({ host: 'www.irs.gov' }).reason, R.BLOCKLIST);
  assert.equal(verdict({ host: 'secure.chase.com' }).reason, R.BLOCKLIST);
  // 'gov' 不以 '.gov' 结尾地命中 gov.uk —— 所以表里必须另有一行，而它有。
  assert.equal(verdict({ host: 'hmrc.gov.uk' }).reason, R.BLOCKLIST);
  // 后缀匹配不能退化成子串匹配：这两个域名都含 'gov'，都不该被拦。
  assert.equal(verdict({ host: 'govtech.com' }).verdict, 'ask');
  assert.equal(verdict({ host: 'mygov.example.com' }).verdict, 'ask');
});

test('an explicit page keeps going even with the global switch off', () => {
  // 用户自己点过翻译，页面后来长出来的内容跟上，是在兑现那次点击。
  // 这一条要是答 off 或 ask，调度层就只能绕过 decide() 自己判一遍。
  const d = verdict({ explicit: true, settings: { autoTranslate: false } });
  assert.equal(d.verdict, 'auto');
  assert.equal(d.reason, R.USER_EXPLICIT);

  // 但它越不过“这里不许动”的三条。
  assert.equal(verdict({ explicit: true, host: 'docs.google.com' }).reason, R.BLOCKLIST);
  assert.equal(verdict({ explicit: true, userRules: { 'example.com': 'never' } }).reason, R.USER_NEVER);
});

test('the global switch stops everything else', () => {
  const off = { autoTranslate: false, autoTranslateLangs: [] };
  assert.equal(verdict({ settings: off }).reason, R.GLOBAL_OFF);
  // 连内置 always 的站点也不例外——总开关关掉就是“我们自己不主动开始”。
  assert.equal(verdict({ host: 'x.com', settings: off }).reason, R.GLOBAL_OFF);
  assert.equal(verdict({ host: 'x.com', settings: off, userRules: { 'x.com': 'always' } }).reason, R.GLOBAL_OFF);
  // 它也排在黑名单之前：一个没翻过的页面在总开关关着时，理由该是那条用户能自
  // 己操作的，而不是「这个站点被禁了」。
  assert.equal(verdict({ host: 'mail.google.com', settings: off }).reason, R.GLOBAL_OFF);
});

test('a user rule outranks the built-in table, in both directions', () => {
  // 内置表说 x.com 总是翻；用户说别翻。用户赢，否则“永不翻译”在最该管用的地方
  // 不管用。
  assert.equal(verdict({ host: 'x.com', userRules: { 'x.com': 'never' } }).reason, R.USER_NEVER);
  assert.equal(verdict({ host: 'x.com' }).reason, R.BUILTIN_ALWAYS);
});

test('the language rules only gate the sites nobody has spoken for', () => {
  // 同语言：翻了等于没翻。
  assert.equal(verdict({ pageLang: 'zh-TW', targetLang: 'zh-CN' }).reason, R.SAME_LANGUAGE);
  // 不在名单里。
  const listed = { autoTranslate: true, autoTranslateLangs: ['en', 'ja'] };
  assert.equal(verdict({ pageLang: 'de', settings: listed }).reason, R.LANG_NOT_LISTED);
  assert.equal(verdict({ pageLang: 'en-GB', settings: listed }).verdict, 'ask');

  // 而用户/内置的 always 在语言规则之前，所以 x.com 上的德文推文照翻。
  assert.equal(verdict({ host: 'x.com', pageLang: 'de', settings: listed }).reason, R.BUILTIN_ALWAYS);
});

test('an unread language is a question, not a guess', () => {
  const unknown = verdict({ pageLang: null });
  assert.equal(unknown.verdict, 'ask');
  assert.equal(unknown.reason, R.UNKNOWN_LANGUAGE);
  // 语言判不出来时，“不在名单里”这条不能顺手把它判死。
  assert.equal(verdict({ pageLang: null, settings: { autoTranslate: true, autoTranslateLangs: ['ja'] } }).reason,
    R.UNKNOWN_LANGUAGE);

  const plain = verdict({});
  assert.equal(plain.verdict, 'ask');
  assert.equal(plain.reason, R.DEFAULT_ASK);
});

test('the default answer for an unknown site is ask, never auto', () => {
  // 黑名单永远列不全，真正兜底的是这一条。
  for (const host of ['some-bank-nobody-listed.com', 'intranet.corp', '10.0.0.7', 'localhost']) {
    assert.equal(verdict({ host }).verdict, 'ask', `${host} translated itself`);
  }
});

test('the language judgement agrees with the one the captions use', () => {
  // 两个模块各有一份 getLangBase。一旦分叉，同一对语言在整页翻译里算“同语言”、
  // 在字幕里不算——这种不一致只会以“有时候不翻”的形式被用户看见。
  const pairs = [
    ['zh-CN', 'zh-Hans'], ['en-GB', 'en'], ['EN', 'en-US'],
    ['pt-BR', 'pt-PT'], ['ja', 'ja-JP'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(CaptionCore.getLangBase(a), CaptionCore.getLangBase(b), `test data wrong for ${a}/${b}`);
    assert.equal(verdict({ pageLang: a, targetLang: b }).reason, R.SAME_LANGUAGE,
      `site-rules reads ${a}/${b} as different languages, caption-core does not`);
  }
  // 反过来也要一致：base 不同就不是同语言。
  assert.equal(verdict({ pageLang: 'en', targetLang: 'zh-CN' }).verdict, 'ask');
});

// ------------------------------------------------------------ 主机名

test('normalizeHost keeps the registrable domain, and under-strips on purpose', () => {
  const n = SiteRules.normalizeHost;
  assert.equal(n('mobile.x.com'), 'x.com');
  assert.equal(n('www.reddit.com'), 'reddit.com');
  assert.equal(n('old.reddit.com'), 'reddit.com');
  assert.equal(n('X.COM.'), 'x.com');          // 大小写和根点
  assert.equal(n('a.b.c.example.com'), 'example.com');

  // 两段公共后缀：剥到 co.uk 就等于把整个英国圈进一条规则。
  assert.equal(n('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(n('shop.example.com.cn'), 'example.com.cn');
  assert.equal(n('lab.example.ac.jp'), 'example.ac.jp');

  // 没有注册域可言的主机原样返回，不能被切成 '0.1'。
  assert.equal(n('10.0.0.7'), '10.0.0.7');
  assert.equal(n('localhost'), 'localhost');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
});

test('a user rule is looked up along the parent chain, so normalizeHost is a convenience', () => {
  // 归一化只决定“点总是翻译时存在哪个键下”。查的时候沿父域一路往上，所以就算
  // 某个冷门后缀被保守地少剥了一层，精确写下的那条规则依然命中。
  const rules = { 'example.co.uk': 'always' };
  assert.equal(verdict({ host: 'shop.example.co.uk', userRules: rules }).reason, R.USER_ALWAYS);
  assert.equal(verdict({ host: 'example.co.uk', userRules: rules }).reason, R.USER_ALWAYS);

  // 父域不会因为子域的规则被圈进去。
  assert.equal(verdict({ host: 'example.com', userRules: { 'a.example.com': 'never' } }).verdict, 'ask');
  // 更近的那条赢。
  assert.equal(verdict({
    host: 'a.example.com', userRules: { 'a.example.com': 'never', 'example.com': 'always' },
  }).reason, R.USER_NEVER);
});

test('a single-label host can carry a user rule — it is where normalizeHost puts it', () => {
  // localhost、公司内网的 wiki/jira 都是单标签主机，normalizeHost 原样返回，所
  // 以点「总是翻译」就存在这个键下。父域查找要是从「第一个父域」开始数，这条
  // 规则写下去就永远查不到——用户点了，什么都没发生，也没有任何报错。
  for (const host of ['localhost', 'wiki', 'jira']) {
    assert.equal(verdict({ host, userRules: { [host]: 'always' } }).reason, R.USER_ALWAYS);
    assert.equal(verdict({ host, userRules: { [host]: 'never' } }).reason, R.USER_NEVER);
  }
  // IP 同理：它只问它自己，不问不存在的「父域」。
  assert.equal(verdict({ host: '10.0.0.7', userRules: { '10.0.0.7': 'always' } }).reason, R.USER_ALWAYS);
  assert.equal(verdict({ host: '10.0.0.7', userRules: { '0.0.7': 'always' } }).verdict, 'ask');
});

test('a bare TLD is never asked — that rule would cover half the web', () => {
  assert.equal(verdict({ host: 'example.com', userRules: { com: 'always' } }).verdict, 'ask');
  assert.equal(verdict({ host: 'shop.example.co.uk', userRules: { uk: 'never' } }).verdict, 'ask');
});

// ------------------------------------------------------------ 内置规则

test('a built-in rule matches its subdomains and its path glob', () => {
  const m = SiteRules.matchBuiltin;
  assert.equal(m('arxiv.org', '/abs/2401.00001').match, 'arxiv.org/abs/*');
  // 带路径的规则不能整站生效：列表页、PDF 页结构完全不同。
  assert.equal(m('arxiv.org', '/list/cs.CL/recent'), null);
  assert.equal(m('arxiv.org', '/'), null);

  assert.equal(m('mobile.x.com', '/home').match, 'x.com');
  assert.equal(m('old.reddit.com', '/r/rust/').match, 'reddit.com');
  assert.equal(m('example.com', '/'), null);
});

test('the matched rule rides along with every verdict, including the off ones', () => {
  // 适配层要它的 selector，那和“这次翻不翻”是两件事。
  const blocked = SiteRules.decide(ask({ host: 'x.com', userRules: { 'x.com': 'never' } }));
  assert.equal(blocked.verdict, 'off');
  assert.equal(blocked.rule.match, 'x.com');
  assert.deepEqual(blocked.rule.atomicBlockSelectors, ['[data-testid="tweetText"]']);
  assert.equal(SiteRules.decide(ask({})).rule, null);
});

test('the rule handed out is frozen — the adapter layer gets a copy of nothing', () => {
  // 交出去的是进程里唯一的那一份。适配层往 excludeSelectors 里 push 一条，就是
  // 永久改写了所有 x.com 标签页的行为，而且下次读到时没有任何痕迹。
  const rule = SiteRules.matchBuiltin('x.com', '/home');
  assert.ok(Object.isFrozen(rule));
  assert.ok(Object.isFrozen(rule.excludeSelectors));
  assert.throws(() => rule.excludeSelectors.push('.injected'), TypeError);
  assert.throws(() => { rule.state = 'never'; }, TypeError);
  assert.deepEqual(SiteRules.matchBuiltin('x.com', '/home').excludeSelectors,
    ['[data-testid="User-Name"] a', 'time', '[role="group"]']);
});

test('the shipped table is internally consistent', () => {
  const table = SiteRules.loadTable(SiteRulesBuiltin);
  assert.deepEqual(table.errors, []);
  assert.equal(table.ok, true);
  assert.ok(table.rules.length > 0 && table.blocklist.length > 0);

  // 一条内置 always 的规则同时又在黑名单上，就是表自己跟自己打架：黑名单赢，
  // 那条规则永远不会生效，而写它的人不会知道。
  for (const rule of table.rules) {
    const { verdict: v } = SiteRules.decide(ask({
      host: rule.match.split('/')[0],
      path: rule.match.includes('/') ? `/${rule.match.split('/').slice(1).join('/').replace('*', 'x')}` : '/',
    }));
    assert.notEqual(v, 'off', `${rule.match} is shadowed by the blocklist`);
  }
});

test('reasons are an enum, and every verdict is one of three words', () => {
  // reason 一旦变成拼出来的句子，就既不能测也不能翻译。
  for (const value of Object.values(R)) assert.match(value, /^[A-Z_]+$/);
  assert.ok(Object.isFrozen(R));

  const inputs = [
    {}, { host: 'x.com' }, { host: 'mail.qq.com' }, { pageLang: null },
    { explicit: true }, { settings: { autoTranslate: false } },
    { userRules: { 'example.com': 'never' } }, { userRules: { 'example.com': 'always' } },
    { pageLang: 'zh', targetLang: 'zh-CN' },
    { pageLang: 'de', settings: { autoTranslate: true, autoTranslateLangs: ['en'] } },
  ];
  const seen = new Set();
  for (const input of inputs) {
    const d = verdict(input);
    assert.ok(['auto', 'ask', 'off'].includes(d.verdict));
    assert.ok(Object.values(R).includes(d.reason), `${d.reason} is not in REASONS`);
    seen.add(d.reason);
  }
  // 上面那张输入表要覆盖到每一条理由：少一条就是某一级阶梯没人测。
  assert.deepEqual([...Object.values(R)].filter((r) => !seen.has(r)), []);
});

test('decide survives being asked nothing at all', () => {
  // 内容脚本在一个还没解析出语言、也还没读到设置的页面上就会这样调它。
  for (const input of [undefined, {}, { settings: null, userRules: null }]) {
    const d = SiteRules.decide(input);
    assert.equal(d.verdict, 'off');
    assert.equal(d.reason, R.GLOBAL_OFF);
  }
});
