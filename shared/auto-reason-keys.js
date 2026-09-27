// 调度层给出的理由 → 一句人话的 i18n 键。只有这一张。
//
// 页面上状态点展开那一行的后半句读它：状态说的是「现在怎么样」，理由说的是「为什么
// 是这样」，少了后半句，一个安安静静什么都没翻的页面和一个被黑名单挡住的页面在
// 用户眼里一模一样。popup 的站点行灰着时，title 上那句「为什么灰」也读它 —— 页面
// 在 AUTO_PAGE_STATE 里回的是枚举（SiteRules.blockReason()），popup 只按枚举取话，
// 不自己重判是黑名单还是内置 never（R33 D-360 F3）。两处各留一份的话，哪天一处多认
// 一个理由，同一个站点在两个地方会说成两件事。
//
// 前九条是 decide() 的阶梯（shared/site-rules.js 的 REASONS，
// test/unit/pdf-offer.test.mjs 盯着这张表要把它们全收齐）；末尾两条是阶梯之外那道
// 费用闸（content/content-auto-translate.js 的 COST_REASONS）。这张表比 decide()
// 宽一点是有意的：它答的是「调度层为什么这样」，而 decide() 只是其中一个出处 ——
// 所以它不放进 site-rules.js（test/unit/auto-cost-gate.test.mjs 不许 COST_ 进那张表）。
(function (root) {
  'use strict';

  root.AutoReasonKeys = Object.freeze({
    GLOBAL_OFF: 'autoReasonGlobalOff',
    BLOCKLIST: 'autoReasonBlocklist',
    BUILTIN_NEVER: 'autoReasonBuiltinNever',
    USER_NEVER: 'autoReasonUserNever',
    USER_EXPLICIT: 'autoReasonUserExplicit',
    USER_ALWAYS: 'autoReasonUserAlways',
    BUILTIN_ALWAYS: 'autoReasonBuiltinAlways',
    BUILTIN_CAPTIONS: 'autoReasonBuiltinCaptions',
    DEFAULT_OFF: 'autoReasonDefaultOff',
    COST_ENGINE: 'autoReasonCostEngine',
    COST_BUDGET: 'autoReasonCostBudget',
  });
})(globalThis);
