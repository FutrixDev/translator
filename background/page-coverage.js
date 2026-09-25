// Blab Translation — 整页翻译覆盖面：service worker 这一半
//
// 两件事，都只服务于内容脚本的整页翻译：
//
// 1. GET_SHADOW_STYLES：shadow root 里的译文拿不到 manifest 注入的样式表（那些
//    只进文档，不进 shadow 树）。内容脚本（content/page/shadow.js）在第一次往某个
//    root 里插译文时来要一份样式文本，自己装进那个 root。SW 用 fetch 读自家包里的
//    文件——扩展自己读自己的文件不需要 web_accessible_resources。
// 2. translate-whole-page（Alt+W）：本页临时改成整页范围再翻。只发给顶层 frame：
//    子 frame 各自的覆盖值由顶层的手动轮带下去（设计 §2），这里不替它们做主。
//
// 两个监听都是独立注册的，只认自己的那一条：别的消息既不回话也不 return true
// ——回一个 undefined 会抢在真正的处理者前面把通道关掉。

// 注入到文档、且定义了 shadow 里译文要用的类的样式表。单测守着：凡是
// content_scripts 注入的 CSS 里写了这些类的文件，都必须列在这里。
export const SHADOW_STYLE_FILES = Object.freeze(['content/css/translation.css']);

// 文档里的规则写成 `html body .x`，好压过页面的单类名规则（CLAUDE.md
// 「Host-page containment」）。shadow 树里没有 html / body，这个前缀会让规则
// 一条都匹配不上；页面样式也进不了 shadow 树，所以去掉前缀不会输掉特异度。
//
// 唯一的一条改写规则：选择器以一个 `html<C>` 复合选择器开头（C 为空，或只由
// `[...]` 属性选择器和括号配平的 `:not(...)` 组成），后面可以跟一个 `body`，再
// 跟后代组合子（空白）。
//   - C 为空：整段前缀去掉（`html body .a` → `.a`）；
//   - C 非空：前缀换成 `:host-context(html<C>) `，body 丢掉。条件挂在文档的
//     <html> 上（译文样式、仅显示译文），shadow 里要靠 :host-context 往外看。
// 只认出现在串首、空白、`,`、`{`、`}` 之后的 html：@media 里缩进的那行、逗号
// 列表的第二项都在内；`.xhtml body`、`html-foo` 不动。
const HTML_AT = /(^|[\s,{}])html(?![\w-])/g;

// 从 open（`[` 或 `(`）起找到配平的收口，引号里的括号不算。找不到返回 -1。
function closeOf(css, start) {
  const open = css[start];
  const close = open === '[' ? ']' : ')';
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === open) {
      depth++;
    } else if (ch === close && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// `html` 之后的 C 到哪儿结束（只吃属性选择器与 :not(...)）。
function compoundEnd(css, from) {
  let i = from;
  for (;;) {
    let end = -1;
    if (css[i] === '[') end = closeOf(css, i);
    else if (css.startsWith(':not(', i)) end = closeOf(css, i + 4);
    if (end === -1) return i;
    i = end + 1;
  }
}

export function toShadowCss(text) {
  const css = String(text || '');
  let out = '';
  let copied = 0;
  for (const match of css.matchAll(HTML_AT)) {
    const start = match.index + match[1].length;
    if (start < copied) continue;
    const compound = compoundEnd(css, start + 4);
    const gap = /^\s+(?:body\s+)?/.exec(css.slice(compound));
    if (!gap) continue;
    const rest = compound + gap[0].length;
    // 后代组合子之后得是下一个复合选择器：`html {`、`html > x`、`html body{` 不是这条规则。
    if (/^(?:[>+~,{]|body(?![\w-]))/.test(css.slice(rest))) continue;
    const condition = css.slice(start + 4, compound);
    out += css.slice(copied, start) + (condition ? `:host-context(html${condition}) ` : '');
    copied = rest;
  }
  return out + css.slice(copied);
}

let cssPromise = null;

function loadShadowCss() {
  if (!cssPromise) {
    cssPromise = Promise.all(SHADOW_STYLE_FILES.map((path) =>
      fetch(chrome.runtime.getURL(path)).then((response) => {
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return response.text();
      })))
      .then((texts) => toShadowCss(texts.join('\n')))
      .catch((error) => {
        // 失败不缓存：下一次插入会再来要。
        cssPromise = null;
        console.log('Blab Translation: shadow styles unavailable', error && error.message);
        return '';
      });
  }
  return cssPromise;
}

export function handleMessage(message, _sender, sendResponse) {
  if (!message || message.type !== 'GET_SHADOW_STYLES') return undefined;
  loadShadowCss().then((css) => sendResponse({ css }));
  return true;
}

// 写法同 background.js 里 Alt+A 的处理器：没有接收方（chrome:// 页、脚本还没
// 注入完的标签页）时 sendMessage 会 reject，一个按不动的快捷键本来就该安静。
export async function handleCommand(command, tab) {
  if (command !== 'translate-whole-page') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target || typeof target.id !== 'number') return;
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'TRANSLATE_WHOLE_PAGE' }, { frameId: 0 });
  } catch (error) {
    console.log('Blab Translation: whole-page shortcut had no receiver', error && error.message);
  }
}

// 单测直接 import 这个文件取纯函数，那里没有 chrome 全局。
if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleMessage);
  chrome.commands.onCommand.addListener(handleCommand);
}
