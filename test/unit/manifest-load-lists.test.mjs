// manifest 的每一张加载清单里，一个文件只出现一次（D-384 F2）。
//
// 内容脚本是共享一个全局词法环境的经典脚本：同一个文件加载两次，就是在一页里把
// 它的顶层再跑一遍 —— `const` 重复声明直接抛（文件抛了也只是静静地失败，见
// CLAUDE.md），`Object.freeze` 过的全局被第二份替换，谁先拿到了第一份就和后来者
// 各拿各的。P1-C 曾把 shared/prompt-addenda.js 在 content_scripts 里列了两次。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

function duplicates(list) {
  return list.filter((item, index) => list.indexOf(item) !== index);
}

test('no content_scripts entry lists a script or a stylesheet twice', () => {
  assert.ok(manifest.content_scripts.length > 0);
  manifest.content_scripts.forEach((entry, index) => {
    for (const kind of ['js', 'css']) {
      const list = entry[kind] || [];
      assert.deepEqual(duplicates(list), [], `content_scripts[${index}].${kind} loads these twice`);
    }
  });
});
