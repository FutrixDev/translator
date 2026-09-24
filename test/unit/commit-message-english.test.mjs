// .githooks/commit-msg: commit messages in this repository are English
// (CLAUDE.md, "Shipping Changes").
//
// Every case is a real `git commit` in a scratch repository whose
// core.hooksPath points at this checkout's .githooks, because the parts that
// can go quietly wrong are on git's side of the contract, not in the regex: a
// hook that lost its executable bit is skipped with nothing but a hint, and
// whether a `#` line is a comment depends on whether an editor opened.
//
// Run with: npm run test:unit
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const repo = mkdtempSync(join(tmpdir(), 'commit-msg-'));
after(() => rmSync(repo, { recursive: true, force: true }));

// No GIT_* from outside: run from inside a hook, GIT_DIR and GIT_INDEX_FILE
// would point these commits at the real repository. And no user config: a
// global commit.gpgsign or core.hooksPath would decide the case instead of
// the hook.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const git = (args, extraEnv = {}) =>
  spawnSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', `core.hooksPath=${join(ROOT, '.githooks')}`,
    ...args,
  ], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });

git(['init', '-q']);

// -m, the way agents and the PR script commit: no editor opens.
const commit = (...paragraphs) =>
  git(['commit', '-q', '--allow-empty', ...paragraphs.flatMap((p) => ['-m', p])]);

// An editor that writes `message` above the template git hands it.
const EDITOR = join(repo, '.git', 'fake-editor.sh');
writeFileSync(EDITOR, '#!/bin/sh\ncat "$MESSAGE" "$1" > "$1.new" && mv "$1.new" "$1"\n');
chmodSync(EDITOR, 0o755);
function commitInEditor(message, args, config = []) {
  const file = join(repo, '.git', 'fake-message.txt');
  writeFileSync(file, message);
  return git([...config, 'commit', '-q', ...args], { GIT_EDITOR: EDITOR, MESSAGE: file });
}

test('an English message goes through, typography English shares included', () => {
  const result = commit(
    'fix: keep the caption menu open — a resize no longer closes it',
    'Before → after: “Français” stays selected… (×2 fewer reflows).',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const [what, paragraphs] of [
  ['a Chinese subject', ['fix: 字幕进每日 AI 额度']],
  ['Chinese in the body only', ['fix: count captions against the daily budget', '预算闸只认 auto']],
  ['a full-width comma in English text', ['fix: retry once，then give up']],
  ['CJK corner brackets', ['docs: rename the 「Always」 label']],
  ['Japanese kana', ['i18n: the ja table says ありがとう']],
  ['a Chinese line starting with #, which git keeps under -m', ['fix: caption budget', '# 背景']],
]) {
  test(`rejected: ${what}`, () => {
    const result = commit(...paragraphs);
    assert.notEqual(result.status, 0, `the hook let it through\n${result.stderr}`);
    assert.match(result.stderr, /commit messages in this repository are written in English/);
  });
}

test('the rejection names the line to rewrite', () => {
  const result = commit('fix: count captions against the daily budget', '预算闸只认 auto');
  assert.match(result.stderr, /^ {2}3: 预算闸只认 auto$/m);
  assert.doesNotMatch(result.stderr, /1: fix:/);
});

test('with an editor, comments and the -v diff are dropped, by git and by the hook', () => {
  writeFileSync(join(repo, 'notes.txt'), '这一行是提交的内容，会出现在 -v 的 diff 里\n');
  assert.equal(git(['add', 'notes.txt']).status, 0);
  const result = commitInEditor('feat: add the notes file\n\n# 模拟 zh_CN 的 git 写的模板注释\n', ['-v']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(['log', '-1', '--format=%B']).stdout.trim(), 'feat: add the notes file');
});

test('with core.commentChar changed, the hook drops what git drops', () => {
  writeFileSync(join(repo, 'notes.txt'), '第二行，也会出现在 diff 里\n', { flag: 'a' });
  assert.equal(git(['add', 'notes.txt']).status, 0);
  const result = commitInEditor('docs: extend the notes\n\n; 分号开头才是注释\n', ['-v'], ['-c', 'core.commentChar=;']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(['log', '-1', '--format=%B']).stdout.trim(), 'docs: extend the notes');
});

test('with an editor, a Chinese subject is still rejected', () => {
  const result = commitInEditor('fix: 字幕进每日 AI 额度\n', ['--allow-empty']);
  assert.notEqual(result.status, 0, `the hook let it through\n${result.stderr}`);
});

test('npm install is what switches the hook on', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(scripts.prepare ?? '', /git config core\.hooksPath \.githooks/);
});
