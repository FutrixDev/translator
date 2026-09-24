// The commit-msg check: commit messages in this repository are English
// (CLAUDE.md, "Shipping Changes"). Git runs it through .githooks/commit-msg,
// which `npm install` switches on.
//
// What git keeps is what gets checked. With -m or -F no editor opens, and git
// keeps every line, a `#` line included; it tells the hook so by setting
// GIT_EDITOR to ':'. When an editor did open, git drops the comment lines and
// everything under the scissors line, so this does too: a zh_CN git writes its
// template comments in Chinese, and the diff `git commit -v` puts under the
// scissors is this repository's code, Chinese strings and all.
//
// Usage: node scripts/check-commit-message.mjs <message-file>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Han, every extension plane included; the Japanese and Korean scripts; and
// the punctuation a CJK input method types in place of ASCII: 、。「」【】
// (U+3000-303F), ，：；！？（） (the full-width forms) and their vertical and
// compatibility variants. Typography English shares (— … “ ” →) is left alone.
const CJK = /[\p{Script=Han}\p{Script=Bopomofo}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/u;
const SCISSORS = '------------------------ >8 ------------------------';

// git 2.45 made core.commentString a synonym of core.commentChar; like git,
// take whichever is set last.
function commentMark() {
  try {
    const set = execFileSync('git', ['config', '--get-regexp', '^core[.]comment(char|string)$'], { encoding: 'utf8' });
    const value = set.trim().split('\n').pop().replace(/^\S+ ?/, '');
    return value && value !== 'auto' ? value : '#';
  } catch {
    return '#'; // neither is set: `git config` exits 1
  }
}

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
let kept = lines.map((text, i) => ({ line: i + 1, text }));
if (process.env.GIT_EDITOR !== ':') {
  const mark = commentMark();
  const cut = lines.indexOf(`${mark} ${SCISSORS}`);
  kept = kept.slice(0, cut === -1 ? undefined : cut).filter(({ text }) => !text.startsWith(mark));
}

const offending = kept.filter(({ text }) => CJK.test(text));
if (offending.length) {
  console.error([
    'commit-msg: commit messages in this repository are written in English (CLAUDE.md, "Shipping Changes").',
    'These lines are not:',
    ...offending.map(({ line, text }) => `  ${line}: ${text}`),
    'Rewrite them in English; for a UI string, name its i18n key rather than quoting the zh-CN text.',
  ].join('\n'));
  process.exit(1);
}
