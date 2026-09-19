// 内置站点规则表 —— 纯数据，一个函数都没有。
//
// 校验和匹配都在 shared/site-rules.js：这里只是它读的那张表。分成两个文件是因为
// 这张表会因为“某站改版了”而经常动，而决策逻辑几乎不动；混在一起，每次调一个
// selector 都要重读一遍决策阶梯。
//
// 两条不会变的约束：
//
//   1. **永远不从远端拉规则，更不下发 JS。** Chrome 的 remote-hosted-code 政策不
//      允许，规则更新就是发一次版。rulesVersion 只是给日志和问题排查用的。
//   2. **不建模现在不需要的字段。** 每站的引擎、每站的延迟、每站要注入的 CSS 都
//      曾经在草稿里出现过；加进来就要一直维护它们，而今天没有任何一条规则需要。
//
// 黑名单的优先级高于用户自己设的“总是翻译”（见 site-rules.js 的决策阶梯）。它防
// 的不是“用户想翻银行页面”，而是“用户在某个域名上点过一次总是翻译，此后我们往
// 别人的邮箱、在线文档编辑器、政务表单里插节点”——那是会出事的地方，不是体验
// 好不好的地方。
//
// 它也不是一份“安全站点清单”：域名列不全，也永远列不全。真正兜底的是默认值
// 本身——decide() 的默认结论是 ask，没上过 always 名单的站点不会自己动。
(function (root) {
  'use strict';

  root.SiteRulesBuiltin = {
    schemaVersion: 1,
    rulesVersion: '2026-09-19',

    // 匹配的是主机名后缀：'gov' 命中 irs.gov，也命中 www.irs.gov，但不命中
    // gov.uk（它不以 .gov 结尾），所以多部分的公共后缀要单独写一行。
    blocklist: [
      // 政务
      'gov', 'gov.uk', 'gov.cn', 'gov.au', 'gov.in', 'go.jp', 'gouv.fr',
      // 支付与银行（种子，不是全集）
      'paypal.com', 'stripe.com', 'alipay.com',
      'chase.com', 'bankofamerica.com', 'wellsfargo.com',
      'icbc.com.cn', 'ccb.com', 'cmbchina.com',
      // 邮箱
      'mail.google.com', 'outlook.com', 'outlook.live.com', 'outlook.office.com',
      'mail.yahoo.com', 'mail.qq.com', 'mail.163.com',
      // 在线文档编辑器：在别人的编辑器里插节点是灾难
      'docs.google.com', 'notion.so', 'notion.com', 'figma.com', 'overleaf.com',
    ],

    rules: [
      {
        // 摘要页结构十年没大改，风险最低，所以拿它做第一个内置 always。
        match: 'arxiv.org/abs/*',
        state: 'always',
        atomicBlockSelectors: ['blockquote.abstract'],
        excludeSelectors: ['.authors', '.dateline', '.submission-history'],
        blockIdAttr: null,
      },
      {
        match: 'x.com',
        state: 'always',
        atomicBlockSelectors: ['[data-testid="tweetText"]'],
        // 用户名、时间、互动条（回复/转推/喜欢的计数）都不是正文。
        excludeSelectors: ['[data-testid="User-Name"] a', 'time', '[role="group"]'],
        blockIdAttr: null,
      },
      {
        match: 'twitter.com',
        state: 'always',
        atomicBlockSelectors: ['[data-testid="tweetText"]'],
        excludeSelectors: ['[data-testid="User-Name"] a', 'time', '[role="group"]'],
        blockIdAttr: null,
      },
      {
        // old.reddit.com 以 .reddit.com 结尾，这一条已经覆盖它。等它的 selector
        // 真和新版分叉了再给它单开一条——现在写两条一模一样的，只是两份要同时
        // 改的东西。
        match: 'reddit.com',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.tagline', '.score', 'time', 'faceplate-timeago'],
        blockIdAttr: null,
      },
      {
        // 结构极简，拿来当回归基线：这里翻不好，通用启发式一定也翻不好。
        match: 'news.ycombinator.com',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.subtext', '.rank', '.age'],
        blockIdAttr: null,
      },
    ],
  };
})(globalThis);
