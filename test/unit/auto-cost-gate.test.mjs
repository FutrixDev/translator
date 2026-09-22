// 自动模式的费用闸（PRD FR-9）。
//
// 这一道闸挡的是**零点击的花钱**：用户为了手动翻译把引擎切到 AI，此后他打开
// 的每一个页面都在悄悄走 AI，而他不会点任何一下，也就不会有任何一刻回到设置
// 页来看。所以这里的每一条断言都在钉同一件事的一部分：
//
//   1. 自动模式走哪个引擎是**一个自己的设置**，默认免费；
//   2. 判定装在**唯一那个发给模型的出口**上，运行中的回落绕不过去；
//   3. 问额度和记额度是**同一次操作**，八个并发批次挤不过去（auto-stats.test.mjs）；
//   4. 设置页上把它切到 AI 要**过一道二次确认**，而且确认里写明是在花谁的钱。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optionsSource } from './helpers/sources.mjs';

const code = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/default-settings.js');
const { CONTENT_DEFAULTS } = globalThis.DefaultSettings;

test('自动模式的引擎是自己的一个键，而且默认不花钱', () => {
  // 和 translationEngine（手动翻译走哪个）是两件事。合成一个键，就等于一个为
  // 了手动翻译切到 AI 的用户，此后每一页都在走 AI —— 这正是要修的那件事。
  assert.equal(CONTENT_DEFAULTS.autoTranslateEngine, 'builtin');
  assert.equal(CONTENT_DEFAULTS.translationEngine, 'builtin');
  assert.notEqual('autoTranslateEngine', 'translationEngine');
  // 预算是一个正数上限，不是 0 —— 0 在这套约定里是「不限」，默认不限就等于
  // 没有这道闸。
  assert.ok(Number.isInteger(CONTENT_DEFAULTS.autoAiDailyBudget));
  assert.ok(CONTENT_DEFAULTS.autoAiDailyBudget > 0);
});

test('闸装在唯一那个发给模型的出口上，不在调度层', () => {
  const engine = code('content/content-translation-engine.js');
  // requestTranslation 最后那一行是**唯一**一个 sendMessage 出口：选了 AI 走到
  // 这里，选了内置但这个环境顶不住、而且开了回退，也走到这里。判定必须紧挨着
  // 它 —— 装在调度层只挡得住前一半，运行中那次回落会从旁边绕过去。
  assert.match(
    engine,
    /const refusal = await refuseAutoAiSpend\(message\);\s*\n\s*if \(refusal\) return \{ error: refusal \};\s*\n\s*return chrome\.runtime\.sendMessage\(message\);/
  );
  // 只拦自动模式。手动翻译是用户一次一次点出来的，他知道自己在花钱。
  assert.match(engine, /if \(!message \|\| !message\.auto\) return null;/);
  // 两道：允不允许用 AI，和今天还够不够。
  assert.match(engine, /settings\.autoTranslateEngine !== 'ai'/);
  assert.match(engine, /AutoStats\.charge\(chars, settings\.autoAiDailyBudget\)/);
});

test('「这一批是自动发的」一路带到三个发消息的地方', () => {
  // 闸认的是 message.auto。批次层漏传任何一处，那一处就是一个绕过费用闸的洞，
  // 而且是静默的 —— 页面照样翻出来，只是钱花了。
  const batch = code('content/page/batch.js');
  assert.match(batch, /const auto = options\.auto === true;/);
  const sends = batch.match(/type: 'TRANSLATE_BATCH_FAST'[\s\S]{0,400}?\}\)/g) || [];
  assert.ok(sends.length >= 2, `只找到 ${sends.length} 处批量请求，正则该修了`);
  for (const send of sends) assert.ok(/\bauto\b/.test(send), `一处批量请求没带 auto：${send.slice(0, 120)}`);
  // 逐块重试那条路也一样 —— 它正是批量失败之后走的那条。
  assert.match(batch, /function translateBlocksOneByOne\([^)]*\bauto\b/);
  // 调度层发起的那一趟自己报家门。
  assert.match(code('content/content-auto-translate.js'), /auto: true/);
});

test('调度层的预判和闸问的是同一个设置、同一个函数', () => {
  const auto = code('content/content-auto-translate.js');
  // 预判不花钱，只负责让用户看见「为什么停了」；闸不说话，只会拒。两边各算各
  // 的就会出现「状态说没超、翻译却被拒」这种没人能解释的页面。
  assert.match(auto, /AutoStats\.budgetExceeded\(stats, ctx\.settings\.autoAiDailyBudget\)/);
  assert.match(auto, /ctx\.settings\.autoTranslateEngine !== 'ai'/);
  // 只在这一页**只剩 AI 这条路**时才问 —— 内置引擎跑得动的页面不花钱。
  assert.match(auto, /ctx\.builtinTranslator\.effectiveEngine\(\)\) !== 'ai'/);
  // 问在 takeBatch 之前：takeBatch 会把队列抽干、把块记进 inflight，被拦下的
  // 这一轮根本不会跑，那些块就此无声消失。
  const gate = auto.indexOf('const refused = await costRefusal();');
  const drain = auto.indexOf('const blocks = takeBatch();');
  assert.ok(gate !== -1 && drain !== -1);
  assert.ok(gate < drain, '费用闸要问在 takeBatch 抽干队列之前');
  // 「退回手动模式并提示一次」。一次，不是每一轮。
  assert.match(auto, /if \(refused === COST_REASONS\.BUDGET && !budgetNoticed\)/);
  assert.match(auto, /budgetNoticed = true;/);
});

test('两个停翻理由不混进 decide() 那张表', () => {
  // decide() 永远不会返回这两个 —— 塞进 SiteRules.REASONS 会让那张表变成一句
  // 谎话。状态条那张 REASON_KEYS 有意比它宽。
  assert.doesNotMatch(code('shared/site-rules.js'), /COST_ENGINE|COST_BUDGET/);
  const status = code('content/content-auto-status.js');
  assert.match(status, /COST_ENGINE: 'autoReasonCostEngine'/);
  assert.match(status, /COST_BUDGET: 'autoReasonCostBudget'/);
});

test('设置页把它切到 AI 要过一道二次确认，说了不就退回去', () => {
  const options = optionsSource();
  // 有意不进 IMMEDIATE_SAVE_FIELDS：那条路线是「变了就存」，而这里可能要把值
  // 退回去。进了那张表就是两个 change 监听各存各的，确认说不也照存不误。
  const immediate = options.match(/const IMMEDIATE_SAVE_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(immediate, 'IMMEDIATE_SAVE_FIELDS 不见了');
  assert.ok(!immediate[1].includes("'autoTranslateEngine'"),
    'autoTranslateEngine 不能走「变了就存」那条路线：二次确认要能拦住写入');
  assert.match(options, /elements\.autoTranslateEngine\.addEventListener\('change', onAutoEngineChange\)/);
  assert.match(options, /window\.confirm\(t\('autoTranslateEngineAiConfirm'\)\)/);
  // 说了不：值退回 builtin，并且**不**存。
  assert.match(options, /elements\.autoTranslateEngine\.value = 'builtin';\s*\n\s*syncAutoEngineState\(\);\s*\n\s*return;/);
  // 两个字段都真的读进来、也真的写回去。
  assert.match(options, /autoTranslateEngine: elements\.autoTranslateEngine\.value === 'ai' \? 'ai' : 'builtin'/);
  assert.match(options, /autoAiDailyBudget: Math\.max\(0, Math\.floor\(Number\(elements\.autoAiDailyBudget\.value\) \|\| 0\)\)/);

  const html = code('options/options.html');
  assert.match(html, /<select id="autoTranslateEngine">/);
  assert.match(html, /<input type="number" id="autoAiDailyBudget"/);
  // 两个都在自动翻译那张卡的子块里 —— 自动翻译关着的时候它们该跟着灰。
  const sub = html.slice(html.indexOf('id="autoSubOptions"'));
  const subEnd = sub.indexOf('<!-- The audit table');
  assert.ok(subEnd > 0, 'autoSubOptions 的结尾标记找不到了');
  assert.ok(sub.slice(0, subEnd).includes('id="autoTranslateEngine"'));
  assert.ok(sub.slice(0, subEnd).includes('id="autoAiDailyBudget"'));
});

test('确认文案写明花的是用户自己的钱，而且十门语言都有', async () => {
  await import('../../i18n/messages.js');
  const { I18N_MESSAGES, UI_LANGUAGES } = globalThis;
  const keys = ['autoTranslateEngineAiConfirm', 'autoTranslateEngineLabel', 'autoTranslateEngineBuiltin',
    'autoTranslateEngineAi', 'hintAutoTranslateEngine', 'autoAiDailyBudgetLabel', 'hintAutoAiDailyBudget',
    'autoEngineAiOff', 'autoBudgetSpent', 'autoReasonCostEngine', 'autoReasonCostBudget'];
  for (const lang of UI_LANGUAGES) {
    for (const key of keys) {
      assert.ok(I18N_MESSAGES[lang] && I18N_MESSAGES[lang][key], `${lang} 少了 ${key}`);
    }
  }
  // 一句空话式的确认（「确定吗？」）拦不住任何人。它得说出代价：调的是你自己
  // 的接口、算你自己的账、而且此后不需要你再点任何一下。
  assert.match(I18N_MESSAGES.en.autoTranslateEngineAiConfirm, /billed to you/i);
  assert.match(I18N_MESSAGES['zh-CN'].autoTranslateEngineAiConfirm, /你自己的账单/);
});
