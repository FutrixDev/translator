// block-source-lang-script.test.mjs 的反方向：一张中文页上的拉丁短块不能被当成
// 中文。旧逻辑给它 zh，目标是中文时 zh→zh 原样退回、一个字不译；目标是别的语言
// 时拿 zh 的模型硬译英文，和英文页上硬译中文是同一个坑。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const CHINESE_PAGE = '今天凌晨，这家公司调整了云端会话的权限，并按会员等级发放了额度。'.repeat(20);

const { ctx } = await installEngineHarness({ pageText: CHINESE_PAGE });
const eng = ctx.engine;

test('a short Chinese block on a Chinese page takes the page language', async () => {
  assert.equal(await eng.resolveSourceLang('谁懂这个座位', '', false, undefined), 'zh');
});

test('a short Latin block on a Chinese page is not read as Chinese', async () => {
  // CLD 在十几个拉丁字母上判不准（夹具按真 Chrome 的答法给 unreliable），
  // 剩下的就是按英文处理。
  assert.equal(await eng.resolveSourceLang('Sign in to continue', '', false, undefined), 'en');
});
