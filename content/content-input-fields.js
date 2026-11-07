// Blab Translation —— 输入框按钮的判定（D-1031/D-1032 §4.2、§4.4）：什么框算写作框、
// 多长才出按钮、contenteditable 是不是纯文本。芯片（content-input-chip.js）用它们
// 决定出不出现、语气项置不置灰；菜单（content-input-menu.js）只画选项，不判框。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 页面用 autocomplete 说了这个框装的是登录名、验证码、卡号：没有语言可言。
  // autocomplete 是一串记号（`shipping cc-number`、`section-a username`），逐个看。
  const NON_PROSE_AUTOCOMPLETE = new Set(['one-time-code', 'username', 'current-password', 'new-password']);
  const TEXTUAL_INPUT_TYPES = new Set(['text']);
  // 搜索框、联想框：敲的是查询词，不是要发给别人读的话（§4.2）。
  const QUERY_ROLES = new Set(['searchbox', 'combobox']);

  function isCredentialField(el) {
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return tokens.some((token) => token.startsWith('cc-') || NON_PROSE_AUTOCOMPLETE.has(token));
  }

  function isOurNode(el) {
    return !!el.closest('.ai-translator-popup, [id^="ai-translator"], [class*="ai-translator"]');
  }

  /**
   * 写作框（§4.2）：textarea、contenteditable、type=text（或没写 type）的单行框。
   * 排除 type=search、role=searchbox/combobox、带联想列表的单行框
   * （aria-autocomplete）和凭证框。aria-autocomplete 只对 <input> 算数：x.com 的
   * 发帖框（Draft）带 aria-autocomplete=list —— 它的联想是 @提及，框本身是写作框。
   */
  function isWritingField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.readOnly) return false;
    if (isOurNode(el)) return false;
    if (isCredentialField(el)) return false;
    if (QUERY_ROLES.has((el.getAttribute('role') || '').toLowerCase())) return false;

    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      if (!TEXTUAL_INPUT_TYPES.has((el.type || 'text').toLowerCase())) return false;
      const autocomplete = (el.getAttribute('aria-autocomplete') || 'none').toLowerCase();
      return autocomplete === 'none';
    }
    return el.isContentEditable === true;
  }

  const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const MIN_WORDS = 3;
  const MIN_CJK_CHARS = 10;

  /** 够不够长：至少 3 个词（含字母或数字的那种），或至少 10 个中日韩字（§4.2）。 */
  function longEnough(text) {
    const value = String(text || '');
    const cjk = value.match(CJK_CHARS);
    if (cjk && cjk.length >= MIN_CJK_CHARS) return true;
    const words = value.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    return words.length >= MIN_WORDS;
  }

  // 纯文本 contenteditable 里只会出现的元素：换行和段落。编辑器自己的包装
  // （Draft 的 div/span、Lexical 的 p/span）也只是这几种。
  const PLAIN_TAGS = new Set(['BR', 'P', 'DIV', 'SPAN']);

  function styledInline(el) {
    const style = el.style;
    if (!style) return false;
    const weight = style.fontWeight;
    return weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
      || style.fontStyle === 'italic'
      || /underline|line-through/.test(style.textDecoration || style.textDecorationLine || '');
  }

  /**
   * contenteditable 是不是只有纯文本（§4.4）：文本节点和 <br>/段落。链接、
   * @提及（contenteditable=false 的小块）、图片、加粗斜体都算格式 —— 整段替换会把
   * 它们抹成纯字，所以语气项置灰，翻译照常。原生框总是纯文本。
   */
  function plainEditable(field) {
    if (!field || field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') return true;
    for (const el of field.querySelectorAll('*')) {
      if (!PLAIN_TAGS.has(el.tagName)) return false;
      if (el.getAttribute('contenteditable') === 'false') return false;
      if (styledInline(el)) return false;
    }
    return true;
  }

  ctx.inputFields = { isWritingField, longEnough, plainEditable };
})();
