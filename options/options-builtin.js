// Blab Translation 设置页 —— 内置翻译引擎状态
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// 内置翻译引擎状态
//
// 判定和下载在 shared/language-pack.js（首装引导页用的是同一份）；这里只管
// 这一页的控件：状态那一行、下载按钮，以及丢弃过期结果的序号。
// ---------------------------------------------------------------------------

let builtinStatusSeq = 0;

function getBuiltinEngine() {
  return window.AI_TRANSLATOR_CONTENT && window.AI_TRANSLATOR_CONTENT.builtinTranslator;
}

function showBuiltinStatus(result) {
  elements.builtinStatus.textContent = LanguagePack.message(result, t, currentUILang);
  elements.downloadLanguagePack.hidden = !result.downloadable;
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
  const targetLang = elements.targetLang.value;
  const known = LanguagePack.describe(engine, { targetLang, engineFallback: elements.engineFallback.value });
  if (known) {
    showBuiltinStatus(known);
    return;
  }

  elements.builtinStatus.textContent = t('builtinChecking');
  const probed = await LanguagePack.probe(engine, targetLang);
  if (seq !== builtinStatusSeq) return;
  showBuiltinStatus(probed);
}

// 静态判定的两种说法由回退设置决定，所以它一变也要重画。options.html 把本文件
// 放在 body 末尾，加载时这个控件已经在 DOM 里了。
document.getElementById('engineFallback').addEventListener('change', () => refreshBuiltinStatus());

async function downloadLanguagePack() {
  const engine = getBuiltinEngine();
  if (!engine) return;

  const button = elements.downloadLanguagePack;
  button.disabled = true;

  try {
    // 下载必须由这次点击直接触发，见 LanguagePack.download。
    await LanguagePack.download(engine, elements.targetLang.value, (pct) => {
      elements.builtinStatus.textContent = `${t('builtinDownloading')} ${pct}%`;
    });
    elements.builtinStatus.textContent = t('builtinReady');
    button.hidden = true;
    showStatus(t('builtinDownloadComplete'), 'success');
  } catch (error) {
    console.error('Language pack download failed:', error);
    elements.builtinStatus.textContent = t('builtinDownloadFailed');
    showStatus(t('builtinDownloadFailed'), 'error');
  } finally {
    button.disabled = false;
  }
}
