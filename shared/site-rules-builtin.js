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
    rulesVersion: '2026-09-22',

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
        // 论文的 PDF —— 这张表里第一条、也是目前唯一一条 never。
        //
        // 它不是「这一页不该翻」，是「这一页不走这条路」：PDF 走的是服务端的
        // 排版任务（background/pdf-jobs.js），按页扣额度，而额度是钱。内置
        // always 的代价不过是在一个没问过用户的页面上插几个节点，这里的代价是
        // 一份**账单**，所以两者不能同一个默认值。
        //
        // 落成 never 而不是「什么都不写」，因为不写的结果是落到阶梯底下的
        // ask —— 整页翻译的那条追问条会出现在一份 PDF 上，而点下去它一个字也
        // 翻不出来（文档在一个闭合影子 DOM 的外进程 <embed> 里，收集层看到的是
        // 一个空 body）。never 把那条追问条按住，换上真正能办事的那一条：
        // content/content-pdf-prompt.js 的「翻译这篇文档」，点了才发请求。
        //
        // 只写 arxiv：别处的 .pdf 网址同样翻不了整页文本，但那条提示条本来就
        // 压在追问条上面（见 content/content-auto-status.js 的模式阶梯），不必
        // 为每一个域名各写一行永远写不全的规则。
        match: 'arxiv.org/pdf/*',
        state: 'never',
        atomicBlockSelectors: [],
        excludeSelectors: [],
        blockIdAttr: null,
      },
      {
        // 全文的 HTML 版，LaTeXML 出的（class 全是 ltx_ 开头）。
        //
        // **ar5iv 不用单开一条**：它的域名是 ar5iv.labs.arxiv.org，以 arxiv.org
        // 结尾，路径也是 /html/<id>，上面这个模式原样命中它。
        //
        // 排除的两块都不是正文，而且是整份文档里最贵的两块：
        //   - .ltx_authors 是姓名、单位、邮箱，外加 \thanks 脚注（"Work performed
        //     while at Google Brain"）——人名翻出来只会让人认不出是谁。
        //   - .ltx_bibliography 动辄几百条，占全文相当一部分字数，而参考文献翻成
        //     中文的结果是**找不到原文**了。读者要拿它去搜论文。
        // 公式和代码清单不在这里：MATH_CONTAINER_SELECTOR 认得 .ltx_Math，
        // collect.js 的代码容器名单认得 ltx_listing 那一族，两者都已经跳过了。
        match: 'arxiv.org/html/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.ltx_authors', '.ltx_bibliography'],
        blockIdAttr: null,
      },
      {
        // 列表页：一屏几十条标题，正是「扫一眼今天有什么」的场景。
        // 结构是 <dl><dt>…</dt><dd><div class="list-title">…；标题本身有直接文本，
        // 通用启发式就当块处理了，所以这里只要把不是正文的三块摘掉：作者名、
        // arXiv 编号（"arXiv:2609.22081 [pdf, html, other]"）、学科分类（分类名后
        // 面跟着 cs.CL 这样的代号，翻了就对不上目录了）。
        // .list-comments（"17 pages, 6 figures"）是人写的，留着。
        match: 'arxiv.org/list/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.list-authors', '.list-identifier', '.list-subjects'],
        blockIdAttr: null,
      },
      {
        // Hugging Face 的 Daily Papers 榜单。
        //
        // 写成两条而不是 `/papers*` 一条，是因为 pathMatches 把 `*` 展开成 `.*`，
        // 不带 `/` 的通配没有段边界：`/papers*` 会连 `/paperswithcode` 这样的
        // 组织主页一起认下来，而内置规则是 always——认错的代价是在一个从没问过
        // 用户的页面上自己动手，还花他的额度。
        //
        // 一条选择器都没有是查过之后的结论，不是没来得及写：这一页的 class 全是
        // Tailwind 那种工具类（flex、text-sm），没有一个能当锚点的语义 class，
        // 标题就是 article h3 a 里的纯文本。拿工具类当选择器，人家调一次样式我们
        // 就悄悄失效。真需要排除时再补，那天它得有个稳定的钩子。
        match: 'huggingface.co/papers',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: [],
        blockIdAttr: null,
      },
      {
        // 单篇的摘要页，外加 /papers/date/<日期> 这种榜单归档。
        match: 'huggingface.co/papers/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: [],
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
      {
        // Lobsters —— 和 HN 同一个场景（一屏几十条标题），排版也同样朴素。
        // .byline 是「via <用户名> 5 小时前 | caches … | 16 comments」，.tags 是
        // 版块代号（privacy、rust、plt）：那些代号同时是站内的筛选链接，翻出来
        // 就和他自己的标签页对不上了。
        match: 'lobste.rs',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.byline', '.tags'],
        blockIdAttr: null,
      },
      {
        // bioRxiv 的预印本页，模板是 HighWire（class 全是 highwire- 开头）。
        // 只排两块：作者行（人名 + ORCID 链接文字）和 doi 那一行。
        // 摘要、正文、图注都留着——这一页读者要的就是它们。
        //
        // 故意**不**排 .pane-highwire-article-citation：它是整块引文面板，标题
        // 和摘要都在里面，排掉等于一页什么都不翻。
        match: 'biorxiv.org/content/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.highwire-cite-authors', '.highwire-cite-metadata'],
        blockIdAttr: null,
      },
      {
        // Nature 的文章页。排除的五块和 arxiv/html 那条是同一个道理：人名翻了
        // 认不出是谁，参考文献翻了搜不到原文。
        // .c-article-info-details 是「Nature 卷 625，页 468–475 (2024)」这种
        // 出处行，.c-bibliographic-information 是「Cite this article」那一段。
        match: 'nature.com/articles/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: [
          '.c-article-author-list',
          '.c-article-references',
          '.c-bibliographic-information',
          '.c-article-info-details',
          '#author-information-content',
        ],
        blockIdAttr: null,
      },
      {
        // Science 的文章页。
        //
        // **这条的空名单是「没验过」，不是「验过之后没有」** —— 和上面
        // huggingface 那条不是一回事。science.org 挡在 Cloudflare 的 JS 挑战
        // 后面，抓不到真实 DOM，凭印象写 selector 只会写出一组悄悄失效的字符串。
        // 空名单的代价是作者名和参考文献也跟着翻，那是翻得糙；写错的 selector
        // 是看着有规则、其实一条没生效。哪天能拿到真实结构再补。
        match: 'science.org/doi/*',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: [],
        blockIdAttr: null,
      },
      {
        // Google 学术的结果页。路径写死 /scholar：同一个域名下还有 /citations
        // （作者主页）和 /scholar_lookup 这些，它们不是「扫一眼今天有什么」的
        // 场景，没必要一起认下来。
        //
        // 只覆盖 scholar.google.com —— hostMatches 是后缀匹配，
        // scholar.google.co.jp 不以 scholar.google.com 结尾，命不中。各国镜像
        // 要一条一条加，而在此之前它们走的是通用启发式，不是坏结果。
        //
        // .gs_a 是「作者 - 期刊, 年份 - 站点」那一行（作者名 + 刊名 + 域名），
        // .gs_fl 是「[PDF] neurips.cc」和「保存 引用 被引用次数 相关文章」
        // 那两排功能链接。
        match: 'scholar.google.com/scholar',
        state: 'always',
        atomicBlockSelectors: [],
        excludeSelectors: ['.gs_a', '.gs_fl'],
        blockIdAttr: null,
      },
    ],
  };
})(globalThis);
