// Blab Translation — 划词卡片的「加入术语表」（P1-C C4）
//
// 按钮在卡片的动作行里（content-popup.js 的 buildPopupMarkup，换引擎和复制之间），
// 这里管它什么时候露出、点了展开的小表单、保存。
//
//   - 露出：content-popup.js 的 settleCardActions 每次结算先同步调 settle()。这次
//     出了译文、原文规范化后 1–80 字才露；露出之后重译、换引擎期间原样不动（请求
//     在路上时只禁用，不先藏再露 —— 动作行会折行，见 J-D9），结算失败才藏。
//   - 表单：在卡片之内（.ai-translator-popup 的子元素，放在内容区和动作行之间），
//     不是新的面板根，所以不进 popup.css 的 :is() 列表。请求一发出就收起：它预填
//     的是上一次的译文。
//   - 保存：Glossary.request('put')。「仅本站」只带 scope: 'site'，**不带 h** ——
//     站点由服务工作者按 sender.tab.url 重算（shared/glossary.js 的 senderSite），
//     子帧里也是顶层的站点；「所有网站」什么 scope 都不带（D-381）。这里印的主机只
//     给人看：ctx.frames.topHost()（顶层帧是本页，子帧是顶层指令里的 host，还没拿到
//     指令就是空串，只给「所有网站」）。
//   - 不在客户端校验长度：超限的译文照样预填、照样送出，由服务工作者按同一份
//     Glossary.LIMITS 拒绝，错误键在表单里显示，表单不收。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const { t } = ctx;
  const Glossary = globalThis.Glossary;

  // 按钮只接一次线：同一个按钮会结算很多次（重译、换引擎、换语言）。
  const wired = new WeakSet();

  function parts(popup) {
    return {
      btn: popup.querySelector('.ai-translator-add-term'),
      form: popup.querySelector('.ai-translator-term-form'),
    };
  }

  function setLabel(btn, key) {
    btn.querySelector('.ai-translator-btn-label').textContent = t(key);
  }

  function termSource(popup) {
    return Glossary.normalizeSource(popup.dataset.sourceText || '');
  }

  function offered(popup) {
    const length = termSource(popup).length;
    return length > 0 && length <= Glossary.LIMITS.source;
  }

  /** 收起表单（请求一发出、取消、保存成功、按钮藏起时）。 */
  function collapse(popup) {
    const { btn, form } = parts(popup);
    if (form) form.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  /**
   * 每次结算（content-popup.js 的 settleCardActions 第一句）：这次出了译文、原文
   * 长度合格才露。按钮上的「已加入 / 已更新已有词条」对的是保存时这张卡的目标语言，
   * 换了目标语言就回到「加入术语表」—— 那一条词条管不到新语言。
   */
  function settle(popup, translated) {
    const { btn } = parts(popup);
    const show = translated && offered(popup);
    btn.hidden = !show;
    if (!show) {
      collapse(popup);
      return;
    }
    if (!wired.has(btn)) {
      wired.add(btn);
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => toggle(popup));
    }
    if (btn.dataset.savedLang !== popup.dataset.targetLang) {
      delete btn.dataset.savedLang;
      setLabel(btn, 'glossaryAdd');
    }
    btn.disabled = false;
  }

  function toggle(popup) {
    const { form } = parts(popup);
    if (form && !form.hidden) collapse(popup);
    else open(popup);
  }

  // 表单第一次展开时才建，建一次。骨架只有我们自己的文案，写成标记（popup.css 的
  // 控件守卫 test/unit/host-css-containment.test.mjs 按标记认控件）；用户数据 ——
  // 原文、译文、主机 —— 一律在 open() 里走 textContent / value，不拼进 HTML。
  function buildForm(popup) {
    const form = document.createElement('div');
    form.className = 'ai-translator-term-form';
    form.hidden = true;
    form.innerHTML = `
      <div class="ai-translator-term-row">
        <span class="ai-translator-term-label">${t('glossarySource')}</span>
        <div class="ai-translator-term-source"></div>
      </div>
      <label class="ai-translator-term-row">
        <span class="ai-translator-term-label">${t('glossaryTarget')}</span>
        <input class="ai-translator-term-input" type="text">
      </label>
      <label class="ai-translator-term-row">
        <span class="ai-translator-term-label">${t('glossarySite')}</span>
        <select class="ai-translator-term-scope"></select>
      </label>
      <div class="ai-translator-term-error" role="alert" hidden></div>
      <div class="ai-translator-term-buttons">
        <button class="ai-translator-btn ai-translator-term-cancel" type="button">${t('glossaryCancel')}</button>
        <button class="ai-translator-btn ai-translator-term-save" type="button">${t('glossarySave')}</button>
      </div>
    `;
    form.querySelector('.ai-translator-term-cancel').addEventListener('click', () => {
      collapse(popup);
      parts(popup).btn.focus();
    });
    form.querySelector('.ai-translator-term-save').addEventListener('click', () => submit(popup));
    form.querySelector('.ai-translator-term-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submit(popup);
      }
    });
    popup.insertBefore(form, popup.querySelector('.ai-translator-actions'));
    return form;
  }

  function fillScope(select) {
    const host = ctx.frames.topHost();
    const options = [];
    if (host) options.push(['site', t('glossaryScopeSite').replace('{host}', host)]);
    options.push(['all', t('glossaryScopeAll')]);
    select.replaceChildren(...options.map(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      return option;
    }));
    select.value = options[0][0];
  }

  // 这一次表单对的是哪条原文、哪门目标语言：展开时定下，保存时不再读卡片。
  const drafts = new WeakMap();

  function open(popup) {
    const form = parts(popup).form || buildForm(popup);
    const draft = { s: termSource(popup), l: popup.dataset.targetLang };
    drafts.set(form, draft);
    form.querySelector('.ai-translator-term-source').textContent = draft.s;
    const translation = popup.querySelector('.ai-translator-translation-text');
    const input = form.querySelector('.ai-translator-term-input');
    input.value = translation ? translation.textContent : '';
    fillScope(form.querySelector('.ai-translator-term-scope'));
    showError(form, '');
    form.querySelector('.ai-translator-term-save').disabled = false;
    form.hidden = false;
    parts(popup).btn.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  function showError(form, message) {
    const error = form.querySelector('.ai-translator-term-error');
    error.textContent = message;
    error.hidden = !message;
  }

  async function submit(popup) {
    const { btn, form } = parts(popup);
    const save = form.querySelector('.ai-translator-term-save');
    if (save.disabled) return;
    const draft = drafts.get(form);
    const entry = { s: draft.s, t: form.querySelector('.ai-translator-term-input').value, l: draft.l };
    if (Glossary.caseSensitiveByDefault(draft.s)) entry.c = 1;
    const site = form.querySelector('.ai-translator-term-scope').value === 'site';
    save.disabled = true;
    showError(form, '');
    try {
      const { replaced } = await Glossary.request('put', { entry, ...(site ? { scope: 'site' } : {}) });
      btn.dataset.savedLang = draft.l;
      setLabel(btn, replaced ? 'glossaryUpdated' : 'glossaryAdded');
      collapse(popup);
      btn.focus();
    } catch (error) {
      console.error('Blab Translation: adding a glossary term from the card failed', error);
      showError(form, t(Glossary.userErrorKey(error) || 'glossarySaveFailed'));
    } finally {
      save.disabled = false;
    }
  }

  ctx.addTerm = { settle, collapse };
})();
