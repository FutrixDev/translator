// Blab Translation — 「这个网址是一份 PDF 吗」，以及「它该叫什么名字」。
//
// 两句话，四个读者：服务工作者的右键菜单和任务层（background/pdf-jobs.js）、
// popup 与上传页共用的 pdf/pdf-ui.js、以及 PDF 文档上那条提示条所在的内容脚本。
//
// 从前只有前两个，于是它被抄了两份 —— pdf-ui.js 里那份还留着一行「Mirrors
// isLikelyPdfUrl in background/background.js」的注释，而那个函数早就搬去
// pdf-jobs.js 了。注释指着一个不存在的地方，正是两份副本开始分叉的样子。第三个
// 读者出现时把它收成一份：一个判断要在第二个地方重说一遍，就说明它待错了层。
//
// 判断故意比「取到 Content-Type 再说」宽松：这四处都要在**发请求之前**回答，
// 右键菜单画不画那一项、提示条露不露面，都不能先去下载一遍文档。
//
// 内容脚本、options、popup、上传页都用 <script> 标签装，所以挂在全局上而不是
// export；服务工作者那边 `import` 它，再从 globalThis 上取（和 ChargeConfirm、
// AI_TRANSLATOR_PDF_ERRORS 一个路子）。
(function (root) {
  'use strict';

  function isLikelyPdfUrl(url) {
    if (!url) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!/^(https?|file):$/.test(parsed.protocol)) return false;
    if (/\.pdf$/i.test(parsed.pathname)) return true;
    // arXiv serves PDFs from extensionless /pdf/<id> paths.
    if (/(^|\.)arxiv\.org$/i.test(parsed.hostname) && /^\/pdf\//.test(parsed.pathname)) return true;
    return false;
  }

  function pdfFileNameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      if (segment) return /\.pdf$/i.test(segment) ? segment : `${segment}.pdf`;
    } catch {
      // Fall through to the generic name.
    }
    return 'document.pdf';
  }

  root.PdfUrl = { isLikelyPdfUrl, pdfFileNameFromUrl };
})(globalThis);
