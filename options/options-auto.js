// Blab Translation 设置页 —— 自动翻译
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// 自动翻译：总开关、站点审计表、本机统计
//
// 卡片里五块东西，只有前三块是普通设置项（走 collectSettings 那次整份写入）：
// 总开关、自动模式的引擎、每日字符预算。后两块各有各的写入通道，
// 而且**必须**如此：
//
//   siteRules   是一张共享表，弹出窗口、内容脚本、设置页都在改它，所以写入收
//               在服务工作者里（SiteRules.writeUserRule）。编辑器在
//               options-site-editor.js。把它塞进
//               collectSettings，等于用户在设置页改任何一项，都拿这一页打开时
//               读到的那份快照去盖掉别的标签页刚写下的规则。
//   autoStats   根本不在 sync 里 —— 它只属于这台电脑（shared/auto-stats.js）。
//
// 两块都是运行时画出来的，不带 data-i18n，所以换界面语言时要整块重画：
// 见 applyI18n 末尾。
// ---------------------------------------------------------------------------

function syncAutoSubState() {
  if (!elements.autoSubOptions) return;
  elements.autoSubOptions.classList.toggle('disabled', !elements.autoTranslate.checked);
}

/**
 * 预算那一格管的是「没人点也会花到 AI」的那几条路，所以只要其中一条开着它就
 * 该亮着（内容脚本里的闸认的是同一张清单，见 refuseAutoAiSpend）：
 *
 *   - 自动模式的引擎选了 AI；
 *   - 手动那颗「翻译引擎」选了 AI —— 视频字幕沿用它，而字幕是一句一句自己在花；
 *   - 允许内置引擎顶不住时回退到用户自己的接口 —— 自动页面和字幕都可能走到。
 *
 * 只看第一条的话，一个手动选了 AI、字幕正在花钱的人面对的是一个灰掉的框，
 * 而那个框恰恰是在替他数钱。
 *
 * 只变灰、不隐藏：一个填了数字的框突然消失，用户会以为那个数字也一起没了。
 *
 * 问的是一份设置对象而不是表单：导入预览要拿「当前」和「导入之后」各问一次，
 * 看导入会不会打开一条原本关着的路（options-transfer.js）。三条路只在这里写。
 */
function unattendedAiReachable(settings) {
  return settings.autoTranslateEngine === 'ai'
    || settings.translationEngine === 'ai'
    || settings.engineFallback === 'allow-ai';
}

// 第四条路是站点翻译规则：一条规则可以把某些网站的自动翻译钉在 AI 上
// （options-custom-rules.js）。它不并进上面那个谓词 —— 整份导入的预览拿那个谓
// 词比较导入前后的「设置」，规则项并在里面，规则里已有 AI 时设置小节的提示就
// 永远不会出现。
function syncAutoEngineState() {
  if (!elements.autoAiBudgetGroup) return;
  elements.autoAiBudgetGroup.classList.toggle('disabled',
    !(unattendedAiReachable(collectSettings()) || customRulesUseAi()));
}

/**
 * 让「没人点也会花到用户自己的 AI」的那种改动先过一道二次确认（PRD FR-3.5 /
 * FR-9）。两个调用方：自动模式的引擎切到 AI；站点翻译规则的引擎新改成 AI
 * （options-custom-rules.js）。两者花的是同一笔钱，所以是同一种形状。
 *
 * 这是整个扩展里唯一一处 window.confirm，而且是有意的：别的设置改错了，用户
 * 下次打开这一页就能看见并改回来；这一个改错了，代价是接下来每一个自动翻译
 * 的页面都在花他自己的钱，而他不会点任何一下，所以也不会有任何一刻回到这一
 * 页来看。要拦住这件事，需要的正是 confirm 那种**必须回答才能继续**的性质，
 * 一条事后才出现的提示条做不到。
 */
function confirmUnattendedAiSpend(messageKey) {
  return window.confirm(t(messageKey));
}

// 说了不，就把值退回改之前存着的那个引擎并且**什么都不写** —— 退回之后再存一
// 次是多余的：存起来的本来就是它。改之前可能是 builtin，也可能是 Blab
// Translation；选 Blab 不过这道确认：它花的是订阅里的额度，不是用户自己的钱（§5.4）。
function onAutoEngineChange() {
  if (elements.autoTranslateEngine.value === 'ai' && !confirmUnattendedAiSpend('autoTranslateEngineAiConfirm')) {
    elements.autoTranslateEngine.value = Engines.normalizeEngine(lastGoodSettings && lastGoodSettings.autoTranslateEngine);
    syncAutoEngineState();
    return;
  }
  syncAutoEngineState();
  persistSettings();
}

async function renderAutoStats() {
  if (!elements.statPages) return;
  const stats = await AutoStats.read();
  elements.statPages.textContent = stats.pages.toLocaleString(currentUILang);
  elements.statChars.textContent = stats.aiChars.toLocaleString(currentUILang);
  const rate = AutoStats.cacheHitRate(stats);
  // 一次都没量过写「—」而不是 0%：那两句话不一样，见 shared/auto-stats.js。
  elements.statCacheHit.textContent = rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

async function resetAutoStats() {
  // AutoStats.reset() 自己把错误吃掉（统计写不上不该变成一次报错），所以这里
  // 没有失败分支 —— 重画一遍就是结果，清没清成看得见。
  await AutoStats.reset();
  renderAutoStats();
}

/**
 * 清掉这台电脑上存着的译文。
 *
 * 和上面那颗按钮相反，这一颗有失败分支：统计清不掉，用户下次看还是那几个数字，
 * 自己就知道了；缓存清不掉却说「清好了」，是在一件写进隐私政策的事情上骗人。
 * TranslationCache.clear() 为此特地不吞错误。
 */
async function clearTranslationCache() {
  try {
    await TranslationCache.clear();
  } catch (error) {
    console.error('Failed to clear the translation cache:', error);
    showStatus(t('cacheClearFailed'), 'error');
    return;
  }
  showStatus(t('cacheCleared'), 'success');
}
