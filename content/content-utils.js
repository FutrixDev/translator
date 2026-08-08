// AI Translator Content Script Utilities
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  ctx.escapeHtml = function(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  // ==================== 受管 DOM 容器 ====================

  // 富文本编辑器把自己的子树和内部 EditorState 对账：Lexical、ProseMirror、Slate
  // 等都挂着 MutationObserver，发现子树里出现了它不认识的节点，就按内部状态重建
  // 这一段 DOM —— 我们插进去的译文会在一帧之内被删掉。
  //
  // 后果不只是“看不到译文”：源块上的 ai-translator-inline-source 标记还留着，
  // 扩展认为这块已经翻过了，再次悬停也不会重试，于是表现为“悬停翻译完全没反应”。
  //
  // 关键是 contenteditable 判断挡不住这类容器。编辑器处于只读模式时属性是
  // contenteditable="false"，isContentEditable 为 false，照样会撤销外来节点
  // （Higgsfield 的文章正文 div.rde-content 就是这样：data-lexical-editor="true" +
  // contenteditable="false" + aria-readonly="true"）。
  //
  // 这里只收“框架托管但不可编辑”的情形。真正可编辑的输入面（contenteditable="true"、
  // input/textarea）是另一回事 —— 那种地方压根就不该翻译，由各调用方自己的
  // isContentEditable / isEditableTarget 判断先一步挡掉。
  const MANAGED_DOM_ROOT_SELECTOR = [
    '[data-lexical-editor]',   // Lexical (Meta)
    '.ProseMirror',            // ProseMirror / TipTap
    '[data-slate-editor]',     // Slate
    '.ql-editor',              // Quill
    '.cm-content',             // CodeMirror 6
    '.CodeMirror-code',        // CodeMirror 5
    '.monaco-editor'           // Monaco
  ].join(', ');

  // 选择器本身不导出：调用方问的都是“这个元素在不在受管容器里”，把名单递出去只会
  // 让别的文件各自 querySelectorAll 一遍，规则就从这里漏出去了。

  // 返回 element 所在的受管容器根节点，不在受管容器里则返回 null。
  ctx.getManagedDomRoot = function(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (typeof element.closest !== 'function') return null;
    return element.closest(MANAGED_DOM_ROOT_SELECTOR);
  };

  ctx.isInsideManagedDomRoot = function(element) {
    return !!ctx.getManagedDomRoot(element);
  };

  ctx.copyToClipboard = async function(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };
})();
