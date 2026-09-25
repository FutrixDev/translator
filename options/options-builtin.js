// Blab Translation 设置页 —— 内置翻译引擎状态
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// 内置翻译引擎状态
//
// 语言包是按“语言对”下载的，而源语言取决于用户当时打开的是什么页面，设置页
// 无从预知。所以这里只对 en → 目标语言（现实中占绝大多数的那一对）给出状态和
// 一个下载按钮；其它语言对在整页翻译首次用到时自动下载——那条路径带着用户点击
// 产生的 user activation，正是 create() 触发下载所要求的东西。
// ---------------------------------------------------------------------------

const BUILTIN_PROBE_SOURCE = 'en';
let builtinStatusSeq = 0;

function getBuiltinEngine() {
  return window.AI_TRANSLATOR_CONTENT && window.AI_TRANSLATOR_CONTENT.builtinTranslator;
}

async function refreshBuiltinStatus() {
  const isBuiltin = elements.translationEngine.value === 'builtin';
  elements.builtinStatusGroup.hidden = !isBuiltin;
  // 回退只有在内置引擎下才是个问题：选了自定义接口，本来每一条就都在计费。
  elements.engineFallbackGroup.hidden = !isBuiltin;
  elements.downloadLanguagePack.hidden = true;
  if (!isBuiltin) return;

  // 改目标语言和切引擎都会重进这里，而中间夹着一次 await。不按序号丢弃过期结果的话，
  // 先发起的那次探测后回来，会把状态覆盖成上一个语言的。
  const seq = ++builtinStatusSeq;
  const engine = getBuiltinEngine();

  if (!engine || !engine.isSupported()) {
    // 说清楚为什么。设置页本身永远是安全上下文，所以这里问出来的实际上只会是
    // “Chrome 太旧”或“这个版本没有这个接口”——但那正是用户在这一页需要知道的：
    // 引擎选单把内置摆在第一位，不给理由就等于让他选一个不会动的东西。
    const reason = engine && engine.unsupportedReason && engine.unsupportedReason();
    const key = EngineStatus.REASON_MESSAGE_KEYS[reason] || 'builtinUnsupportedEnv';
    elements.builtinStatus.textContent = t(key);
    return;
  }

  const targetLang = elements.targetLang.value;
  if (!engine.supportsLang(engine.toApiLang(targetLang))) {
    // 端上根本没有这门语言（「仅 AI」那 37 门）：答案我们已经知道，不交给
    // availability() —— 它对这类语言在不同 Chrome 上答法不一，还只能换来一句
    // 含糊的「这一对不支持」。按回退设置点名说清楚会发生什么，下载按钮保持隐藏。
    const key = elements.engineFallback.value === 'allow-ai'
      ? 'builtinTargetUnsupportedAllowAi'
      : 'builtinTargetUnsupportedLocalOnly';
    elements.builtinStatus.textContent = t(key)
      .replace('{lang}', TargetLang.nameOf(targetLang, currentUILang, { inSentence: true }));
    return;
  }

  if (engine.toApiLang(targetLang) === BUILTIN_PROBE_SOURCE) {
    // 目标语言就是英语，探测 en→en 没有意义。
    elements.builtinStatus.textContent = t('builtinReady');
    return;
  }

  elements.builtinStatus.textContent = t('builtinChecking');
  const status = await engine.availability(BUILTIN_PROBE_SOURCE, targetLang);
  if (seq !== builtinStatusSeq) return;

  switch (status) {
    case 'available':
      elements.builtinStatus.textContent = t('builtinReady');
      break;
    case 'downloading':
      elements.builtinStatus.textContent = t('builtinDownloading');
      break;
    case 'downloadable':
      elements.builtinStatus.textContent = t('builtinDownloadable');
      elements.downloadLanguagePack.hidden = false;
      break;
    default:
      elements.builtinStatus.textContent = t('builtinUnsupportedPair');
  }
}

// 静态判定的两种说法由回退设置决定，所以它一变也要重画。options.html 把本文件
// 放在 body 末尾，加载时这个控件已经在 DOM 里了。
document.getElementById('engineFallback').addEventListener('change', () => refreshBuiltinStatus());

async function downloadLanguagePack() {
  const engine = getBuiltinEngine();
  if (!engine) return;

  const button = elements.downloadLanguagePack;
  const targetLang = elements.targetLang.value;
  button.disabled = true;

  try {
    // 下载必须由这次点击直接触发：create() 要求 user activation，
    // 挪到别处（比如打开设置页就自动下）会被浏览器直接拒掉。
    await engine.ensureDownloaded(BUILTIN_PROBE_SOURCE, targetLang, (loaded) => {
      const pct = Math.max(0, Math.min(100, Math.round((loaded || 0) * 100)));
      elements.builtinStatus.textContent = `${t('builtinDownloading')} ${pct}%`;
    });
    elements.builtinStatus.textContent = t('builtinReady');
    button.hidden = true;
    showStatus(t('builtinDownloadComplete'), 'success');
    broadcastLanguagePackReady(engine.toApiLang(targetLang));
  } catch (error) {
    console.error('Language pack download failed:', error);
    elements.builtinStatus.textContent = t('builtinDownloadFailed');
    showStatus(t('builtinDownloadFailed'), 'error');
  } finally {
    button.disabled = false;
  }
}
