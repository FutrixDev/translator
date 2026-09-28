// Blab Translation — 批量翻译的段落分隔符（唯一写入点）
//
// 快速批（TRANSLATE_BATCH_FAST）把多段原文用它连成一条送给模型，模型照样用它
// 隔开各段译文，SW 再按它切回去。它曾经散在五处各写一份（内容侧两处定义、
// 随消息传、SW 两处缺省，其中一处还是另一个值），现在只有这一份：
//   - SW 拼提示词、切译文读它；消息里不再带分隔符；
//   - 术语表拒绝含它的词条（shared/glossary.js 的 validateEntry）—— 模型照抄
//     词条译文时会把批量结果切乱。
// test/unit/batch-delimiter.test.mjs 扫描产品源码，别处再写出这个字面量就红。
//
// 双模经典脚本：服务工作者和单测 import 它，内容脚本、设置页用 <script> 装，
// 都从 globalThis.BATCH_DELIMITER 取。没有依赖。
(function (root) {
  'use strict';

  // Unicode 数学括号，正文里几乎不可能出现。
  root.BATCH_DELIMITER = '⟪⟫⟪⟫⟪⟫';
})(globalThis);
