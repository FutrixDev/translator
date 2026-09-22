// Blab Translation 设置页 —— 自动翻译
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// 自动翻译：总开关、语言名单、站点审计表、本机统计
//
// 卡片里六块东西，只有前四块是普通设置项（走 collectSettings 那次整份写入）：
// 总开关、自动模式的引擎、语言名单、每日字符预算。后两块各有各的写入通道，
// 而且**必须**如此：
//
//   siteRules   是一张共享表，弹出窗口、内容脚本、设置页都在改它，所以写入收
//               在服务工作者里（SiteRules.writeUserRule）。把它塞进
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
 * 预算那一格只在自动模式真的会花钱时才有意义，跟着引擎选择器一起灰。
 *
 * 只变灰、不隐藏：一个填了数字的框突然消失，用户会以为那个数字也一起没了。
 */
function syncAutoEngineState() {
  if (!elements.autoAiBudgetGroup) return;
  elements.autoAiBudgetGroup.classList.toggle('disabled', elements.autoTranslateEngine.value !== 'ai');
}

/**
 * 把自动模式切到 AI 之前的那道二次确认（PRD FR-3.5 / FR-9）。
 *
 * 这是整个扩展里唯一一处 window.confirm，而且是有意的：别的设置改错了，用户
 * 下次打开这一页就能看见并改回来；这一个改错了，代价是接下来每一个自动翻译
 * 的页面都在花他自己的钱，而他不会点任何一下，所以也不会有任何一刻回到这一
 * 页来看。要拦住这件事，需要的正是 confirm 那种**必须回答才能继续**的性质，
 * 一条事后才出现的提示条做不到。
 *
 * 说了不，就把值退回 builtin 并且**什么都不写** —— 退回之后再存一次是多余
 * 的：存起来的本来就是 builtin。
 */
function onAutoEngineChange() {
  if (elements.autoTranslateEngine.value === 'ai' && !window.confirm(t('autoTranslateEngineAiConfirm'))) {
    elements.autoTranslateEngine.value = 'builtin';
    syncAutoEngineState();
    return;
  }
  syncAutoEngineState();
  persistSettings();
}

function autoLangChips() {
  return Array.from(elements.autoTranslateLangs.querySelectorAll('input[data-lang]'));
}

function collectAutoTranslateLangs() {
  return autoLangChips().filter(box => box.checked).map(box => box.getAttribute('data-lang'));
}

/**
 * 勾上存着的那几门语言。
 *
 * 存的**应该**是基码，因为这些勾只写得出基码；但 decide() 读这份名单时两边都过
 * baseLang，所以一份手改过、或者从别处同步来的 'zh-CN' 在判定里是算数的。这里
 * 用同一个 baseLang 收一次，界面才不会告诉用户「你没选中文」而它其实正在生效。
 */
function showAutoTranslateLangs(langs) {
  const picked = new Set((Array.isArray(langs) ? langs : []).map(SiteRules.baseLang).filter(Boolean));
  autoLangChips().forEach(box => { box.checked = picked.has(box.getAttribute('data-lang')); });
}

/**
 * 站点审计表：用户在弹出窗口里对哪些站点表过态，以及在这里把它收回来。
 *
 * 直接读 storage.sync，不等任何消息 —— 这张表是别的标签页写的，设置页打开的时候
 * 它早就在那儿了。删除也不自己写：走 SiteRules.writeUserRule(host, null) 那条单
 * 写者通道，于是同时删两个站点的两个标签页不会互相盖掉。删完不必通知内容脚本，
 * 调度层盯的是 storage.onChanged（content-auto-translate.js 的 RESTART_KEYS）。
 */
async function renderSiteRules() {
  const box = elements.siteRules;
  if (!box) return;

  let rules = {};
  try {
    const stored = await chrome.storage.sync.get({ siteRules: {} });
    if (stored.siteRules && typeof stored.siteRules === 'object') rules = stored.siteRules;
  } catch (error) {
    console.error('Failed to read site rules:', error);
  }

  const hosts = Object.keys(rules)
    .filter(host => rules[host] === 'always' || rules[host] === 'never')
    .sort();

  box.textContent = '';
  if (!hosts.length) {
    const empty = document.createElement('p');
    empty.className = 'site-rules-empty';
    empty.textContent = t('siteRulesEmpty');
    box.appendChild(empty);
    return;
  }
  hosts.forEach(host => box.appendChild(siteRuleRow(host, rules[host])));
}

function siteRuleRow(host, state) {
  const row = document.createElement('div');
  row.className = 'site-rule';

  const name = document.createElement('span');
  name.className = 'site-rule-host';
  name.textContent = host;
  name.title = host;
  row.appendChild(name);

  const badge = document.createElement('span');
  badge.className = `site-rule-state site-rule-${state}`;
  badge.textContent = t(state === 'always' ? 'siteRuleAlways' : 'siteRuleNever');
  row.appendChild(badge);

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'btn btn-text site-rule-forget';
  forget.textContent = t('siteRuleForget');
  forget.addEventListener('click', async () => {
    forget.disabled = true;
    try {
      await SiteRules.writeUserRule(host, null);
    } catch (error) {
      console.error('Failed to remove site rule:', error);
      showStatus(t('connectionFailed'), 'error');
      forget.disabled = false;
      return;
    }
    // 重读一遍，而不是把这一行摘掉：规则是沿父域生效的，删掉 x.com 之后
    // mobile.x.com 那一行还在不在，只有把表重新读出来才算数。
    renderSiteRules();
  });
  row.appendChild(forget);

  return row;
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
