/**
 * The float ball, as an e2e test drives and reads it: a click on the ball (a
 * manual page round), a drag to a dock, the progress ring on it, and the bar a
 * manual round leaves when it ends.
 */

/** The progress ring svg on the float ball (content-float-ball.js). */
const ring = (page) => page.locator('#ai-translator-float-ball svg.ai-translator-ring');

/**
 * Click the ball: a manual page round. At (18, 18), the middle of the 36 px
 * ball, clear of the status dot and the "more" button on its rim.
 */
async function clickBall(page) {
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

/** Drag the ball to (x, y) and let go, then take the pointer off it. */
async function dragBall(page, x, y) {
  const box = await page.locator('#ai-translator-float-ball').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
  await page.mouse.move(400, 300);
}

// 一轮手动整页收尾挂出的那一条：成功、提示（没有可翻的，或还剩几块没翻成）、报错。
// 翻的过程中没有条子；新一轮点下时上一轮的被立刻收走，等到的一定是这一轮的。
const ROUND_END_BAR = ['success', 'info', 'error']
  .map((name) => `#ai-translator-progress.ai-translator-progress-${name}-state`)
  .join(', ');

/** Wait for the manual page round's end bar (success, notice or error) to attach. */
async function waitForPageRoundEnd(page, timeout = 30000) {
  await page.waitForSelector(ROUND_END_BAR, { state: 'attached', timeout });
}

module.exports = {
  ring,
  clickBall,
  dragBall,
  ROUND_END_BAR,
  waitForPageRoundEnd,
};
