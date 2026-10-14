// Blab Translation 设置页 —— 离线词典卡片（设计 §6，任务书 B1）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用一个全局词法作用域：
// t、fill、showStatus、currentUILang 都直接叫名字（调用都发生在 DOMContentLoaded
// 之后）。
//
// 总开关 #offlineDictionary 是一个普通设置（sync），读写归 options.js 的
// loadSettings / collectSettings / IMMEDIATE_SAVE_FIELDS，这里只画它。
//
// 列表只读本机的 chrome.storage.local：`dict:packs`（已装好的包，唯一的「已装」
// 标记）、`dict:status`（正在下载 / 下载失败 / 清单里已没有）和 `dict:declined`
// （读者删掉的语言对，不再自动下载，D-609）。写一律交给 service worker 的单写者
// 队列（DICT_PACK_DELETE / DICT_PACK_INSTALL），这一页不碰 `d:` 键，此后跟着
// storage.onChanged 重读。打开这一页时先请 service worker 收拾上一个 worker 中途
// 停下留下的「下载中」（DICT_PACK_RECOVER）。

// { packs, status, declined }，读回来之前是 null。
let dictState = null;
let dictReadSeq = 0;

// 卡片里面的标记。options.html 只留 <section id="dictCard"> 这个挂载点（那个文件
// 要守住 1000 行），加载时一次填进去：options.js 的 elements 在加载时就按 id 取
// #offlineDictionary，所以这个文件排在它前面、必须先填。文案走 data-i18n，
// applyI18n 换界面语言时和别的卡片一起改。整段是写死的常量，不拼任何数据。
const DICT_CARD_MARKUP = `
  <h2 class="section-title">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M2 4h7a3 3 0 013 3v13a2 2 0 00-2-2H2z"/>
      <path d="M22 4h-7a3 3 0 00-3 3v13a2 2 0 012-2h8z"/>
    </svg>
    <span data-i18n="dictOfflineTitle">Offline dictionary</span>
  </h2>
  <div class="toggle-group">
    <label class="toggle-label">
      <span data-i18n="offlineDictionary">Look up words offline</span>
      <input type="checkbox" id="offlineDictionary" checked>
      <span class="toggle-slider"></span>
    </label>
    <span class="hint" data-i18n-hint="offlineDictionaryHint"></span>
  </div>
  <div class="dict-pack-list" id="dictPackList"></div>
`;

document.getElementById('dictCard').innerHTML = DICT_CARD_MARKUP;

const dictElements = {
  list: document.getElementById('dictPackList'),
};

async function loadDictPacks() {
  const seq = ++dictReadSeq;
  let found;
  try {
    found = await chrome.storage.local.get(DICT_KEYS);
  } catch (error) {
    console.error('[Blab Translation] dictionary packs: reading the list failed', error);
    return;
  }
  // 两次读交错回来时，只认后发的那一次。
  if (seq !== dictReadSeq) return;
  dictState = {
    packs: found[DictPack.PACKS_KEY] || {},
    status: found[DictPack.STATUS_KEY] || {},
    declined: found[DictPack.DECLINED_KEY] || [],
  };
  drawDictPacks();
}

const DICT_KEYS = [DictPack.PACKS_KEY, DictPack.STATUS_KEY, DictPack.DECLINED_KEY];

/** 按 dictState 重画列表：已装的包、有状态的和删掉的语言对，按语言对排序。 */
function drawDictPacks() {
  if (!dictState) return;
  const { packs, status, declined } = dictState;
  const pairs = [...new Set([...Object.keys(packs), ...Object.keys(status), ...declined])].sort();
  const rows = pairs.map((pair) => (
    declined.includes(pair) && !packs[pair] ? declinedDictRow(pair) : dictPackRow(packs[pair], status[pair], pair)
  ));
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'dict-pack-empty';
    empty.textContent = t('dictPacksEmpty');
    rows.push(empty);
  }
  dictElements.list.replaceChildren(...rows);
}

// 包的体积：不到 1 MB 按 KB（向上取整，几百字节的包也不显示成 0），否则沿用
// DocJobs.megabyteLabel（和服务端逐字一致的 MB 写法）。
function dictSizeLabel(bytes) {
  const kb = Math.ceil(bytes / 1024);
  return kb < 1024 ? `${kb} KB` : DocJobs.megabyteLabel(bytes);
}

// 每种状态的一句话。失败的写明是哪个版本（D-609）。
const DICT_STATE_TEXT = {
  downloading: () => t('dictPackDownloading'),
  failed: (status) => fill(t('dictPackFailed'), { ver: status.ver }),
  unlisted: () => t('dictPackUnlisted'),
};

function dictRowShell(pair, src, tgt) {
  const row = document.createElement('div');
  row.className = 'dict-pack';
  row.dataset.pair = pair;
  const name = document.createElement('span');
  name.className = 'dict-pack-name';
  name.textContent = TargetLang.pairName(src, tgt, currentUILang);
  row.appendChild(name);
  return row;
}

function dictRowText(row, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  row.appendChild(span);
}

function dictRowButton(row, className, text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-text ${className}`;
  button.textContent = text;
  button.addEventListener('click', () => onClick(button));
  row.appendChild(button);
}

// 一行：语言对、体积 / 词条数 / 版本（已装时）、状态（有时）、删除。
function dictPackRow(item, status, pair) {
  const { src, tgt } = item ? item : DictPack.splitPair(pair);
  const row = dictRowShell(pair, src, tgt);
  if (item) {
    dictRowText(row, 'dict-pack-meta', fill(t('dictPackMeta'), {
      size: dictSizeLabel(item.bytes),
      heads: item.heads.toLocaleString(currentUILang),
      ver: item.ver,
    }));
  }
  if (status) dictRowText(row, `dict-pack-state dict-pack-${status.state}`, DICT_STATE_TEXT[status.state](status));
  // 下载中的语言对没有可删的东西：删除排在队列里那个下载之后，删完它又不在了。
  if (item || (status && status.state === 'failed')) {
    dictRowButton(row, 'dict-pack-delete', t('dictPackDelete'),
      (button) => sendDictPack('DICT_PACK_DELETE', src, tgt, button, 'deleted', 'dictPackDeleteFailed'));
  }
  return row;
}

// 删掉的语言对：留一行「已删除 · 重新下载」，查词和每日检查都不再自动下载它（D-609）。
function declinedDictRow(pair) {
  const { src, tgt } = DictPack.splitPair(pair);
  const row = dictRowShell(pair, src, tgt);
  dictRowText(row, 'dict-pack-state dict-pack-declined', t('dictPackDeclined'));
  dictRowButton(row, 'dict-pack-redownload', t('dictPackRedownload'),
    (button) => sendDictPack('DICT_PACK_INSTALL', src, tgt, button, 'queued', 'dictPackRedownloadFailed'));
  return row;
}

// 删除不弹确认：删错了，这一行留着「重新下载」。列表跟着 storage.onChanged 更新。
async function sendDictPack(type, src, tgt, button, expected, failedKey) {
  button.disabled = true;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type, src, tgt });
  } catch (error) {
    // 消息没送到 service worker：那边没有日志，记在这一层。
    console.error(`[Blab Translation] ${type} failed`, `${src}-${tgt}`, error);
  }
  if (reply && reply.state === expected) return;
  // {error} 的回复已由 service worker 记过一次日志（带语言对和原始错误）；清单里
  // 没有这个语言对（absent）不算错误、没有日志。这里只告诉用户。
  showStatus(t(failedKey), 'error');
  button.disabled = false;
}

function setupDictPacks() {
  // 包装好、开始下载、失败、删除、拒收都是 service worker 写这几个键；第一次读回来之前
  // 到的变化，交给再读一次（读到的已经包含它）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!DICT_KEYS.some((key) => key in changes)) return;
    loadDictPacks();
  });
  loadDictPacks();
  // 上一个 worker 中途停下留下的「下载中」：收拾完它改写 dict:status，列表随之重画。
  chrome.runtime.sendMessage({ type: 'DICT_PACK_RECOVER' }).catch((error) => {
    console.error('[Blab Translation] DICT_PACK_RECOVER failed', error);
  });
}
