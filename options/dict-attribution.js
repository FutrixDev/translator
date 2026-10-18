// Blab Translation —— 词典数据来源页（options/dict-attribution.html，设计 §6、D-570）
//
// 按本机 chrome.storage.local 的 `dict:packs` 列出每个已装包：语言对、版本、整包的
// 许可（链到包旁边的 LICENSE.txt）、署名文件（ATTRIBUTION.txt），以及包里每个数据
// 来源的名字、许可和主页。只读：装包、删包都在设置页，这一页跟着 storage.onChanged
// 重画。来源的 url 和署名的 href 在 DictPack.parsePack() 里已限定为 https。
(function () {
  'use strict';

  const { DictPack, TargetLang } = globalThis;
  const list = document.getElementById('dictAttributionList');
  let uiLang = 'en';
  let readSeq = 0;

  const t = (key) => getMessage(key, uiLang);

  function link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  function sourceRow(source) {
    const li = document.createElement('li');
    li.className = 'dict-attribution-source';
    li.append(link(source.url, source.name), ` · ${source.license}`);
    return li;
  }

  function packSection(item) {
    const section = document.createElement('section');
    section.className = 'settings-card dict-attribution-pack';
    section.dataset.pair = DictPack.pairOf(item.src, item.tgt);

    const title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = `${TargetLang.pairName(item.src, item.tgt, uiLang)} · ${item.ver}`;

    const sources = document.createElement('ul');
    sources.className = 'dict-attribution-sources';
    sources.append(...item.sources.map(sourceRow));

    const docs = DictPack.docUrls(item);
    const files = document.createElement('p');
    files.className = 'dict-attribution-files';
    files.append(
      // 冒号随语言（zh/ja 全角），所以整句模板交给 i18n。
      link(docs.license, t('dictAttributionLicense').split('{lic}').join(item.lic)),
      link(docs.attribution, t('dictAttributionFile')),
    );

    section.append(title, sources, files);
    return section;
  }

  async function draw() {
    const seq = ++readSeq;
    const packs = (await chrome.storage.local.get(DictPack.PACKS_KEY))[DictPack.PACKS_KEY] || {};
    if (seq !== readSeq) return;
    const items = Object.keys(packs).sort().map((pair) => packSection(packs[pair]));
    if (!items.length) {
      const none = document.createElement('p');
      none.className = 'dict-pack-empty';
      none.textContent = t('dictAttributionNone');
      items.push(none);
    }
    list.replaceChildren(...items);
  }

  async function init() {
    const settings = await chrome.storage.sync.get({ uiLanguage: '', theme: 'light' });
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
    uiLang = getUILanguage(settings.uiLanguage);
    document.documentElement.lang = uiLang;
    document.title = t('dictAttributionLink');
    document.getElementById('dictAttributionTitle').textContent = t('dictAttributionLink');
    document.getElementById('dictAttributionIntro').textContent = t('dictAttributionIntro');
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && DictPack.PACKS_KEY in changes) draw().catch(report);
    });
    await draw();
  }

  // 只有一层接：读设置或读包列表失败，记一次日志，页面停在没画完的样子。
  function report(error) {
    console.error('[Blab Translation] dictionary attribution page failed', error);
  }

  init().catch(report);
})();
