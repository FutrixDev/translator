/**
 * Icon Generator for Blab Translation
 * 设计：两个交叠的拟人化气泡，中间融合区域代表翻译
 *
 * SUPERSEDED — do not run. It draws the PRE-G1 two-bubble mark, so
 * `npm run icons` would overwrite icons/icon{16,32,48,128}(-light).png with
 * the old brand. The shipped icons now come from
 * brand/blab-translation-2026-07-26/images/chrome-icon-*.png, which are drawn
 * art, not generated. Kept only as the record of how the old set was made.
 */

const fs = require('fs');
const path = require('path');

try {
  const { createCanvas } = require('canvas');

  const sizes = [16, 32, 48, 128];
  const iconsDir = path.join(__dirname, '..', 'icons');

  // 绘制气泡形状（圆形 + 底部小尾巴）
  function drawBubble(ctx, cx, cy, radius, tailDirection) {
    // 主圆形
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // 小尾巴
    const tailSize = radius * 0.35;
    const tailY = cy + radius * 0.75;
    const tailX = tailDirection === 'left' ? cx - radius * 0.3 : cx + radius * 0.3;

    ctx.beginPath();
    ctx.moveTo(tailX - tailSize * 0.5, tailY - tailSize * 0.3);
    ctx.lineTo(tailX + tailDirection === 'left' ? -tailSize * 0.6 : tailSize * 0.6, tailY + tailSize * 0.8);
    ctx.lineTo(tailX + tailSize * 0.5, tailY - tailSize * 0.3);
    ctx.fill();
  }

  // 绘制交叠气泡图标
  function drawOverlappingBubbles(ctx, size, isDark) {
    const s = size / 128;
    const centerX = size / 2;
    const centerY = size / 2;

    // 气泡参数
    const bubbleRadius = 32 * s;
    const overlap = 18 * s;  // 交叠程度
    const leftCx = centerX - overlap;
    const rightCx = centerX + overlap;
    const bubbleCy = centerY - 4 * s;

    // 颜色定义 - 蓝色 + 黄色，更醒目
    const leftColor = '#3b82f6';      // 蓝色
    const rightColor = '#f59e0b';     // 黄/橙色
    const blendColor = '#8b5cf6';     // 紫色（融合色）

    // 1. 先画左气泡（完整）
    ctx.fillStyle = leftColor;
    ctx.beginPath();
    ctx.arc(leftCx, bubbleCy, bubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // 左气泡尾巴
    const tailSize = bubbleRadius * 0.4;
    ctx.beginPath();
    ctx.moveTo(leftCx - bubbleRadius * 0.2, bubbleCy + bubbleRadius * 0.7);
    ctx.lineTo(leftCx - bubbleRadius * 0.5, bubbleCy + bubbleRadius * 1.2);
    ctx.lineTo(leftCx + bubbleRadius * 0.15, bubbleCy + bubbleRadius * 0.85);
    ctx.closePath();
    ctx.fill();

    // 2. 画右气泡（完整）
    ctx.fillStyle = rightColor;
    ctx.beginPath();
    ctx.arc(rightCx, bubbleCy, bubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // 右气泡尾巴
    ctx.beginPath();
    ctx.moveTo(rightCx + bubbleRadius * 0.2, bubbleCy + bubbleRadius * 0.7);
    ctx.lineTo(rightCx + bubbleRadius * 0.5, bubbleCy + bubbleRadius * 1.2);
    ctx.lineTo(rightCx - bubbleRadius * 0.15, bubbleCy + bubbleRadius * 0.85);
    ctx.closePath();
    ctx.fill();

    // 3. 画中间交叠区域（融合色）- 使用剪切路径
    ctx.save();
    ctx.beginPath();
    ctx.arc(leftCx, bubbleCy, bubbleRadius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = blendColor;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(rightCx, bubbleCy, bubbleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    // 4. 画眼睛 - 斜向内看，更灵动
    const eyeRadius = 3.2 * s;
    ctx.fillStyle = isDark ? 'rgba(0,0,0,0.75)' : '#1a1a2e';

    // 左气泡的眼睛 - 斜向右上方排列（看向右边）
    const leftEyeBaseX = leftCx - 6 * s;
    const leftEyeBaseY = bubbleCy - 2 * s;
    ctx.beginPath();
    ctx.arc(leftEyeBaseX - 5 * s, leftEyeBaseY + 3 * s, eyeRadius, 0, Math.PI * 2);  // 左下
    ctx.fill();
    ctx.beginPath();
    ctx.arc(leftEyeBaseX + 5 * s, leftEyeBaseY - 3 * s, eyeRadius, 0, Math.PI * 2);  // 右上
    ctx.fill();

    // 右气泡的眼睛 - 斜向左上方排列（看向左边）
    const rightEyeBaseX = rightCx + 6 * s;
    const rightEyeBaseY = bubbleCy - 2 * s;
    ctx.beginPath();
    ctx.arc(rightEyeBaseX - 5 * s, rightEyeBaseY - 3 * s, eyeRadius, 0, Math.PI * 2);  // 左上
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightEyeBaseX + 5 * s, rightEyeBaseY + 3 * s, eyeRadius, 0, Math.PI * 2);  // 右下
    ctx.fill();
  }

  // 生成深色模式图标（透明背景）
  function generateDarkIcon(size) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 透明背景，直接绘制气泡
    drawOverlappingBubbles(ctx, size, true);

    return canvas.toBuffer('image/png');
  }

  // 生成浅色模式图标（无背景，直接绘制气泡）
  function generateLightIcon(size) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 直接绘制气泡（透明背景）
    drawOverlappingBubbles(ctx, size, false);

    return canvas.toBuffer('image/png');
  }

  // 生成所有图标
  sizes.forEach(size => {
    const darkBuffer = generateDarkIcon(size);
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), darkBuffer);
    console.log(`✓ icon${size}.png`);

    const lightBuffer = generateLightIcon(size);
    fs.writeFileSync(path.join(iconsDir, `icon${size}-light.png`), lightBuffer);
    console.log(`✓ icon${size}-light.png`);
  });

  console.log('\n✅ 图标生成完成！');

} catch (error) {
  console.error('错误:', error.message);
  console.log('\n请先安装 canvas: npm install canvas');
}
