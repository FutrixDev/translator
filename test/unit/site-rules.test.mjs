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

await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
const { SiteRules, SiteRulesBuiltin } = globalThis;
const R = SiteRules.REASONS;

// 一页普通的网页，开着自动翻译，什么规则都没命中——阶梯的中性起点。
const input = (over = {}) => Object.assign({
  host: 'example.com',
  path: '/article/1',
  userRules: {},
  settings: { autoTranslate: true },
  explicit: false,
}, over);

const verdict = (over) => SiteRules.decide(input(over));

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
  // 的地方，问的必须是 blockReason() 这一问：总开关关着恰恰是那个开关最该灰
  // 着的时候 —— 点下去写的是一条永远生效不了的 always，还顺手把总开关替所有别
  // 的站点打开了。
  const off = { autoTranslate: false };
  assert.equal(verdict({ host: 'secure.chase.com', settings: off }).reason, R.GLOBAL_OFF);
  assert.equal(SiteRules.blockReason('secure.chase.com', '/'), R.BLOCKLIST);
  assert.equal(verdict({ host: 'x.com', path: '/messages/abc', settings: off }).reason, R.GLOBAL_OFF);
  assert.equal(SiteRules.blockReason('x.com', '/messages/abc'), R.BUILTIN_NEVER);

  // 而它和阶梯给的答案必须是同一个 —— 两处各判一遍，迟早不一致。黑名单表和内
  // 置表里的 never 都算，但各是各的枚举：popup 站点行按这个枚举取话，内置 never
  // 不能被说成「在黑名单里」（R33 D-360 F3）。
  const probes = [
    ['secure.chase.com', '/'], ['mail.google.com', '/'], ['hmrc.gov.uk', '/'],
    ['x.com', '/home'], ['x.com', '/messages/abc'], ['x.com', '/i/chat/123'],
    ['arxiv.org', '/pdf/2501.00001'], ['arxiv.org', '/abs/2501.00001'],
    ['news.google.com', '/'], ['example.com', '/article/1'], ['govtech.com', '/'],
  ];
  const refusedBySite = [R.BLOCKLIST, R.BUILTIN_NEVER];
  const seen = new Set();
  for (const [host, path] of probes) {
    const { reason } = verdict({ host, path });
    const expected = refusedBySite.includes(reason) ? reason : null;
    assert.equal(SiteRules.blockReason(host, path), expected, `${host}${path}`);
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort(), [R.BLOCKLIST, R.BUILTIN_NEVER, null].sort(),
    'the probes must exercise both refusals and a site that is neither');
});

test('the blocklist matches subdomains, and does not match a longer public suffix', () => {
  assert.equal(verdict({ host: 'www.irs.gov' }).reason, R.BLOCKLIST);
  assert.equal(verdict({ host: 'secure.chase.com' }).reason, R.BLOCKLIST);
  // 'gov' 不以 '.gov' 结尾地命中 gov.uk —— 所以表里必须另有一行，而它有。
  assert.equal(verdict({ host: 'hmrc.gov.uk' }).reason, R.BLOCKLIST);
  // 后缀匹配不能退化成子串匹配：这两个域名都含 'gov'，都不该被拦。
  assert.equal(verdict({ host: 'govtech.com' }).verdict, 'off');
  assert.equal(verdict({ host: 'mygov.example.com' }).verdict, 'off');
});

test('an explicit page keeps going even with the global switch off', () => {
  // 用户自己点过翻译，页面后来长出来的内容跟上，是在兑现那次点击。
  // 这一条要是答 off，调度层就只能绕过 decide() 自己判一遍。
  const d = verdict({ explicit: true, settings: { autoTranslate: false } });
  assert.equal(d.verdict, 'auto');
  assert.equal(d.reason, R.USER_EXPLICIT);

  // 但它越不过“这里不许动”的三条。
  assert.equal(verdict({ explicit: true, host: 'docs.google.com' }).reason, R.BLOCKLIST);
  assert.equal(verdict({ explicit: true, userRules: { 'example.com': 'never' } }).reason, R.USER_NEVER);
});

test('the global switch stops everything else', () => {
  const off = { autoTranslate: false };
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

test('an unlisted site is a quiet off: never auto, never a question, never a refusal', () => {
  // D-351：名单外的站点不问也不翻。黑名单永远列不全，真正兜底的是这一条。
  for (const host of ['some-bank-nobody-listed.com', 'intranet.corp', '10.0.0.7', 'localhost', 'example.com']) {
    const d = verdict({ host });
    assert.equal(d.verdict, 'off', `${host} translated itself`);
    assert.equal(d.reason, R.DEFAULT_OFF, `${host} was answered by another rung`);
    // 它不是拒绝：字幕闸门、弹窗的站点开关都照常可用。
    assert.equal(d.refused, false, `${host} reads as refused`);
  }
  // 阶梯里再没有「问一句」这个答案。
  assert.equal(Object.values(R).some((r) => /ASK|LANG/.test(r)), false);
});

// ------------------------------------------------------------ 内置表的 R33 扩充

test('YouTube is a captions site: the page stays untranslated, and nothing refuses', () => {
  // D-351：视频站的正文不自己翻 —— 标题、评论、推荐栏翻出来是噪音 —— 但字幕照翻。
  // 字幕闸门问的是 refused，所以 captions 必须是一个不算拒绝的 off。
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com']) {
    const d = verdict({ host, path: '/watch' });
    assert.equal(d.verdict, 'off', `${host} translates its page`);
    assert.equal(d.reason, R.BUILTIN_CAPTIONS, `${host} was answered by another rung`);
    assert.equal(d.refused, false, `${host} reads as refused, so captions would stop too`);
  }
});

test('a user rule outranks captions, both ways', () => {
  // 用户说总是翻：整页也翻。用户说永不：那就是一个真正的拒绝，字幕也停。
  const always = verdict({ host: 'www.youtube.com', userRules: { 'youtube.com': 'always' } });
  assert.equal(always.verdict, 'auto');
  assert.equal(always.reason, R.USER_ALWAYS);
  const never = verdict({ host: 'www.youtube.com', userRules: { 'youtube.com': 'never' } });
  assert.equal(never.reason, R.USER_NEVER);
  assert.equal(never.refused, true);
});

test('captions is a built-in state only: a user rule cannot be written as captions', () => {
  // 用户的选择只有 always / never 两个；存储里冒出一条 captions 是坏数据，丢掉，
  // 不让它变成第三种用户状态。
  const d = verdict({ host: 'example.com', userRules: { 'example.com': 'captions' } });
  assert.equal(d.reason, R.DEFAULT_OFF);
});

test('the R33 social, forum and news sites translate by themselves', () => {
  const hosts = [
    'www.threads.net', 'bsky.app', 'www.facebook.com', 'www.instagram.com',
    'medium.com', 'someone.medium.com', 'someone.substack.com', 'www.quora.com',
    'stackoverflow.com', 'unix.stackexchange.com',
    'www.nytimes.com', 'www.theguardian.com', 'www.bbc.com', 'www.bbc.co.uk',
    'www.reuters.com', 'apnews.com', 'www.washingtonpost.com', 'www.wsj.com',
    'www.bloomberg.com', 'edition.cnn.com', 'www.ft.com', 'www.economist.com',
  ];
  for (const host of hosts) {
    const d = verdict({ host });
    assert.equal(d.verdict, 'auto', `${host} did not translate by itself`);
    assert.equal(d.reason, R.BUILTIN_ALWAYS, `${host} was answered by another rung`);
  }
});

test('direct messages are never translated by themselves, the rest of the site still is (R33 Q1)', () => {
  // 整站 always 的社交站，私信那几条路径是内置 never：零点击就把私信发给 AI。
  const dm = verdict({ host: 'x.com', path: '/messages/abc' });
  assert.equal(dm.verdict, 'off');
  assert.equal(dm.reason, R.BUILTIN_NEVER);
  assert.equal(dm.refused, true);
  const profile = verdict({ host: 'x.com', path: '/NASA' });
  assert.equal(profile.verdict, 'auto');
  assert.equal(profile.reason, R.BUILTIN_ALWAYS);

  const neverPaths = [
    ['x.com', '/messages'], ['x.com', '/messages/abc-def'], ['mobile.x.com', '/messages/1'],
    ['x.com', '/i/chat'], ['x.com', '/i/chat/123'],
    ['twitter.com', '/messages'], ['twitter.com', '/i/chat/1'],
    ['www.facebook.com', '/messages'], ['www.facebook.com', '/messages/t/1'],
    ['www.instagram.com', '/direct'], ['www.instagram.com', '/direct/inbox/'],
    ['www.reddit.com', '/chat'], ['www.reddit.com', '/chat/room/1'],
    ['chat.reddit.com', '/'], ['chat.reddit.com', '/room/1'],
    ['bsky.app', '/messages'], ['bsky.app', '/messages/1'],
  ];
  for (const [host, path] of neverPaths) {
    assert.equal(verdict({ host, path }).reason, R.BUILTIN_NEVER, `${host}${path} is not a built-in never`);
  }
  // 根路径与 `/*` 各一个门牌，所以段边界守得住：一个叫 messagesboard 的用户主页不是私信。
  const alwaysPaths = [
    ['x.com', '/messagesboard'], ['x.com', '/i/chatter'], ['x.com', '/home'],
    ['www.facebook.com', '/messenger_fan_page'], ['www.instagram.com', '/directors'],
    ['www.reddit.com', '/r/chat'], ['www.reddit.com', '/chatgpt'], ['bsky.app', '/profile/alice'],
  ];
  for (const [host, path] of alwaysPaths) {
    assert.equal(verdict({ host, path }).reason, R.BUILTIN_ALWAYS, `${host}${path} lost its site-wide always`);
  }
});

test('a user site-wide always cannot open a direct-message path (R33 Q1)', () => {
  // never 排在用户规则前面：他在 x.com 上写的「总是翻译」说的是时间线，不是私信。
  const d = verdict({ host: 'x.com', path: '/messages/abc', userRules: { 'x.com': 'always' } });
  assert.equal(d.verdict, 'off');
  assert.equal(d.reason, R.BUILTIN_NEVER);
  const reddit = verdict({ host: 'chat.reddit.com', path: '/', userRules: { 'reddit.com': 'always' } });
  assert.equal(reddit.reason, R.BUILTIN_NEVER);
  // 整站那一行照样写得进去；私信那一页写不进去（popup 那一行灰掉，写了也不算数）。
  assert.equal(SiteRules.siteRuleWritable('x.com', '/home'), true);
  assert.equal(SiteRules.siteRuleWritable('x.com'), true);
  assert.equal(SiteRules.siteRuleWritable('x.com', '/messages/abc'), false);
  assert.equal(SiteRules.siteRuleWritable('chat.reddit.com'), false);
  // 语域照整站的写：手动翻私信时语气还是那个站点的。
  assert.equal(SiteRules.register('x.com', '/messages/abc'), 'social');
  assert.equal(SiteRules.register('chat.reddit.com', '/'), 'forum');
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
  assert.equal(verdict({ host: 'bob.github.io', userRules: rules }).verdict, 'off');
  assert.equal(verdict({ host: 'github.io', userRules: rules }).verdict, 'off');
  // 「不要翻译」同理：blogspot 上拉黑一个博客不该拉黑所有博客。
  const never = { 'a.blogspot.com': 'never' };
  assert.equal(verdict({ host: 'a.blogspot.com', userRules: never }).reason, R.USER_NEVER);
  assert.equal(verdict({ host: 'b.blogspot.com', userRules: never }).verdict, 'off');
});

test('siteLabel prints the key the rule is stored under, and the raw host where there is none', () => {
  // 「不再自动翻译 {site}」上印的名字。和写进去的键不一样的话，按钮说的是
  // www.youtube.com，设置页列表里出现的却是 youtube.com。
  assert.equal(SiteRules.siteLabel('www.youtube.com'), 'youtube.com');
  assert.equal(SiteRules.siteLabel('www.youtube.com'), SiteRules.normalizeHost('www.youtube.com'));
  assert.equal(SiteRules.siteLabel('old.reddit.com'), 'old.reddit.com');
  // file:// 上没有键可存：印个空串也比 undefined 强，但那一行本来就不露。
  assert.equal(SiteRules.siteLabel(''), '');
  assert.equal(SiteRules.siteLabel(undefined), '');
});

test('a user rule is looked up along the parent chain, so normalizeHost is a convenience', () => {
  // 归一化只决定“点总是翻译时存在哪个键下”，而它现在存的就是这台主机本身。
  // 想覆盖整个站点靠的是查找这一头：沿父域一路往上，所以在 example.co.uk 上表
  // 的态照样命中 shop.example.co.uk。
  const rules = { 'example.co.uk': 'always' };
  assert.equal(verdict({ host: 'shop.example.co.uk', userRules: rules }).reason, R.USER_ALWAYS);
  assert.equal(verdict({ host: 'example.co.uk', userRules: rules }).reason, R.USER_ALWAYS);

  // 父域不会因为子域的规则被圈进去。
  assert.equal(verdict({ host: 'example.com', userRules: { 'a.example.com': 'never' } }).verdict, 'off');
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
  assert.equal(verdict({ host: '10.0.0.7', userRules: { '0.0.7': 'always' } }).verdict, 'off');
});

test('a bare TLD is never asked — that rule would cover half the web', () => {
  assert.equal(verdict({ host: 'example.com', userRules: { com: 'always' } }).verdict, 'off');
  assert.equal(verdict({ host: 'shop.example.co.uk', userRules: { uk: 'never' } }).verdict, 'off');
});

// ------------------------------------------------------------ 内置规则

test('a built-in rule matches its subdomains and its path glob', () => {
  const m = SiteRules.matchBuiltin;
  assert.equal(m('arxiv.org', '/abs/2401.00001').match, 'arxiv.org/abs/*');
  assert.equal(m('arxiv.org', '/html/2310.03714v1').match, 'arxiv.org/html/*');
  assert.equal(m('arxiv.org', '/list/cs.CL/recent').match, 'arxiv.org/list/*');
  // 带路径的规则不能整站生效：首页和这三条的结构都不一样，
  // 而 /abs/* 那条的 `blockquote.abstract` 只在摘要页存在。
  assert.equal(m('arxiv.org', '/'), null);
  // PDF 页有自己的一条，而且是这张表里唯一一条 never：那一页不走整页翻译这条路，
  // 走的是按页扣额度的服务端任务（见 test/unit/pdf-offer.test.mjs）。
  assert.equal(m('arxiv.org', '/pdf/2401.00001').match, 'arxiv.org/pdf/*');
  assert.equal(m('arxiv.org', '/pdf/2401.00001').state, 'never');

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
  const patterns = table.rules.flatMap((rule) => [].concat(rule.match));
  assert.equal(patterns.filter((pattern) => pattern.includes('ar5iv')).length, 0);
});

// 论文这一族的规则都是 always，而「自动翻译」这件事只在 verdict 是 auto 时发生
// —— matchBuiltin 命中了但 state 不是 always，结论会一路掉到 DEFAULT_OFF 去。
test('论文页的规则都真的自动翻，不是只命中', () => {
  const at = (host, path) => SiteRules.decide({
    host, path, settings: { autoTranslate: true }, userRules: {},
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
    ['scholar.google.com.hk', '/scholar'],
    ['scholar.google.co.jp', '/scholar'],
    ['scholar.google.de', '/scholar'],
  ]) {
    const out = at(host, path);
    assert.equal(out.verdict, 'auto', `${host}${path} 应当自动翻`);
    assert.equal(out.reason, SiteRules.REASONS.BUILTIN_ALWAYS);
  }

  // Hugging Face 只有 /papers 那一段：模型页、数据集页、讨论区不在内置名单上。
  assert.equal(at('huggingface.co', '/').verdict, 'off');
  assert.equal(at('huggingface.co', '/models').verdict, 'off');

  // 而且是**整段**的 /papers，不是以 papers 开头的任何一段。pathMatches 把 `*`
  // 展开成 `.*`，所以写 `/papers*` 会把别人的组织主页也收进来——内置规则是
  // always，认错就是在一个从没问过用户的页面上自己动手。
  assert.equal(at('huggingface.co', '/paperswithcode').verdict, 'off');
  assert.equal(at('huggingface.co', '/papers-reading-group').verdict, 'off');
  assert.equal(at('huggingface.co', '/papers/date/2026-09-21').verdict, 'auto');

  // Google 学术同样是路径写死的一段：同域下的作者主页不是「扫一眼今天有什么」
  // 的场景，没被收进来。
  assert.equal(at('scholar.google.com', '/citations?user=x').verdict, 'off');
  assert.equal(at('scholar.google.co.jp', '/citations?user=x').verdict, 'off');
  // 各国门牌是一个一个列出来的，不是 scholar.google.* —— 没有公共后缀表，那个
  // 通配会把别人注册的 scholar.google.<随便什么>.com 一起认成 Google 学术。
  assert.equal(at('scholar.google.evil.com', '/scholar').verdict, 'off');
  assert.equal(at('scholar.google.com.evil.net', '/scholar').verdict, 'off');
  // 期刊站也一样只认文章路径，首页和栏目页不在内置名单上。
  assert.equal(at('www.nature.com', '/').verdict, 'off');
  assert.equal(at('www.science.org', '/journals').verdict, 'off');
});

// 一条内置规则的 selector 写错了不会报错：它只是一条谁也匹配不上的字符串，页面
// 照翻，作者名和参考文献一起翻进去。所以这几条的名单是「查过页面真实 DOM 之后
// 写下来的」还是「凭印象写的」，必须留下痕迹：空名单要说清是查过之后没有，拿不
// 到现场的（science.org 挡在 Cloudflare 的 JS 挑战后面）要说清是对着什么查的。
test('选择器名单查没查过，都写在规则旁边', () => {
  const source = readFileSync(fileURLToPath(new URL('../../shared/site-rules-builtin.js', import.meta.url)), 'utf8');
  const commentAbove = (match) => {
    const at = source.indexOf(`match: '${match}'`);
    assert.ok(at >= 0, `内置表里没有 ${match}`);
    return source.slice(Math.max(0, at - 1200), at);
  };

  const hf = SiteRulesBuiltin.rules.find((r) => r.match === 'huggingface.co/papers');
  assert.deepEqual(hf.keepOriginalSelectors, [], 'huggingface.co/papers 现在有 selector 了，注释该跟着改');
  assert.ok(commentAbove('huggingface.co/papers').includes('查过之后的结论'),
    'huggingface.co/papers 的空名单没说清是「查过」还是「没查」');

  const science = SiteRulesBuiltin.rules.find((r) => r.match === 'science.org/doi/*');
  assert.ok(science.keepOriginalSelectors.length > 0);
  const comment = commentAbove('science.org/doi/*');
  assert.ok(comment.includes('Wayback'), 'science.org 的名单没说是对着哪份 DOM 查的');
  for (const selector of science.keepOriginalSelectors) {
    assert.ok(comment.includes(selector), `${selector} 没在注释里说它摘掉的是什么`);
  }
});

test('the matched rule rides along with every verdict, including the off ones', () => {
  // 适配层要它的 selector，那和“这次翻不翻”是两件事。
  const blocked = SiteRules.decide(input({ host: 'x.com', userRules: { 'x.com': 'never' } }));
  assert.equal(blocked.verdict, 'off');
  assert.equal(blocked.rule.match, 'x.com');
  assert.deepEqual(blocked.rule.atomicBlockSelectors, ['[data-testid="tweetText"]']);
  assert.equal(SiteRules.decide(input({})).rule, null);
});

test('the rule handed out is frozen — the adapter layer gets a copy of nothing', () => {
  // 交出去的是进程里唯一的那一份。适配层往 keepOriginalSelectors 里 push 一条，就是
  // 永久改写了所有 x.com 标签页的行为，而且下次读到时没有任何痕迹。
  const rule = SiteRules.matchBuiltin('x.com', '/home');
  assert.ok(Object.isFrozen(rule));
  assert.ok(Object.isFrozen(rule.keepOriginalSelectors));
  assert.throws(() => rule.keepOriginalSelectors.push('.injected'), TypeError);
  assert.throws(() => { rule.state = 'never'; }, TypeError);
  assert.deepEqual(SiteRules.matchBuiltin('x.com', '/home').keepOriginalSelectors,
    ['[data-testid="User-Name"] a', 'time', '[role="group"]']);
});

test('the shipped table is internally consistent', () => {
  const table = SiteRules.loadTable(SiteRulesBuiltin);
  assert.deepEqual(table.errors, []);
  assert.equal(table.ok, true);
  assert.ok(table.rules.length > 0 && table.blocklist.length > 0);

  // 一条内置 always 的规则同时又在黑名单上，就是表自己跟自己打架：黑名单赢，
  // 那条规则永远不会生效，而写它的人不会知道。反过来，一条 never 必须真的落到
  // BUILTIN_NEVER —— 被黑名单抢先答成 BLOCKLIST，说出来的就是另一句话。
  // 按门牌逐个问：一组 match 里有一个被黑名单盖住，别的门牌照常生效也藏不住它。
  for (const rule of table.rules) {
    for (const pattern of [].concat(rule.match)) {
      const { verdict: v, reason } = SiteRules.decide(input({
        host: pattern.split('/')[0],
        path: pattern.includes('/') ? `/${pattern.split('/').slice(1).join('/').replace('*', 'x')}` : '/',
      }));
      if (rule.state === 'never') {
        assert.equal(v, 'off', `${pattern} is a never rule that does not refuse`);
        assert.equal(reason, R.BUILTIN_NEVER, `${pattern} is shadowed by the blocklist`);
      } else if (rule.state === 'captions') {
        assert.equal(reason, R.BUILTIN_CAPTIONS, `${pattern} is shadowed by the blocklist`);
      } else {
        assert.notEqual(v, 'off', `${pattern} is shadowed by the blocklist`);
      }
    }
  }
});

test('reasons are an enum, and every verdict is one of two words', () => {
  // reason 一旦变成拼出来的句子，就既不能测也不能翻译。
  for (const value of Object.values(R)) assert.match(value, /^[A-Z_]+$/);
  assert.ok(Object.isFrozen(R));

  const inputs = [
    {}, { host: 'x.com' }, { host: 'mail.qq.com' },
    { host: 'arxiv.org', path: '/pdf/2501.00001' },
    { host: 'www.youtube.com' },
    { explicit: true }, { settings: { autoTranslate: false } },
    { userRules: { 'example.com': 'never' } }, { userRules: { 'example.com': 'always' } },
  ];
  const seen = new Set();
  for (const input of inputs) {
    const d = verdict(input);
    assert.ok(['auto', 'off'].includes(d.verdict));
    assert.ok(Object.values(R).includes(d.reason), `${d.reason} is not in REASONS`);
    seen.add(d.reason);
  }
  // 上面那张输入表要覆盖到每一条理由：少一条就是某一级阶梯没人测。
  assert.deepEqual([...Object.values(R)].filter((r) => !seen.has(r)), []);
});

test('decide survives being asked nothing at all', () => {
  // 内容脚本在一个还没读到设置的页面上就会这样调它。
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
  // 弹窗拿到的是 location.hostname（`www.example.com`），decide() 查的是归一化
  // 之后的 `example.com`。两边各自剥一次，迟早剥得不一样 —— 那时候规则写进去了，
  // 却永远查不出来。
  const fake = fakeChrome();
  globalThis.chrome = fake.chrome;
  try {
    const key = await SiteRules.writeUserRule('www.example.com', 'always');
    assert.equal(key, SiteRules.normalizeHost('www.example.com'));
    assert.deepEqual(fake.store.siteRules, { [key]: 'always' });
    // 写进去的立刻要能被判定读出来。
    assert.equal(SiteRules.decide(input({ userRules: fake.store.siteRules })).reason, R.USER_ALWAYS);
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
    assert.equal(SiteRules.decide(input({ host: 'x.com', userRules: fake.store.siteRules })).reason, R.USER_NEVER);
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
      SiteRules.writeUserRule('c.test', 'always'),
    ]);
    assert.deepEqual(fake.store.siteRules, { 'a.test': 'always', 'b.test': 'never', 'c.test': 'always' });
  } finally {
    delete globalThis.chrome;
  }
});

// ------------------------------------------------ 站点规则表的字节预算

// 和 shared/storage-writer.js 里的 ITEM_BUDGET 一致。
const ITEM_BYTES = 6 * 1024;

const ruleBytes = (rules) => new TextEncoder().encode(JSON.stringify(rules)).length;

// 撑到刚好超过预算为止。`under` 决定灌进去的是哪一种：给了父域就灌它的子域
// （每一条都被父域盖着，压缩挑得出来），不给就灌互不相干的域名（谁也盖不住
// 谁，压缩一条都动不了）。
function overflowingRules(seed, under = '') {
  const rules = Object.assign({}, seed);
  for (let i = 0; ruleBytes(rules) <= ITEM_BYTES; i++) {
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
    assert.ok(ruleBytes(kept) <= ITEM_BYTES, `写回去的这张表是 ${ruleBytes(kept)} 字节`);
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
test('refused 只认站点级的拒绝，不认名单外的安静 off', () => {
  const refused = (over) => SiteRules.decide(input(over));

  // 站点级：总开关关着、在禁翻名单里、用户对这个域名写过 never。
  assert.equal(refused({ settings: { autoTranslate: false } }).refused, true);
  assert.equal(refused({ host: 'mail.google.com', path: '/mail/u/0/' }).refused, true);
  assert.equal(refused({ userRules: { 'example.com': 'never' } }).refused, true);

  // 名单外的站点也答 off，但那只是「我们不主动动手」，不是「这里不许动」：字幕
  // 在一个没上名单的视频站上照翻。
  const quiet = refused({});
  assert.equal(quiet.verdict, 'off');
  assert.equal(quiet.reason, R.DEFAULT_OFF);
  assert.equal(quiet.refused, false);

  // 所有 auto 都不是拒绝。
  assert.equal(refused({ userRules: { 'example.com': 'always' } }).refused, false);
});

test('总开关关着但用户已经在这一页表过态，就不算这个站点拒绝了我们', () => {
  // explicit 越过总开关是阶梯本来就有的行为；refused 跟着同一个结论走，不另算。
  const held = SiteRules.decide(input({ settings: { autoTranslate: false }, explicit: true }));
  assert.equal(held.verdict, 'auto');
  assert.equal(held.refused, false);
});

// 装载清单，一份都不能漏：manifest 的 <all_urls> 那一条、service worker 的
// import（入口和两个自己 import 统计模块的文件）、设置页、弹窗和首装引导页的 <script>。共用模块是按顺序加载的经典脚本，**谁在谁前面
// 就是依赖关系本身**——漏一处的表现不是报错，是那一处静静地换了一套行为。
const LOAD_LISTS = [
  ['background/background.js', (rel) => new RegExp(`import '\\.\\./${rel.replace(/[./]/g, '\\$&')}';`)],
  ['background/ai-translate.js', (rel) => new RegExp(`import '\\.\\./${rel.replace(/[./]/g, '\\$&')}';`)],
  ['background/api-client.js', (rel) => new RegExp(`import '\\.\\./${rel.replace(/[./]/g, '\\$&')}';`)],
  ['options/options.html', (rel) => new RegExp(`<script src="\\.\\./${rel.replace(/[./]/g, '\\$&')}"></script>`)],
  ['popup/popup.html', (rel) => new RegExp(`<script src="\\.\\./${rel.replace(/[./]/g, '\\$&')}"></script>`)],
  ['onboarding/onboarding.html', (rel) => new RegExp(`<script src="\\.\\./${rel.replace(/[./]/g, '\\$&')}"></script>`)],
];

// [依赖方, 被依赖方, 漏了会怎样]
const LOAD_ORDER = [
  ['shared/site-rules.js', 'shared/site-rules-builtin.js',
   'table() 拿不到数据源时不抛，它退回一张空表 —— matchBuiltin() 谁也不认，'
   + 'isBlocked() 对每一个域名都答「不在黑名单里」。那份禁翻清单（网银、网页'
   + '邮箱、政务表单）就这么静静地没了，而控制台里只有一行 warn。'],
  ['shared/caption-core.js', 'shared/lang-tags.js',
   'caption-core.js 在加载时就把 getLangBase 取走了。'],
  // 同步存储的单写者队列：三家写入在加载时就取走 StorageWriter，没有它就抛。
  // 服务工作者是 ES 模块图，按深度优先求值 —— 哪个文件先 import 了写入方，那个
  // 文件就得先 import 它。
  ['shared/site-rules.js', 'shared/storage-writer.js',
   'site-rules.js 在加载时就把 StorageWriter.create 取走了。'],
  ['shared/auto-stats.js', 'shared/storage-writer.js',
   'auto-stats.js 在加载时就把 StorageWriter.create 取走了。'],
  ['shared/sync-collection.js', 'shared/storage-writer.js',
   'sync-collection.js 在加载时就把 StorageWriter 取走了。'],
  ['shared/sync-collection.js', 'shared/site-rules.js',
   'sync-collection.js 的 forHost 用 SiteRules.hostMatches 认地址。'],
  ['shared/custom-rules.js', 'shared/storage-writer.js',
   'custom-rules.js 在加载时就把 StorageWriter.create 取走了。'],
  ['shared/custom-rules.js', 'shared/site-rules.js',
   'custom-rules.js 的 match 用 SiteRules.validPattern / patternMatches。'],
  ['shared/custom-rules.js', 'shared/sync-collection.js',
   'custom-rules.js 在加载时就把 SyncCollection.create 取走了。'],
  // 语域附加说明（R33 A4）：两处都在调用时才取，缺了不是加载时抛，是每一次
  // 翻译请求都抛 —— 整页、划词、字幕一起停。
  ['content/content-translation-engine.js', 'shared/site-rules.js',
   'ctx.withPromptAddenda 给每个翻译请求问 SiteRules.register() 这一页的语域。'],
  ['content/content-translation-cache.js', 'shared/prompt-addenda.js',
   '译文缓存的键因子 addenda 是 PromptAddenda.stamp() 算的。'],
  ['shared/custom-rules.js', 'shared/prompt-addenda.js',
   'custom-rules.js 在加载时取走 PromptAddenda（规则的 domain 按 DOMAINS 校验），缺了就抛，CustomRules 整个不存在。'],
  // 占位符与标记的语法：语言检测、收集、落笔都问 globalThis.TextMarkers。
  ['content/content-language.js', 'shared/text-markers.js',
   'content-language.js 剥标记时问 TextMarkers.strip，没有它语言检测整个抛错。'],
  // 设置页不装 content-language.js，这一行让设置页的顺序也被查到。
  ['content/content-translation-engine.js', 'shared/text-markers.js',
   '引擎比对占位符时问 TextMarkers.placeholderIds，没有它每一句译文都在比对时抛错。'],
  // 术语表（P1-C）：shared/glossary.js 在加载时取走三样，缺哪样都抛；内容脚本的
  // 镜像在加载时取走 Glossary；缓存层在加载时订阅 ctx.glossary（算代数的签名）。
  ['shared/glossary.js', 'shared/site-rules.js',
   'glossary.js 在加载时就把 SiteRules 取走了（站点限定用 normalizeHost）。'],
  ['shared/glossary.js', 'shared/storage-writer.js',
   'glossary.js 在加载时就把 StorageWriter.create 取走了。'],
  ['shared/glossary.js', 'shared/sync-collection.js',
   'glossary.js 在加载时就把 SyncCollection.create 取走了。'],
  ['shared/glossary-csv.js', 'shared/glossary.js',
   'glossary-csv.js 在加载时就把 Glossary 取走了（validateEntry、dedupeKey、merge、assertFits），缺了就抛。'],
  ['content/content-glossary.js', 'shared/glossary.js',
   'content-glossary.js 在加载时取走 Glossary，缺了它 ctx.glossary 不存在，引擎和缓存层都在调用时抛错。'],
  ['content/content-translation-cache.js', 'content/content-glossary.js',
   '缓存层在加载时订阅 ctx.glossary：它不在，整个文件抛错，ctx.requestTranslationCached 与悬停、字幕读的代数都没了。'],
  ['content/content-translation-cache.js', 'content/page/custom-rule.js',
   '缓存层在加载时订阅 ctx.customRules.onProfileChange（本站规则的引擎或领域变了加一代）：它不在，整个文件抛错。'],
  ['content/engine/glossary.js', 'shared/glossary.js',
   '词表快照按 Glossary.pick 挑本站本语言的词条。'],
  ['content/engine/glossary.js', 'shared/text-markers.js',
   '占位保护按 TextMarkers 的语法换出、换回 {{n}}。'],
  ['content/engine/addenda.js', 'shared/prompt-addenda.js',
   '按 60 条切份读 PromptAddenda.LIMITS，缺了它每一次 AI 请求都在切份时抛错。'],
  ['content/content-translation-engine.js', 'content/engine/glossary.js',
   '引擎这一族顺序与 manifest 一致：词表与附加说明排在入口之前。'],
  ['content/content-translation-engine.js', 'content/engine/addenda.js',
   '引擎这一族顺序与 manifest 一致：词表与附加说明排在入口之前。'],
];

test('装载清单：共用模块和它依赖的那一份，顺序不能倒', async () => {
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

// ------------------------------------------------------------ 设置页的站点编辑器

test('parseSiteInput turns whatever was typed into the key decide() reads', () => {
  const host = (text) => SiteRules.parseSiteInput(text).host;
  assert.equal(host('example.com'), 'example.com');
  assert.equal(host('  Example.COM  '), 'example.com');
  assert.equal(host('https://www.Example.com/a/b?c=1#d'), 'example.com');
  assert.equal(host('http://news.example.co.uk:8080/'), 'news.example.co.uk');
  assert.equal(host('www.example.com/path'), 'example.com');
  assert.equal(host('localhost'), 'localhost');
  // 中文域名存成地址栏里 location.hostname 的那个样子：punycode。
  assert.equal(host('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
  // 键就是 decide() 查的那一把：写进去的站点真的会命中。
  const typed = host('https://www.forum.example/thread/1');
  assert.equal(verdict({ host: 'www.forum.example', userRules: { [typed]: 'always' } }).reason, R.USER_ALWAYS);
});

test('parseSiteInput names what is wrong instead of storing a key nobody can hit', () => {
  for (const bad of ['', '   ', 'not a site', '*.example.com', 'exa_mple.com', '[::1]', 'http://', '-bad.com', 'a..b']) {
    assert.deepEqual(SiteRules.parseSiteInput(bad), { error: 'invalid' }, bad);
  }
  // 黑名单和内置 never：写什么进去都不算数，所以不让写。
  assert.deepEqual(SiteRules.parseSiteInput('https://mail.google.com/mail/u/0'), { error: 'blocked', host: 'mail.google.com' });
  assert.deepEqual(SiteRules.parseSiteInput('irs.gov'), { error: 'blocked', host: 'irs.gov' });
});

test('builtinSites lists the shipped table by state, blocklist folded into never', () => {
  const sites = SiteRules.builtinSites();
  const hosts = (state) => sites[state].map((site) => site.host);
  assert.ok(hosts('always').includes('x.com'));
  assert.ok(hosts('always').includes('bbc.co.uk'));
  assert.deepEqual(hosts('captions'), ['youtube.com']);
  assert.ok(hosts('never').includes('mail.google.com'), 'the blocklist is part of never');
  assert.ok(hosts('never').includes('arxiv.org'), 'the built-in never rule is part of never');
  // 一个主机多条路径：合成一行，把路径带上。
  const arxiv = sites.always.find((site) => site.host === 'arxiv.org');
  assert.deepEqual(arxiv.patterns, ['arxiv.org/abs/*', 'arxiv.org/html/*', 'arxiv.org/list/*']);
  // 一键盖过去：always / captions 行可以，never 行不行（阶梯上它排在用户规则前面）。
  assert.ok(sites.always.every((site) => site.writable));
  assert.ok(sites.captions.every((site) => site.writable));
  assert.ok(sites.never.every((site) => !site.writable));
  // 每一格都真的在表里：数目对得上（内置规则的模式 + 黑名单）。
  const patterns = Object.values(sites).flat().reduce((n, site) => n + site.patterns.length, 0);
  const shipped = SiteRulesBuiltin.rules.reduce((n, rule) => n + [].concat(rule.match).length, 0)
    + SiteRulesBuiltin.blocklist.length;
  assert.equal(patterns, shipped);
});
