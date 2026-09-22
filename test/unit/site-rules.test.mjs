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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
const { SiteRules, SiteRulesBuiltin, LangTags } = globalThis;
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

test('总开关关着也答得出「这一页拉黑了」—— decide() 的那个答案会被遮住', () => {
  // 阶梯第一档就回 GLOBAL_OFF，黑名单被它整个遮住。界面上要据此把站点开关灰掉
  // 的地方，问的必须是 isBlocklisted() 这一问：总开关关着恰恰是那个开关最该灰
  // 着的时候 —— 点下去写的是一条永远生效不了的 always，还顺手把总开关替所有别
  // 的站点打开了。
  const off = { autoTranslate: false, autoTranslateLangs: [] };
  assert.equal(verdict({ host: 'secure.chase.com', settings: off }).reason, R.GLOBAL_OFF);
  assert.equal(SiteRules.isBlocklisted('secure.chase.com', '/'), true);

  // 而它和阶梯给的答案必须是同一个 —— 两处各判一遍，迟早不一致。黑名单表和内
  // 置表里的 never 都算，对外只有一个说法。
  const probes = [
    ['secure.chase.com', '/'], ['mail.google.com', '/'], ['hmrc.gov.uk', '/'],
    ['x.com', '/home'], ['news.google.com', '/'], ['example.com', '/article/1'],
    ['govtech.com', '/'],
  ];
  for (const [host, path] of probes) {
    assert.equal(
      SiteRules.isBlocklisted(host, path),
      verdict({ host, path }).reason === R.BLOCKLIST,
      `${host}${path}`,
    );
  }
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
  // 同语言：翻了等于没翻。比的是整码——zh-TW 配 zh-CN 是两套字，不算同语言。
  assert.equal(verdict({ pageLang: 'zh-Hans', targetLang: 'zh-CN' }).reason, R.SAME_LANGUAGE);
  assert.notEqual(verdict({ pageLang: 'zh-TW', targetLang: 'zh-CN' }).reason, R.SAME_LANGUAGE);
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

test('「这一页已经是你的语言了」问的是那个共用的判定，而且比整码', () => {
  // 判定只有一份（shared/lang-tags.js），行为断言在 lang-tags.test.mjs。这里守
  // 的是**这一档确实在用它**：曾经这里比基码而字幕那边比整码，于是一页 zh-TW 的
  // 正文配 zh-CN 的目标，字幕翻、正文不翻——同一个问题两条路两个答案。
  for (const [a, b] of [
    ['zh-CN', 'zh-Hans'], ['en-GB', 'en'], ['EN', 'en-US'],
    ['pt-BR', 'pt-PT'], ['ja', 'ja-JP'],
  ]) {
    assert.ok(LangTags.isSameLanguage(a, b), `test data wrong for ${a}/${b}`);
    assert.equal(verdict({ pageLang: a, targetLang: b }).reason, R.SAME_LANGUAGE,
      `site-rules reads ${a}/${b} as different languages, lang-tags does not`);
  }

  // 简繁互换是用户要的那一件事，这一档不许把它挡掉。
  for (const [a, b] of [['zh-TW', 'zh-CN'], ['zh-Hant', 'zh-Hans'], ['zh-HK', 'zh-CN']]) {
    const out = verdict({ pageLang: a, targetLang: b });
    assert.notEqual(out.reason, R.SAME_LANGUAGE, `${a} -> ${b} 被当成了同一门语言`);
  }

  // 基码不同当然更不是同语言。
  assert.equal(verdict({ pageLang: 'en', targetLang: 'zh-CN' }).verdict, 'ask');
});

test('可翻语言名单反过来按基码，勾的是「中文」不是「简体中文」', () => {
  // autoTranslateLangs 是设置页上那张勾选表，值是基码。拿整码比，一个勾了 zh 的
  // 用户会被这一档挡在所有 zh-CN 的页面外面。
  const listed = (pageLang) => SiteRules.decide(ask({
    pageLang, targetLang: 'en',
    settings: { autoTranslate: true, autoTranslateLangs: ['zh', 'ja'] },
  }));
  assert.equal(listed('zh-CN').reason, R.DEFAULT_ASK);
  assert.equal(listed('zh-TW').reason, R.DEFAULT_ASK);
  assert.equal(listed('ja-JP').reason, R.DEFAULT_ASK);
  assert.equal(listed('de').reason, R.LANG_NOT_LISTED);
});

// ------------------------------------------------------------ 主机名

test('normalizeHost keys a rule on the exact host — a shared suffix is not one site', () => {
  const n = SiteRules.normalizeHost;
  assert.equal(n('mobile.x.com'), 'mobile.x.com');
  assert.equal(n('www.reddit.com'), 'reddit.com');   // 只脱 www.
  assert.equal(n('old.reddit.com'), 'old.reddit.com');
  assert.equal(n('X.COM.'), 'x.com');                // 大小写和根点
  assert.equal(n('a.b.c.example.com'), 'a.b.c.example.com');

  // 多租户后缀：alice 和 bob 是两个互不相干的人，不能共用一条规则。浏览器里
  // 没有公共后缀表，剥「注册域」的启发式必然把他们剥成同一个键。
  assert.equal(n('alice.github.io'), 'alice.github.io');
  assert.notEqual(n('alice.github.io'), n('bob.github.io'));
  assert.notEqual(n('a.vercel.app'), n('b.vercel.app'));
  assert.notEqual(n('a.pages.dev'), n('b.pages.dev'));

  // 两段公共后缀也一样，不再猜。
  assert.equal(n('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(n('shop.example.com.cn'), 'shop.example.com.cn');

  assert.equal(n('10.0.0.7'), '10.0.0.7');
  assert.equal(n('localhost'), 'localhost');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
});

test('one tenant choice does not decide for the tenant next door', () => {
  // alice 上点了「总是翻译」，存在 alice.github.io 下。bob 的站点不受影响——
  // 少剥一层只是范围小，多剥一层是替用户做了他没做的决定。
  const rules = { 'alice.github.io': 'always' };
  assert.equal(verdict({ host: 'alice.github.io', userRules: rules }).reason, R.USER_ALWAYS);
  assert.equal(verdict({ host: 'bob.github.io', userRules: rules }).verdict, 'ask');
  assert.equal(verdict({ host: 'github.io', userRules: rules }).verdict, 'ask');
  // 「不要翻译」同理：blogspot 上拉黑一个博客不该拉黑所有博客。
  const never = { 'a.blogspot.com': 'never' };
  assert.equal(verdict({ host: 'a.blogspot.com', userRules: never }).reason, R.USER_NEVER);
  assert.equal(verdict({ host: 'b.blogspot.com', userRules: never }).verdict, 'ask');
});

test('a user rule is looked up along the parent chain, so normalizeHost is a convenience', () => {
  // 归一化只决定“点总是翻译时存在哪个键下”，而它现在存的就是这台主机本身。
  // 想覆盖整个站点靠的是查找这一头：沿父域一路往上，所以在 example.co.uk 上表
  // 的态照样命中 shop.example.co.uk。
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
  assert.equal(m('arxiv.org', '/html/2310.03714v1').match, 'arxiv.org/html/*');
  assert.equal(m('arxiv.org', '/list/cs.CL/recent').match, 'arxiv.org/list/*');
  // 带路径的规则不能整站生效：首页、PDF 页和这三条的结构都不一样，
  // 而 /abs/* 那条的 `blockquote.abstract` 只在摘要页存在。
  assert.equal(m('arxiv.org', '/'), null);
  assert.equal(m('arxiv.org', '/pdf/2401.00001'), null);

  assert.equal(m('mobile.x.com', '/home').match, 'x.com');
  assert.equal(m('old.reddit.com', '/r/rust/').match, 'reddit.com');
  assert.equal(m('example.com', '/'), null);
});

// ar5iv 是 arXiv 那套 LaTeXML 全文的另一个门牌：域名 ar5iv.labs.arxiv.org 以
// arxiv.org 结尾，路径同样是 /html/<id>。后缀匹配让一条规则管住两个站点，所以
// 表里**不该**再有一条 ar5iv 的规则——两条一模一样的东西迟早只改一边。
test('ar5iv 走的是 arxiv.org/html/* 那一条，不另写一条', () => {
  const m = SiteRules.matchBuiltin;
  assert.equal(m('ar5iv.labs.arxiv.org', '/html/1706.03762').match, 'arxiv.org/html/*');
  assert.equal(m('ar5iv.org', '/html/1706.03762'), null);

  const table = SiteRules.loadTable(globalThis.SiteRulesBuiltin);
  assert.equal(table.rules.filter((rule) => rule.match.includes('ar5iv')).length, 0);
});

// 论文这一族的规则都是 always，而「自动翻译」这件事只在 verdict 是 auto 时发生
// —— matchBuiltin 命中了但 state 不是 always，结论会一路掉到语言那几档去。
test('论文页的规则都真的自动翻，不是只命中', () => {
  const at = (host, path) => SiteRules.decide({
    host, path, pageLang: 'en', targetLang: 'zh-CN',
    settings: { autoTranslate: true }, userRules: {},
  });
  for (const [host, path] of [
    ['arxiv.org', '/abs/2401.00001'],
    ['arxiv.org', '/html/2310.03714v1'],
    ['ar5iv.labs.arxiv.org', '/html/1706.03762'],
    ['arxiv.org', '/list/cs.CL/recent'],
    ['huggingface.co', '/papers'],
    ['huggingface.co', '/papers/2609.05571'],
    ['www.biorxiv.org', '/content/10.1101/2020.03.03.975250v1'],
    ['www.nature.com', '/articles/s41586-024-07421-0'],
    ['www.science.org', '/doi/10.1126/science.adi2336'],
    ['scholar.google.com', '/scholar'],
  ]) {
    const out = at(host, path);
    assert.equal(out.verdict, 'auto', `${host}${path} 应当自动翻`);
    assert.equal(out.reason, SiteRules.REASONS.BUILTIN_ALWAYS);
  }

  // Hugging Face 只有 /papers 那一段：模型页、数据集页、讨论区不在内置名单上。
  assert.equal(at('huggingface.co', '/').verdict, 'ask');
  assert.equal(at('huggingface.co', '/models').verdict, 'ask');

  // 而且是**整段**的 /papers，不是以 papers 开头的任何一段。pathMatches 把 `*`
  // 展开成 `.*`，所以写 `/papers*` 会把别人的组织主页也收进来——内置规则是
  // always，认错就是在一个从没问过用户的页面上自己动手。
  assert.equal(at('huggingface.co', '/paperswithcode').verdict, 'ask');
  assert.equal(at('huggingface.co', '/papers-reading-group').verdict, 'ask');
  assert.equal(at('huggingface.co', '/papers/date/2026-09-21').verdict, 'auto');

  // Google 学术同样是路径写死的一段：同域下的作者主页不是「扫一眼今天有什么」
  // 的场景，没被收进来。
  assert.equal(at('scholar.google.com', '/citations?user=x').verdict, 'ask');
  // 后缀匹配不向上生效：各国镜像不以 scholar.google.com 结尾，命不中，走通用
  // 启发式——这不是坏结果，只是没有站点级的 selector。
  assert.equal(at('scholar.google.co.jp', '/scholar').verdict, 'ask');
  // 期刊站也一样只认文章路径，首页和栏目页不在内置名单上。
  assert.equal(at('www.nature.com', '/').verdict, 'ask');
  assert.equal(at('www.science.org', '/journals').verdict, 'ask');
});

// 一条内置规则的 selector 写错了不会报错：它只是一条谁也匹配不上的字符串，页面
// 照翻，作者名和参考文献一起翻进去。所以这几条的名单是「查过页面真实 DOM 之后
// 写下来的」还是「凭印象写的」，必须留下痕迹——science.org 挡在 Cloudflare 的 JS
// 挑战后面，拿不到真实结构，那一条的空名单是「没验过」，不是「验过之后没有」。
test('空的 excludeSelectors 各有各的理由，且都写在规则旁边', () => {
  const source = readFileSync(fileURLToPath(new URL('../../shared/site-rules-builtin.js', import.meta.url)), 'utf8');
  for (const [match, needle] of [
    ['huggingface.co/papers', '查过之后的结论'],
    ['science.org/doi/*', '没验过'],
  ]) {
    const rule = SiteRulesBuiltin.rules.find((r) => r.match === match);
    assert.ok(rule, `内置表里没有 ${match}`);
    assert.deepEqual(rule.excludeSelectors, [], `${match} 现在有 selector 了，注释该跟着改`);
    const at = source.indexOf(`match: '${match}'`);
    const comment = source.slice(Math.max(0, at - 1200), at);
    assert.ok(comment.includes(needle), `${match} 的空名单没说清是「查过」还是「没查」`);
  }
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

// ---------------------------------------------------------------- 写入

// 写入在调用时才去看 globalThis.chrome，所以这里塞一个假的就够了。
//
// runtime.sendMessage 也要有：页面里的 writeUserRule 只是把这件事发给服务工作者
// （见 background.js 的 SITE_RULES_WRITE），真正动存储的是那边的 applyWrite。
// 这里把那一跳接回来，测到的就是整条路，而不是半条。
function fakeChrome(initial = {}) {
  const store = Object.assign({}, initial);
  const delay = typeof initial.__setDelay === 'number' ? initial.__setDelay : 0;
  delete store.__setDelay;
  return {
    store,
    chrome: {
      runtime: {
        sendMessage: async (message) => ({ value: await SiteRules.applyWrite(message) })
      },
      storage: {
        sync: {
          get: async (defaults) => {
            const out = {};
            for (const key of Object.keys(defaults)) {
              out[key] = key in store ? store[key] : defaults[key];
            }
            return out;
          },
          set: async (patch) => {
            // 慢一点的 set 才照得出「两个标签页同时写」：读和写之间有真实的空档。
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            Object.assign(store, patch);
          }
        }
      }
    }
  };
}

test('writeUserRule 写的是 normalizeHost 认的那个键', async () => {
  // 追问条拿到的是 location.hostname（`www.example.com`），decide() 查的是归一化
  // 之后的 `example.com`。两边各自剥一次，迟早剥得不一样 —— 那时候规则写进去了，
  // 却永远查不出来。
  const fake = fakeChrome();
  globalThis.chrome = fake.chrome;
  try {
    const key = await SiteRules.writeUserRule('www.example.com', 'always');
    assert.equal(key, SiteRules.normalizeHost('www.example.com'));
    assert.deepEqual(fake.store.siteRules, { [key]: 'always' });
    // 写进去的立刻要能被判定读出来。
    assert.equal(SiteRules.decide(ask({ userRules: fake.store.siteRules })).reason, R.USER_ALWAYS);
  } finally {
    delete globalThis.chrome;
  }
});

test('关掉一个站点写的是 never，不是把它的规则删掉', async () => {
  // x.com 在内置名单里就是 always。删掉用户规则等于让判定落回内置那一条，
  // 于是「关掉」的下一次访问又自动翻了。
  const fake = fakeChrome({ siteRules: { 'x.com': 'always' } });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.writeUserRule('x.com', 'never');
    assert.deepEqual(fake.store.siteRules, { 'x.com': 'never' });
    assert.equal(SiteRules.decide(ask({ host: 'x.com', userRules: fake.store.siteRules })).reason, R.USER_NEVER);
  } finally {
    delete globalThis.chrome;
  }
});

test('writeUserRule 只认 always / never，且不动别的站点', async () => {
  const fake = fakeChrome({ siteRules: { 'other.com': 'never' } });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.writeUserRule('example.com', 'sometimes');
    assert.deepEqual(fake.store.siteRules, { 'other.com': 'never' }, '不认的状态不该落盘');
    await SiteRules.writeUserRule('example.com', 'always');
    assert.deepEqual(fake.store.siteRules, { 'other.com': 'never', 'example.com': 'always' });
  } finally {
    delete globalThis.chrome;
  }
});

test('两个页面同时写，谁的选择都不会被对方盖掉', async () => {
  // 两边都是「整份读出来、改一个键、整份写回」。不排队的话，两个内容脚本同时
  // 读到同一份旧对象，后写的那份把先写的整条抹掉 —— 用户在另一个标签页上点的
  // 「关」凭空消失，而且哪里都不报错。
  const fake = fakeChrome({ __setDelay: 5 });
  globalThis.chrome = fake.chrome;
  try {
    await Promise.all([
      SiteRules.writeUserRule('a.test', 'always'),
      SiteRules.writeUserRule('b.test', 'never'),
      SiteRules.updateAskCount('c.test', 'bump'),
      SiteRules.updateAskCount('c.test', 'bump')
    ]);
    assert.deepEqual(fake.store.siteRules, { 'a.test': 'always', 'b.test': 'never' });
    // 同一个域名被问了两次就是两次 —— 各读各的会停在 1，三次的额度永远攒不满。
    assert.deepEqual(fake.store.siteAskCount, { 'c.test': 2 });
  } finally {
    delete globalThis.chrome;
  }
});

test('表态之后计数清零，清的是这一条不是整张表', async () => {
  const fake = fakeChrome({ siteAskCount: { 'a.test': 2, 'b.test': 1 } });
  globalThis.chrome = fake.chrome;
  try {
    assert.equal(await SiteRules.updateAskCount('a.test', 'clear'), 0);
    assert.deepEqual(fake.store.siteAskCount, { 'b.test': 1 });
  } finally {
    delete globalThis.chrome;
  }
});

// 和 shared/site-rules.js 里的 MAX_ITEM_BYTES 一致。
const MAX_ASK_BYTES = 6 * 1024;
const askBytes = (counts) => new TextEncoder().encode(JSON.stringify(counts)).length;

// 撑到刚好超过预算为止。按条数算不出这个数：一条占多少字节取决于域名有多长，
// 这正是上限要按字节而不是按条数的理由。
function overflowingCounts(seed) {
  const counts = Object.assign({}, seed);
  for (let i = 0; askBytes(counts) <= MAX_ASK_BYTES; i++) {
    counts[`host-${String(i).padStart(4, '0')}.example.test`] = 9;
  }
  return counts;
}

test('追问计数不会一路长到把同步配额撑爆', async () => {
  // 这张表只为「同一个站点最多问几次」而存在，却按域名无限长。同步存储每项
  // 8KB，撑满那天 set() 直接失败、调用方只打一行日志 —— 从此所有站点都记不上
  // 数，追问上限静悄悄地不再生效。
  const fake = fakeChrome({ siteAskCount: overflowingCounts({ 'seldom.test': 1 }) });
  globalThis.chrome = fake.chrome;
  try {
    assert.equal(await SiteRules.updateAskCount('fresh.test', 'bump'), 1);
    const kept = fake.store.siteAskCount;
    assert.ok(askBytes(kept) <= MAX_ASK_BYTES, `写回去的这张表是 ${askBytes(kept)} 字节`);
    assert.equal(kept['fresh.test'], 1, '刚记下的这一条必须留着');
    assert.equal(kept['seldom.test'], undefined, '先扔问得最少的：重新问一次的代价最小');
  } finally {
    delete globalThis.chrome;
  }
});

test('域名越长，装得下的站点越少 —— 上限量的是字节', async () => {
  // 按条数封顶的版本在这里会放行：两百条以内，可每条都是一个 200 字符的域名，
  // 序列化出来远远超过 8KB，set() 照样会被拒。
  const long = (i) => `${'sub.'.repeat(40)}h${i}.example.test`;
  const counts = {};
  for (let i = 0; i < 60; i++) counts[long(i)] = 5;
  assert.ok(Object.keys(counts).length < 200, '条数还远没到两百');
  assert.ok(askBytes(counts) > MAX_ASK_BYTES, '字节数却早就超了');

  const fake = fakeChrome({ siteAskCount: counts });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.updateAskCount('fresh.test', 'bump');
    assert.ok(askBytes(fake.store.siteAskCount) <= MAX_ASK_BYTES);
    assert.equal(fake.store.siteAskCount['fresh.test'], 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('挤位置的时候，不挤掉刚刚动过的那一条', async () => {
  // 正在追问的就是计数最小的那个站点：要是「扔最小的」连它一起扔了，这一条
  // 计数永远停在 1，用户会被同一个站点问到天荒地老。
  const fake = fakeChrome({
    siteAskCount: overflowingCounts({ 'now.test': 1, 'idle.test': 1 })
  });
  globalThis.chrome = fake.chrome;
  try {
    assert.equal(await SiteRules.updateAskCount('now.test', 'bump'), 2);
    const kept = fake.store.siteAskCount;
    assert.ok(askBytes(kept) <= MAX_ASK_BYTES);
    assert.equal(kept['now.test'], 2);
    assert.equal(kept['idle.test'], undefined);
  } finally {
    delete globalThis.chrome;
  }
});

// ------------------------------------------------ 站点规则表也有同一道预算

const ruleBytes = (rules) => new TextEncoder().encode(JSON.stringify(rules)).length;

// 撑到刚好超过预算为止。`under` 决定灌进去的是哪一种：给了父域就灌它的子域
// （每一条都被父域盖着，压缩挑得出来），不给就灌互不相干的域名（谁也盖不住
// 谁，压缩一条都动不了）。
function overflowingRules(seed, under = '') {
  const rules = Object.assign({}, seed);
  for (let i = 0; ruleBytes(rules) <= MAX_ASK_BYTES; i++) {
    rules[under ? `sub-${i}.${under}` : `filler-${i}.example-${i}.test`] = 'always';
  }
  return rules;
}

test('规则表挤爆了，先收掉「收了也查不出差别」的那些', async () => {
  // 用户先在 x.com 上点了「总是翻译」，后来在 mobile.x.com 上又点了一次同样
  // 的。lookupUserRule 本来就会沿父域往上找，所以子域那条删了也没人看得出来
  // —— 同步存储每项 8KB，这种条目正是该先腾出去的。
  const before = overflowingRules({ 'x.com': 'always', 'mobile.x.com': 'always' }, 'x.com');
  const fake = fakeChrome({ siteRules: before });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.writeUserRule('new.test', 'never');
    const kept = fake.store.siteRules;
    assert.ok(ruleBytes(kept) <= MAX_ASK_BYTES, `写回去的这张表是 ${ruleBytes(kept)} 字节`);
    assert.ok(Object.keys(kept).length < Object.keys(before).length, '一条都没收');
    assert.equal(kept['x.com'], 'always', '盖住它们的那条不能跟着走');
    assert.equal(kept['new.test'], 'never', '刚写下的那一条永远留着');

    // 「多余」的定义只有一条：收掉之后，原来每一个键查出来的答案一个字都没变。
    // 谁先被收掉是顺序问题，这个才是规则。
    for (const host of Object.keys(before)) {
      assert.equal(
        SiteRules.lookupUserRule(kept, host),
        SiteRules.lookupUserRule(before, host),
        `${host} 的判定被压缩改掉了`
      );
    }
  } finally {
    delete globalThis.chrome;
  }
});

test('用户自己写的例外，挤成什么样都不收', async () => {
  // ads.x.com=never 是用户在 x.com=always 底下挖的一个洞。它和父域的状态相反，
  // 收掉它等于替他改主意 —— 而这张表里的每一条都是他亲口说过的话。
  // localhost 下面那条同理：lookupUserRule 不会为 wiki.localhost 去问
  // localhost（光秃秃的末标签永远不问），收掉它规则就直接失效了。
  // 两条例外的键名故意比灌进去的那些长：压缩从最长的扫起，它们头一批就被拿起
  // 来试。短的话会一直轮不到，这个测试就什么都没测。
  const EXCEPTION = 'advertising-network.corporate.x.com';
  const SINGLE_LABEL = 'wiki-internal-directory.localhost';
  const fake = fakeChrome({
    siteRules: overflowingRules({
      'x.com': 'always', [EXCEPTION]: 'never',
      'localhost': 'always', [SINGLE_LABEL]: 'always'
    })
  });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.writeUserRule('new.test', 'never');
    const kept = fake.store.siteRules;
    assert.equal(kept[EXCEPTION], 'never', '相反的例外被收掉了');
    assert.equal(kept[SINGLE_LABEL], 'always', '单标签主机没有父域可落');
    assert.equal(SiteRules.lookupUserRule(kept, EXCEPTION), 'never');
    assert.equal(SiteRules.lookupUserRule(kept, SINGLE_LABEL), 'always');
  } finally {
    delete globalThis.chrome;
  }
});

test('没挤爆就一条都不动 —— 压缩不是平时的清理工', async () => {
  // 子域那条今天多余，不等于明天多余：用户哪天把 x.com 改成 never，留着的
  // mobile.x.com=always 还护得住那个子域，平白收掉了就跟着变成 never —— 一次
  // 没人看见的改主意。顶着配额失败去换这个风险值得，平白无故不值得。
  const fake = fakeChrome({ siteRules: { 'x.com': 'always', 'mobile.x.com': 'always' } });
  globalThis.chrome = fake.chrome;
  try {
    await SiteRules.writeUserRule('new.test', 'never');
    assert.deepEqual(fake.store.siteRules, {
      'x.com': 'always', 'mobile.x.com': 'always', 'new.test': 'never'
    });
  } finally {
    delete globalThis.chrome;
  }
});

test('压缩也腾不出地方，就让写入失败传出去', async () => {
  // 配额是硬的，压缩只是泄压阀。真挤不下的时候，调用方必须看得见失败 —— popup
  // 上那个开关是乐观控件，它已经在用户眼里动过了，吞掉失败就是「按钮动了、设置
  // 没存上」，而页面下一次打开照旧。
  const fake = fakeChrome({ siteRules: overflowingRules({}) });
  fake.chrome.storage.sync.set = async () => {
    throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
  };
  globalThis.chrome = fake.chrome;
  try {
    await assert.rejects(SiteRules.writeUserRule('new.test', 'never'), /quota/i);
  } finally {
    delete globalThis.chrome;
  }
});

// --------------------------------------------------------------- refused
// 「这个站点不许我们自己动手」和「这一页不必翻」是两句话。整页翻译只看 verdict，
// 所以从前不必分；字幕那一面（替观众点开播放器的原字幕）要的是前一句，于是
// decide() 把它算成一个字段，分类留在阶梯自己这边。
test('refused 只认站点级的三条拒绝，不认语言结论', () => {
  const refused = (over) => SiteRules.decide(ask(over));

  // 站点级：总开关关着、在禁翻名单里、用户对这个域名写过 never。
  assert.equal(refused({ settings: { autoTranslate: false } }).refused, true);
  assert.equal(refused({ host: 'mail.google.com', path: '/mail/u/0/' }).refused, true);
  assert.equal(refused({ userRules: { 'example.com': 'never' } }).refused, true);

  // 语言结论也答 off，但它量的是**页面**的语言。字幕说的是**声道**的语言，中文
  // 界面的视频站放一场英文演讲，这两条会答「不必翻」，而要翻的是那条英文字幕轨。
  const same = refused({ pageLang: 'zh-CN' });
  assert.equal(same.verdict, 'off');
  assert.equal(same.reason, R.SAME_LANGUAGE);
  assert.equal(same.refused, false);

  const notListed = refused({ settings: { autoTranslate: true, autoTranslateLangs: ['ja'] } });
  assert.equal(notListed.verdict, 'off');
  assert.equal(notListed.reason, R.LANG_NOT_LISTED);
  assert.equal(notListed.refused, false);

  // 中间那一大片 ask，以及所有 auto，都不是拒绝。
  assert.equal(refused({}).refused, false);
  assert.equal(refused({ pageLang: null }).refused, false);
  assert.equal(refused({ userRules: { 'example.com': 'always' } }).refused, false);
});

test('总开关关着但用户已经在这一页表过态，就不算这个站点拒绝了我们', () => {
  // explicit 越过总开关是阶梯本来就有的行为；refused 跟着同一个结论走，不另算。
  const held = SiteRules.decide(ask({ settings: { autoTranslate: false }, explicit: true }));
  assert.equal(held.verdict, 'auto');
  assert.equal(held.refused, false);
});

// 四份装载清单，一份都不能漏：manifest 的 <all_urls> 那一条、service worker 的
// import、设置页和弹窗的 <script>。共用模块是按顺序加载的经典脚本，**谁在谁前面
// 就是依赖关系本身**——漏一处的表现不是报错，是那一处静静地换了一套行为。
const LOAD_LISTS = [
  ['background/background.js', (rel) => new RegExp(`import '\\\\.\\\\./${rel.replace(/[./]/g, '\\$&')}';`)],
  ['options/options.html', (rel) => new RegExp(`<script src="\\\\.\\\\./${rel.replace(/[./]/g, '\\$&')}"></script>`)],
  ['popup/popup.html', (rel) => new RegExp(`<script src="\\\\.\\\\./${rel.replace(/[./]/g, '\\$&')}"></script>`)],
];

// [依赖方, 被依赖方, 漏了会怎样]
const LOAD_ORDER = [
  ['shared/site-rules.js', 'shared/site-rules-builtin.js',
   'table() 拿不到数据源时不抛，它退回一张空表 —— matchBuiltin() 谁也不认，'
   + 'isBlocked() 对每一个域名都答「不在黑名单里」。那份禁翻清单（网银、网页'
   + '邮箱、政务表单）就这么静静地没了，而控制台里只有一行 warn。'],
  ['shared/site-rules.js', 'shared/lang-tags.js',
   'site-rules.js 在加载时就把 getLangBase 取走了。'],
  ['shared/caption-core.js', 'shared/lang-tags.js',
   'caption-core.js 在加载时就把 getLangBase 取走了。'],
];

test('四份装载清单：共用模块和它依赖的那一份，顺序不能倒', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = (rel) => readFileSync(root + rel, 'utf8');

  const manifest = JSON.parse(read('manifest.json'));
  for (const [dependent, dependency, why] of LOAD_ORDER) {
    for (const cs of manifest.content_scripts) {
      const order = (cs.js || []);
      const at = order.indexOf(dependent);
      if (at < 0) continue;
      const dep = order.indexOf(dependency);
      assert.ok(dep >= 0, `${cs.matches} 装了 ${dependent} 却没装 ${dependency}：${why}`);
      assert.ok(dep < at, `${cs.matches} 里 ${dependency} 必须排在 ${dependent} 之前`);
    }

    for (const [file, pattern] of LOAD_LISTS) {
      const text = read(file);
      const at = text.search(pattern(dependent));
      if (at < 0) continue;
      const dep = text.search(pattern(dependency));
      assert.ok(dep >= 0, `${file} 装了 ${dependent} 却没装 ${dependency}：${why}`);
      assert.ok(dep < at, `${file} 里 ${dependency} 要排在 ${dependent} 之前`);
    }
  }
});
