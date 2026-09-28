/**
 * 术语表的 CSV：导出、导入、导入预览。
 *
 * 双模经典脚本：服务工作者 import 它（导入时重新解析，不信设置页算出的结果），
 * 设置页用 <script> 装，挂在 globalThis.GlossaryCsv 上。内容脚本、popup、首装
 * 引导页不加载。加载时取走 Glossary，所以排在 shared/glossary.js 之后。
 *
 * 格式（RFC 4180）：
 *   source,target,case_sensitive,site,target_lang
 * 也收两列 source,target（其余取缺省：不区分大小写、所有网站、所有目标语言）。
 * 逗号、双引号、换行都可以出现在带引号的字段里，引号写两遍转义。导出写 UTF-8
 * BOM 和 CRLF；读的时候 BOM 可有可无，CRLF、LF 都认。
 *
 * 导入全有或全无：任何一行不合法就整份拒绝，抛 glossaryImportInvalid，错误上带
 * 第一个坏行的行号 row —— 按记录数（字段里的换行不另算一行），表头（第一条非空记录）也占行号，
 * 空行也占一个行号。整行都是空字段的记录跳过；同一份文件里两行是同一条
 * （Glossary.dedupeKey 相同），后一行算坏行。
 */
(function (root) {
  'use strict';

  const Glossary = root.Glossary;
  if (!Glossary) throw new Error('glossary-csv.js 要先装 shared/glossary.js');

  const COLUMNS = ['source', 'target', 'case_sensitive', 'site', 'target_lang'];
  const BOM = String.fromCharCode(0xfeff);

  function rowInvalid(row, cause) {
    const error = new Error('glossaryImportInvalid', cause ? { cause } : undefined);
    error.row = row;
    return error;
  }

  // ------------------------------------------------------------ 切记录

  /**
   * 文本 → 记录数组，每条记录是字段数组。引号不配对、引号后面跟着别的字符、
   * 不带引号的字段里出现引号，都抛 glossaryImportInvalid，行号是那条记录的序号。
   */
  function records(text) {
    const out = [];
    let fields = [];
    let field = '';
    let quoted = false; // 这个字段是带引号写的
    let inQuotes = false; // 正在引号里面
    let i = text.startsWith(BOM) ? 1 : 0;

    const endField = () => {
      fields.push(field);
      field = '';
      quoted = false;
    };
    const endRecord = () => {
      endField();
      out.push(fields);
      fields = [];
    };

    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          const next = text[i];
          if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') throw rowInvalid(out.length + 1);
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        if (field !== '' || quoted) throw rowInvalid(out.length + 1);
        quoted = true;
        inQuotes = true;
        i += 1;
      } else if (ch === ',') {
        endField();
        i += 1;
      } else if (ch === '\r' || ch === '\n') {
        endRecord();
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      } else {
        field += ch;
        i += 1;
      }
    }
    if (inQuotes) throw rowInvalid(out.length + 1);
    // 结尾没有换行时最后一条记录还没收；有换行时这里只剩一个空字段，不算一行。
    if (fields.length || field !== '' || quoted) endRecord();
    return out;
  }

  const blank = (record) => record.every((cell) => cell.trim() === '');

  // 整条记录（两列或五列）逐格等于表头的名字，才算表头。只看第一格的话，一个
  // 原文就叫 source 的词条会被当表头吞掉。
  function isHeader(record) {
    if (record.length !== 2 && record.length !== COLUMNS.length) return false;
    return record.every((cell, index) => cell.trim().toLowerCase() === COLUMNS[index]);
  }

  // '' / 0 / false 不区分，1 / true 区分（不分大小写）；别的都是坏行。
  function caseFlag(cell) {
    const value = cell.trim().toLowerCase();
    if (value === '1' || value === 'true') return 1;
    if (value === '' || value === '0' || value === 'false') return 0;
    return null;
  }

  // ------------------------------------------------------------ 读

  /**
   * CSV 文本 → 规范化后的词条（不带 id、不带 u）。任何一行不合法就抛
   * glossaryImportInvalid，error.row 是那一行的行号。
   */
  function parse(text) {
    if (typeof text !== 'string') throw rowInvalid(1);
    const rows = records(text);
    const entries = [];
    const seen = new Set();
    // 表头只可能是第一条非空记录：文件开头的空行也占行号，但不能让后面那行表头
    // 被当成一条原文叫 source 的词条。
    let first = true;
    rows.forEach((record, index) => {
      const row = index + 1;
      if (blank(record)) return;
      const leading = first;
      first = false;
      if (leading && isHeader(record)) return;
      if (record.length !== 2 && record.length !== COLUMNS.length) throw rowInvalid(row);
      const [source, target, caseCell = '', site = '', lang = ''] = record;
      const c = caseFlag(caseCell);
      if (c === null) throw rowInvalid(row);
      let entry;
      try {
        entry = Glossary.validateEntry({ s: source, t: target, c, h: site.trim(), l: lang.trim() });
      } catch (error) {
        throw rowInvalid(row, error);
      }
      const key = Glossary.dedupeKey(entry);
      if (seen.has(key)) throw rowInvalid(row);
      seen.add(key);
      entries.push(entry);
    });
    return entries;
  }

  /**
   * 一份 CSV 并进当前词条会怎样：{entries（合并后的全部）, added, replaced}，或
   * 抛 glossaryImportInvalid / glossaryEntryTooLarge / glossaryBudgetFull。
   * 同一个 dedupeKey 就替换并沿用原来的 id；导入的每一条 u 都取 now。没被文件动
   * 过的条目还是原来那个对象，SW 靠这一点只写动过的。
   *
   * SW 的导入（Glossary 的 import 写入）和设置页的预览都只走这一个函数。
   */
  function mergeImport(existing, text, now) {
    const incoming = parse(text).map((entry) => Object.assign(entry, { u: now }));
    const merged = Glossary.merge(existing, incoming, Glossary.dedupeKey);
    Glossary.assertFits(merged.entries);
    return merged;
  }

  /** 设置页卡片和整份导入共用的预览：{added, replaced}。 */
  function previewImport(current, text) {
    const { added, replaced } = mergeImport(current, text, Date.now());
    return { added, replaced };
  }

  // ------------------------------------------------------------ 写

  // 含逗号、引号、换行的字段加引号，引号写两遍。
  function cell(value) {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // 导出的顺序固定：原文（不分大小写）、站点、目标语言，同一份词表每次导出一样。
  function exportOrder(a, b) {
    const x = [a.s.toLowerCase(), a.s, a.h || '', a.l || Glossary.ANY_LANG];
    const y = [b.s.toLowerCase(), b.s, b.h || '', b.l || Glossary.ANY_LANG];
    for (let i = 0; i < x.length; i += 1) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  }

  /** 词条 → CSV 文本：BOM、五列表头、CRLF。id 和 u 不导出。 */
  function serialize(entries) {
    const lines = [COLUMNS.join(',')];
    for (const entry of entries.slice().sort(exportOrder)) {
      lines.push([
        cell(entry.s),
        cell(entry.t || ''),
        entry.c ? '1' : '0',
        cell(entry.h || ''),
        cell(entry.l || Glossary.ANY_LANG),
      ].join(','));
    }
    return BOM + lines.join('\r\n') + '\r\n';
  }

  /** blab-glossary-YYYYMMDD.csv，取本地日期。 */
  function fileName(now) {
    const date = now || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `blab-glossary-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.csv`;
  }

  root.GlossaryCsv = {
    COLUMNS,
    parse,
    mergeImport,
    previewImport,
    serialize,
    fileName,
  };
})(globalThis);
