// 批量翻译的段落分隔符只有一份（shared/batch-delimiter.js，P1-D）。
//
// 它曾经散在五处：内容侧两处定义、随消息带到 SW、SW 两处缺省（其中一处还是另一
// 个值）。现在 SW 拼提示词、切译文、术语表拒收词条都读 globalThis.BATCH_DELIMITER，
// 消息里不再带它。这一组扫产品源码：字面量只准出现在那一个文件里，内容侧的消息
// 不再有 delimiter 字段，SW 在用它的模块之前装它。
//
// 这里自己也不写字面量：由码点拼出来，否则这份测试就是第二个写入点。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { productSourceFiles, repoSource } from './helpers/sources.mjs';

const OPEN = String.fromCharCode(0x27EA);
const CLOSE = String.fromCharCode(0x27EB);
const OWNER = 'shared/batch-delimiter.js';

test('batch-delimiter: the brackets appear in exactly one product file', () => {
  const files = productSourceFiles();
  assert.ok(files.includes(OWNER), `${OWNER} is not tracked`);
  const carriers = files.filter((rel) => {
    const source = repoSource(rel);
    return source.includes(OPEN) || source.includes(CLOSE);
  });
  assert.deepEqual(carriers, [OWNER], '分隔符的字面量只准写在 shared/batch-delimiter.js');
});

test('batch-delimiter: globalThis.BATCH_DELIMITER is the three bracket pairs', async () => {
  await import('../../shared/batch-delimiter.js');
  assert.equal(globalThis.BATCH_DELIMITER, (OPEN + CLOSE).repeat(3));
});

test('batch-delimiter: no content-side message carries a delimiter field any more', () => {
  const offenders = productSourceFiles()
    .filter((rel) => rel.startsWith('content/') || rel.startsWith('shared/'))
    .filter((rel) => /\bdelimiter\s*:/.test(repoSource(rel)));
  assert.deepEqual(offenders, [], '分隔符不随消息走：SW 自己读 globalThis.BATCH_DELIMITER');
});

test('batch-delimiter: the service worker imports it before the modules that read it', () => {
  const worker = repoSource('background/background.js');
  const at = (spec) => worker.indexOf(`import '${spec}';`);
  assert.notEqual(at('../shared/batch-delimiter.js'), -1, 'background.js 不装分隔符');
  // glossary.js 在加载时取走它；ai-translate.js 在调用时读，经 background.js 的
  // 静态 import 链装进来，也排在它后面。
  assert.ok(at('../shared/batch-delimiter.js') < at('../shared/glossary.js'));
  const readers = productSourceFiles()
    .filter((rel) => rel !== OWNER && repoSource(rel).includes('BATCH_DELIMITER'));
  assert.deepEqual(readers.sort(), ['background/ai-translate.js', 'background/background.js', 'shared/glossary.js'],
    '读分隔符的产品文件只有这几份；新增一份要先确认它的装载清单排在 batch-delimiter.js 后面');
});
