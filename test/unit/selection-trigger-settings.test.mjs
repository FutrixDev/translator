// 设置页上「划词触发方式」和另外三颗划词控件的关系（P0-D）。
//
// options.js / options-selection.js 都是经典脚本，顶层就去 getElementById，读不成
// 模块。这里把要验的函数原样抠出来求值：验的是那一份源码，不是一份抄本。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not find ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

const hasHotkeyConflict = new Function(
  `${extractFunction(repoFile('options/options.js'), 'hasHotkeyConflict')}\nreturn hasHotkeyConflict;`
)();

const CLASH = {
  enableSelection: true,
  enableHoverTranslation: true,
  selectionTranslationHotkey: 'Shift',
  hoverTranslationHotkey: 'Shift',
};

test('the same key for selection and hover is a conflict while the selection key is in use', () => {
  assert.equal(hasHotkeyConflict({ ...CLASH, selectionTrigger: 'both' }), true);
  assert.equal(hasHotkeyConflict({ ...CLASH, selectionTrigger: 'modifier' }), true);
});

test('icon-only selection never reads its key, so sharing it with hover is no conflict', () => {
  assert.equal(hasHotkeyConflict({ ...CLASH, selectionTrigger: 'icon' }), false);
});

test('the trigger joins the conflict fields, so turning it back from icon can be reverted', () => {
  const source = repoFile('options/options.js');
  const list = source.slice(source.indexOf('const CONFLICT_FIELDS = ['), source.indexOf('];', source.indexOf('const CONFLICT_FIELDS = [')));
  assert.match(list, /'selectionTrigger'/);
  const immediate = source.slice(source.indexOf('const IMMEDIATE_SAVE_FIELDS = ['), source.indexOf('];', source.indexOf('const IMMEDIATE_SAVE_FIELDS = [')));
  assert.match(immediate, /'selectionTrigger'/);
});

// syncSelectionControls 对一份假的 document 跑：三颗控件的灰态只由总开关和触发方式决定。
function runSync({ enabled, trigger }) {
  const els = {
    enableSelection: { checked: enabled },
    selectionTrigger: { value: trigger, disabled: false, addEventListener() {} },
    selectionTranslationMode: { disabled: false },
    selectionTranslationHotkey: { disabled: false },
  };
  const document = { getElementById: (id) => els[id] };
  const sync = new Function('document', `${repoFile('options/options-selection.js')}\nreturn syncSelectionControls;`)(document);
  sync();
  return {
    trigger: els.selectionTrigger.disabled,
    mode: els.selectionTranslationMode.disabled,
    hotkey: els.selectionTranslationHotkey.disabled,
  };
}

test('selection off greys out trigger, display mode and hotkey', () => {
  assert.deepEqual(runSync({ enabled: false, trigger: 'both' }), { trigger: true, mode: true, hotkey: true });
});

test('icon-only greys out the hotkey but keeps the display mode, which the float ball and menu still use', () => {
  assert.deepEqual(runSync({ enabled: true, trigger: 'icon' }), { trigger: false, mode: false, hotkey: true });
});

test('modifier and both leave every control live', () => {
  assert.deepEqual(runSync({ enabled: true, trigger: 'modifier' }), { trigger: false, mode: false, hotkey: false });
  assert.deepEqual(runSync({ enabled: true, trigger: 'both' }), { trigger: false, mode: false, hotkey: false });
});

test('both default tables that know the trigger say "both"', async () => {
  await import('../../shared/default-settings.js');
  assert.equal(globalThis.DefaultSettings.contentDefaults().selectionTrigger, 'both');
  assert.match(repoFile('options/options.js'), /\n  selectionTrigger: 'both',\n/);
});
