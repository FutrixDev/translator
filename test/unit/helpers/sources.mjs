import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

/**
 * 一个「面」的全部源码，按文件名排序拼起来。
 *
 * 下面那些断言问的是「这一面有没有做某件事」，不是「某个文件里有没有某一行」——
 * 自从一个两千行的文件拆成一组模块，后者就只是前者的一种偶然写法了。
 *
 * 要断言的确实是**入口文件本身**（比如 shared/*.js 的装载顺序），就照旧直接读那个
 * 文件，别用这个。
 */
function surfaceSource(dir, matches) {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs)
    .filter(matches)
    .sort()
    .map((name) => readFileSync(path.join(abs, name), 'utf8'))
    .join('\n');
}

/** service worker 全体：background/*.js。新增模块会自动进来，不用改测试。 */
export function workerSource() {
  return surfaceSource('background', (name) => name.endsWith('.js'));
}

/**
 * 设置页全体：options/options*.js（options.js 自己也在内）。
 *
 * 这一页按卡片拆成了一组同级脚本，共用一个全局词法作用域 —— 哪个函数落在哪个
 * 文件里是排版，不是契约。
 */
export function optionsSource() {
  return surfaceSource('options', (name) => /^options.*\.js$/.test(name));
}

/**
 * 弹窗全体：popup/*.js（popup.js 与 popup-pdf.js 等同级脚本，共用一个全局词法作用域）。
 */
export function popupSource() {
  return surfaceSource('popup', (name) => name.endsWith('.js'));
}

/**
 * 界面文案全体：十门语言的表（i18n/lang/*.js）加上 i18n/messages.js 自己。
 *
 * 「这句话所有语言都有吗」问的是这一面，不是某个文件 —— 表拆开之后，某个 key 落
 * 在哪个文件里只由它是哪门语言决定。
 */
export function messagesSource() {
  return [surfaceSource('i18n/lang', (name) => name.endsWith('.js')),
          readFileSync(path.join(ROOT, 'i18n/messages.js'), 'utf8')].join('\n');
}

/**
 * 装好的那份文案目录（globalThis.I18N_MESSAGES）。
 *
 * 以前有两处 `new Function(repoFile('i18n/messages.js'))()` —— 表还在同一个文件
 * 里的时候那样能跑，现在跑出来是一张空表：new Function 的作用域里没有 require，
 * messages.js 的 Node 自装那一段不会触发。问目录就直接 require 它。
 */
export function messageCatalog() {
  return require('../../../i18n/messages.js').I18N_MESSAGES;
}

/**
 * 内容脚本注入的那一整张样式表：content/css/ 下的十二份，按 **manifest 里的顺序**
 * 接起来。
 *
 * 顺序就是层叠顺序 —— light-theme.css 整份都靠「排在被它覆盖的那些后面」工作，
 * 按文件名排会把它挪到 input-dialog 前面去，于是这里读到的层叠和浏览器里的不是
 * 同一张表。所以清单从 manifest 读，不在这里重抄。
 */
export function contentCss() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  return manifest.content_scripts
    .flatMap((cs) => cs.css || [])
    .map((rel) => readFileSync(path.join(ROOT, rel), 'utf8'))
    .join('\n');
}

/**
 * 漫画翻译全体：content/comic/*.js 加上入口 content/content-comic-translation.js。
 *
 * 「这个功能有没有自己去做某件事」问的是这一族 —— 认页、台账、覆盖层、任务记忆、
 * 文案分在五个文件里，哪个函数落在哪一份是排版，不是契约。
 */
export function comicSource() {
  return [surfaceSource('content/comic', (name) => name.endsWith('.js')),
          readFileSync(path.join(ROOT, 'content/content-comic-translation.js'), 'utf8')].join('\n');
}

/**
 * 字幕引擎全体：content/captions/*.js 加上入口 content/content-video-captions.js。
 *
 * 「引擎有没有做某件事」问的是这一族 —— 开关状态、覆盖层、翻译、启用字幕分在四个
 * 文件里，哪个函数落在哪一份是排版，不是契约。
 *
 * 要断言的是**装载顺序**（谁在 manifest 里排在谁前面），照旧去读 manifest.json。
 */
export function captionEngineSource() {
  return [surfaceSource('content/captions', (name) => name.endsWith('.js')),
          readFileSync(path.join(ROOT, 'content/content-video-captions.js'), 'utf8')].join('\n');
}

/**
 * 悬停/划选翻译全体：content/hover/*.js 加上入口 content/content-hover-translation.js。
 *
 * 「这条路有没有做某件事」问的是这一族 —— 翻哪一块、行内台账、公式、划选、渲染分
 * 在五个文件里，哪个函数落在哪一份是排版，不是契约。
 */
export function hoverSource() {
  return [surfaceSource('content/hover', (name) => name.endsWith('.js')),
          readFileSync(path.join(ROOT, 'content/content-hover-translation.js'), 'utf8')].join('\n');
}

/**
 * 翻译引擎全体：content/engine/*.js 加上入口 content/content-translation-engine.js。
 *
 * 「引擎有没有做某件事」问的是这一族 —— 语言码与源语言、看门狗、选后端与预算闸
 * 分在三个文件里，哪个函数落在哪一份是排版，不是契约。
 */
export function engineSource() {
  return [surfaceSource('content/engine', (name) => name.endsWith('.js')),
          readFileSync(path.join(ROOT, 'content/content-translation-engine.js'), 'utf8')].join('\n');
}

/**
 * manifest 里某个内容脚本 bundle 的 js 清单。装载顺序的断言从这里取。
 */
export function contentBundle(marker = 'content/content-utils.js') {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const bundle = manifest.content_scripts.find((cs) => (cs.js || []).includes(marker));
  if (!bundle) throw new Error(`没有哪个 content_scripts 装了 ${marker}`);
  return bundle.js;
}

/**
 * 一族文件在 manifest 里的全部位置：content/<dir>/ 下的每一份，加上入口。
 *
 * 「X 要排在悬停翻译前面」这类断言，拆族之后问的是「排在这一族的每一份前面」——
 * 只比对入口文件会漏掉真正先装载的那几份。
 */
export function familyPaths(dir, entry) {
  const abs = path.join(ROOT, dir);
  return [...readdirSync(abs).filter((n) => n.endsWith('.js')).sort().map((n) => `${dir}/${n}`), entry];
}
