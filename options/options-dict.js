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
// 标记）和 `dict:status`（正在下载 / 下载失败）。写一律交给 service worker 的单写者
// 队列（DICT_PACK_DELETE），这一页不碰 `d:` 键，此后跟着 storage.onChanged 重读。

// { packs, status }，读回来之前是 null。
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
    found = await chrome.storage.local.get([DictPack.PACKS_KEY, DictPack.STATUS_KEY]);
  } catch (error) {
    console.error('[Blab Translation] dictionary packs: reading the list failed', error);
    return;
  }
  // 两次读交错回来时，只认后发的那一次。
  if (seq !== dictReadSeq) return;
  dictState = { packs: found[DictPack.PACKS_KEY] || {}, status: found[DictPack.STATUS_KEY] || {} };
  drawDictPacks();
}

/** 按 dictState 重画列表：已装的包和正在下载 / 失败的语言对，按语言对排序。 */
function drawDictPacks() {
  if (!dictState) return;
  const { packs, status } = dictState;
  const pairs = [...new Set([...Object.keys(packs), ...Object.keys(status)])].sort();
  const rows = pairs.map((pair) => dictPackRow(packs[pair], status[pair], pair));
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'dict-pack-empty';
    empty.textContent = t('dictPacksEmpty');
    rows.push(empty);
  }
  dictElements.list.replaceChildren(...rows);
}

// 一行：语言对、体积 / 词条数 / 版本（已装时）、下载状态（有时）、删除。
function dictPackRow(item, status, pair) {
  const [src, tgt] = item ? [item.src, item.tgt] : splitDictPair(pair);
  const row = document.createElement('div');
  row.className = 'dict-pack';
  row.dataset.pair = pair;

  const name = document.createElement('span');
  name.className = 'dict-pack-name';
  name.textContent = TargetLang.pairName(src, tgt, currentUILang);
  row.appendChild(name);

  if (item) {
    const meta = document.createElement('span');
    meta.className = 'dict-pack-meta';
    meta.textContent = fill(t('dictPackMeta'), {
      size: DocJobs.megabyteLabel(item.bytes),
      heads: item.heads.toLocaleString(currentUILang),
      ver: item.ver,
    });
    row.appendChild(meta);
  }

  if (status) {
    const state = document.createElement('span');
    state.className = `dict-pack-state dict-pack-${status.state}`;
    state.textContent = t(status.state === 'failed' ? 'dictPackFailed' : 'dictPackDownloading');
    row.appendChild(state);
  }

  // 下载中的语言对没有可删的东西：删除排在队列里那个下载之后，删完它又不在了。
  if (item || (status && status.state === 'failed')) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-text dict-pack-delete';
    remove.textContent = t('dictPackDelete');
    remove.addEventListener('click', () => removeDictPack(src, tgt, remove));
    row.appendChild(remove);
  }
  return row;
}

// dict:status 的键是 pairOf(src, tgt)；目标语言可能自带连字符（zh-CN），源语言也
// 可能（zh-CN → en），所以按已知语言码拆，不按第一个连字符拆。
function splitDictPair(pair) {
  for (const src of DictPack.LANGS) {
    const tgt = pair.slice(src.length + 1);
    if (pair.startsWith(`${src}-`) && DictPack.LANGS.includes(tgt)) return [src, tgt];
  }
  throw new Error(`dictionary packs: ${pair} is not a language pair`);
}

// 不弹确认：删错了，下次在这个语言对里查词会再下载。列表跟着 storage.onChanged 更新。
async function removeDictPack(src, tgt, button) {
  button.disabled = true;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'DICT_PACK_DELETE', src, tgt });
  } catch (error) {
    // 消息没送到 service worker：那边没有日志，记在这一层。
    console.error('[Blab Translation] DICT_PACK_DELETE failed', `${src}-${tgt}`, error);
  }
  if (reply && reply.state === 'deleted') return;
  // {error} 的回复已由 service worker 记过一次日志（带语言对和原始错误），这里只告诉用户。
  showStatus(t('dictPackDeleteFailed'), 'error');
  button.disabled = false;
}

function setupDictPacks() {
  // 包装好、开始下载、失败、删除都是 service worker 写这两个键；第一次读回来之前
  // 到的变化，交给再读一次（读到的已经包含它）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(DictPack.PACKS_KEY in changes) && !(DictPack.STATUS_KEY in changes)) return;
    loadDictPacks();
  });
  loadDictPacks();
}
