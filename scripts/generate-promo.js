/**
 * Promotional Assets Generator for AI Academic Paper Translator
 * Generates icon and promotional images
 *
 * SUPERSEDED — do not run. Same reason as generate-icons.js: it writes
 * icons/promo-small.png, icons/promo-large.png and icons/icon128-new.png in
 * the pre-G1 brand. The store tiles now come from
 * brand/blab-translation-2026-07-26/images/chrome-{small-promo,marquee-logo-led}-*.png,
 * and icon128-new.png was deleted as unreferenced.
 */

const fs = require('fs');
const path = require('path');

try {
  const { createCanvas, registerFont } = require('canvas');

  const iconsDir = path.join(__dirname, '..', 'icons');
  const fontsDir = path.join(__dirname, '..', 'fonts');

  // Register Chinese font
  const chineseFontPath = path.join(fontsDir, 'NotoSansCJK.otf');
  if (fs.existsSync(chineseFontPath)) {
    registerFont(chineseFontPath, { family: 'NotoSansCJK' });
    console.log('✓ Chinese font loaded');
  } else {
    console.log('⚠ Chinese font not found, using fallback');
  }

  // Color palette - Trust blue + Orange accent (from ui-ux-pro-max)
  const colors = {
    primary: '#2563EB',
    secondary: '#3B82F6',
    accent: '#F97316',
    purple: '#7C3AED',
    background: '#F8FAFC',
    backgroundDark: '#0F172A',
    text: '#1E293B',
    textLight: '#64748B',
    white: '#FFFFFF',
    border: '#E2E8F0'
  };

  // Gradient helper
  function createGradient(ctx, x1, y1, x2, y2, color1, color2) {
    const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    gradient.addColorStop(0, color1);
    gradient.addColorStop(1, color2);
    return gradient;
  }

  // Draw rounded rectangle
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ========================================
  // Icon 128x128 - Modern Translation Icon
  // ========================================
  function generateIcon(size = 128) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const s = size / 128;
    const cx = size / 2;
    const cy = size / 2;

    // Background - rounded square with gradient
    const bgRadius = 24 * s;
    const bgGradient = ctx.createLinearGradient(0, 0, size, size);
    bgGradient.addColorStop(0, '#6366F1');    // Indigo
    bgGradient.addColorStop(0.5, '#8B5CF6');  // Purple
    bgGradient.addColorStop(1, '#3B82F6');    // Blue

    ctx.fillStyle = bgGradient;
    roundRect(ctx, 2 * s, 2 * s, size - 4 * s, size - 4 * s, bgRadius);
    ctx.fill();

    // Subtle inner glow
    const innerGlow = ctx.createRadialGradient(cx, cy * 0.7, 0, cx, cy, size * 0.7);
    innerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
    innerGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = innerGlow;
    roundRect(ctx, 2 * s, 2 * s, size - 4 * s, size - 4 * s, bgRadius);
    ctx.fill();

    // Left bubble (source language)
    const bubbleRadius = 28 * s;
    const leftBubbleX = cx - 18 * s;
    const leftBubbleY = cy - 8 * s;

    // Left bubble shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.beginPath();
    ctx.arc(leftBubbleX + 2 * s, leftBubbleY + 3 * s, bubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // Left bubble body
    ctx.fillStyle = colors.white;
    ctx.beginPath();
    ctx.arc(leftBubbleX, leftBubbleY, bubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // Left bubble tail
    ctx.beginPath();
    ctx.moveTo(leftBubbleX - 12 * s, leftBubbleY + 22 * s);
    ctx.quadraticCurveTo(
      leftBubbleX - 20 * s, leftBubbleY + 38 * s,
      leftBubbleX - 8 * s, leftBubbleY + 28 * s
    );
    ctx.quadraticCurveTo(
      leftBubbleX - 4 * s, leftBubbleY + 26 * s,
      leftBubbleX - 2 * s, leftBubbleY + 24 * s
    );
    ctx.fill();

    // "A" in left bubble
    ctx.fillStyle = '#6366F1';
    ctx.font = `bold ${26 * s}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', leftBubbleX, leftBubbleY);

    // Right bubble (target language)
    const rightBubbleX = cx + 22 * s;
    const rightBubbleY = cy + 2 * s;
    const rightBubbleRadius = 24 * s;

    // Right bubble shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.beginPath();
    ctx.arc(rightBubbleX + 2 * s, rightBubbleY + 3 * s, rightBubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // Right bubble body - slight yellow/cream tint
    ctx.fillStyle = '#FEF9C3';
    ctx.beginPath();
    ctx.arc(rightBubbleX, rightBubbleY, rightBubbleRadius, 0, Math.PI * 2);
    ctx.fill();

    // Right bubble tail
    ctx.beginPath();
    ctx.moveTo(rightBubbleX + 10 * s, rightBubbleY + 18 * s);
    ctx.quadraticCurveTo(
      rightBubbleX + 18 * s, rightBubbleY + 32 * s,
      rightBubbleX + 6 * s, rightBubbleY + 24 * s
    );
    ctx.quadraticCurveTo(
      rightBubbleX + 4 * s, rightBubbleY + 22 * s,
      rightBubbleX + 2 * s, rightBubbleY + 20 * s
    );
    ctx.fill();

    // "文" in right bubble
    ctx.fillStyle = '#B45309';
    ctx.font = `bold ${22 * s}px NotoSansCJK, Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('文', rightBubbleX, rightBubbleY);

    // Translation arrows (bidirectional, curved)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';

    // Arrow from left to right (top)
    const arrowY1 = cy - 28 * s;
    ctx.beginPath();
    ctx.moveTo(cx - 8 * s, arrowY1);
    ctx.lineTo(cx + 8 * s, arrowY1);
    ctx.stroke();

    // Arrow head right
    ctx.beginPath();
    ctx.moveTo(cx + 4 * s, arrowY1 - 4 * s);
    ctx.lineTo(cx + 10 * s, arrowY1);
    ctx.lineTo(cx + 4 * s, arrowY1 + 4 * s);
    ctx.stroke();

    // Small math symbol hint at bottom
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `${11 * s}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText('∑ ∫ π', cx, size - 14 * s);

    return canvas.toBuffer('image/png');
  }

  // ========================================
  // Small Promo 440x280
  // ========================================
  function generateSmallPromo() {
    const width = 440;
    const height = 280;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background gradient - darker, more professional
    const bgGradient = ctx.createLinearGradient(0, 0, width, height);
    bgGradient.addColorStop(0, '#0F172A');
    bgGradient.addColorStop(1, '#1E293B');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Subtle grid pattern
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i < width; i += 30) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, height);
      ctx.stroke();
    }
    for (let i = 0; i < height; i += 30) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(width, i);
      ctx.stroke();
    }

    // Decorative glow
    const glow1 = ctx.createRadialGradient(80, 60, 0, 80, 60, 150);
    glow1.addColorStop(0, 'rgba(99, 102, 241, 0.15)');
    glow1.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, width, height);

    const glow2 = ctx.createRadialGradient(width - 80, height - 80, 0, width - 80, height - 80, 150);
    glow2.addColorStop(0, 'rgba(139, 92, 246, 0.12)');
    glow2.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, width, height);

    // Title at top
    ctx.fillStyle = colors.white;
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('AI Academic Paper Translator', width / 2, 32);

    // Subtitle
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '11px Arial';
    ctx.fillText('Translate papers while preserving formulas', width / 2, 50);

    // Main content area - centered card
    const cardW = 380;
    const cardH = 150;
    const cardX = (width - cardW) / 2;
    const cardY = 70;

    // Card background with gradient border effect
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    roundRect(ctx, cardX, cardY, cardW, cardH, 12);
    ctx.fill();

    // Left section - Original
    const leftX = cardX + 20;
    const sectionW = 150;

    // Section label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('ORIGINAL', leftX, cardY + 20);

    // Original text box
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    roundRect(ctx, leftX, cardY + 28, sectionW, 100, 8);
    ctx.fill();

    // Original content
    ctx.fillStyle = colors.text;
    ctx.font = '10px Arial';
    ctx.fillText('Abstract: A novel', leftX + 10, cardY + 48);
    ctx.fillText('approach using:', leftX + 10, cardY + 62);

    ctx.fillStyle = colors.primary;
    ctx.font = 'bold 12px Arial';
    ctx.fillText('E = mc²', leftX + 10, cardY + 82);
    ctx.font = '11px Arial';
    ctx.fillText('∫₀^∞ f(x)dx', leftX + 10, cardY + 100);
    ctx.fillText('∑ aₙxⁿ', leftX + 80, cardY + 100);

    // Center arrow
    const arrowX = cardX + cardW / 2;
    const arrowY2 = cardY + cardH / 2 + 10;

    // Arrow circle background
    ctx.fillStyle = colors.purple;
    ctx.beginPath();
    ctx.arc(arrowX, arrowY2, 18, 0, Math.PI * 2);
    ctx.fill();

    // Arrow icon
    ctx.strokeStyle = colors.white;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(arrowX - 8, arrowY2);
    ctx.lineTo(arrowX + 5, arrowY2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(arrowX + 1, arrowY2 - 5);
    ctx.lineTo(arrowX + 7, arrowY2);
    ctx.lineTo(arrowX + 1, arrowY2 + 5);
    ctx.stroke();

    // Right section - Translated
    const rightX = cardX + cardW - sectionW - 20;

    // Section label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('TRANSLATED', rightX, cardY + 20);

    // Translated text box with accent border
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    roundRect(ctx, rightX, cardY + 28, sectionW, 100, 8);
    ctx.fill();

    // Accent top border
    ctx.fillStyle = colors.purple;
    roundRect(ctx, rightX, cardY + 28, sectionW, 4, 8);
    ctx.fill();

    // Translated content
    ctx.fillStyle = colors.text;
    ctx.font = '10px NotoSansCJK, Arial';
    ctx.textAlign = 'left';
    ctx.fillText('摘要：一种新颖的', rightX + 10, cardY + 52);
    ctx.fillText('方法：', rightX + 10, cardY + 66);

    ctx.fillStyle = colors.primary;
    ctx.font = 'bold 12px Arial';
    ctx.fillText('E = mc²', rightX + 10, cardY + 86);
    ctx.font = '11px Arial';
    ctx.fillText('∫₀^∞ f(x)dx', rightX + 10, cardY + 104);
    ctx.fillText('∑ aₙxⁿ', rightX + 80, cardY + 104);

    // Feature tags at bottom
    const tagY = height - 38;
    const tags = [
      { text: 'Math', icon: '∑', color: '#22C55E' },
      { text: 'LaTeX', icon: null, color: '#3B82F6' },
      { text: 'AI', icon: null, color: '#F97316' }
    ];

    const tagSpacing = 90;
    const tagStartX = width / 2 - tagSpacing;

    tags.forEach((tag, i) => {
      const tx = tagStartX + i * tagSpacing;

      // Tag background
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      roundRect(ctx, tx - 32, tagY, 64, 24, 12);
      ctx.fill();

      // Tag border
      ctx.strokeStyle = tag.color;
      ctx.lineWidth = 1.5;
      roundRect(ctx, tx - 32, tagY, 64, 24, 12);
      ctx.stroke();

      // Tag content
      ctx.fillStyle = colors.white;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (tag.icon) {
        // Icon and text separately for proper alignment
        ctx.font = 'bold 13px Arial';
        ctx.fillText(tag.icon, tx - 14, tagY + 12);
        ctx.font = 'bold 11px Arial';
        ctx.fillText(tag.text, tx + 10, tagY + 12);
      } else {
        ctx.font = 'bold 11px Arial';
        ctx.fillText(tag.text, tx, tagY + 12);
      }
    });

    ctx.textBaseline = 'alphabetic';

    return canvas.toBuffer('image/png');
  }

  // ========================================
  // Large Promo 1400x560
  // ========================================
  function generateLargePromo() {
    const width = 1400;
    const height = 560;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background gradient
    const bgGradient = createGradient(ctx, 0, 0, width, height, '#0F172A', '#1E293B');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Decorative elements
    ctx.fillStyle = 'rgba(124, 58, 237, 0.1)';
    ctx.beginPath();
    ctx.arc(200, 100, 300, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    ctx.beginPath();
    ctx.arc(width - 200, height - 100, 350, 0, Math.PI * 2);
    ctx.fill();

    // Grid pattern (subtle)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i < width; i += 50) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, height);
      ctx.stroke();
    }
    for (let i = 0; i < height; i += 50) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(width, i);
      ctx.stroke();
    }

    // Left side: Original paper
    const leftCardX = 80;
    const cardY = 60;
    const cardW = 380;
    const cardH = 320;

    // Paper shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    roundRect(ctx, leftCardX + 8, cardY + 8, cardW, cardH, 12);
    ctx.fill();

    // Paper background
    ctx.fillStyle = '#FAFAFA';
    roundRect(ctx, leftCardX, cardY, cardW, cardH, 12);
    ctx.fill();

    // Paper header
    ctx.fillStyle = colors.primary;
    roundRect(ctx, leftCardX, cardY, cardW, 50, 12);
    ctx.fill();
    ctx.fillStyle = colors.white;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('Original Paper (English)', leftCardX + 20, cardY + 32);

    // English content
    ctx.fillStyle = colors.text;
    ctx.font = '13px Arial';
    const englishLines = [
      'Abstract: This paper presents a novel',
      'approach to machine learning:',
      '',
      '    E = mc²',
      '',
      '    ∫₀^∞ f(x)dx = lim ∑ f(xᵢ)Δx',
      '',
      'The convergence rate satisfies:',
      '    ||xₙ - x*|| ≤ C · ρⁿ'
    ];

    englishLines.forEach((line, i) => {
      ctx.fillText(line, leftCardX + 25, cardY + 80 + i * 26);
    });

    // Center: Translation flow
    const centerX = width / 2;

    // Arrow line
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(leftCardX + cardW + 40, height / 2);
    ctx.lineTo(centerX - 80, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // AI translation badge
    const badgeW = 160;
    const badgeH = 80;
    const badgeX = centerX - badgeW / 2;
    const badgeY = height / 2 - badgeH / 2;

    // Badge glow
    ctx.shadowColor = colors.purple;
    ctx.shadowBlur = 30;
    ctx.fillStyle = colors.purple;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 16);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Badge content
    ctx.fillStyle = colors.white;
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('AI Translation', centerX, badgeY + 35);
    ctx.font = '12px Arial';
    ctx.fillText('Math Formula Preserved', centerX, badgeY + 58);

    // Arrow to right
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(centerX + 80, height / 2);
    ctx.lineTo(width - leftCardX - cardW - 40, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow head
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(width - leftCardX - cardW - 50, height / 2 - 12);
    ctx.lineTo(width - leftCardX - cardW - 30, height / 2);
    ctx.lineTo(width - leftCardX - cardW - 50, height / 2 + 12);
    ctx.closePath();
    ctx.fill();

    // Right side: Translated paper
    const rightCardX = width - leftCardX - cardW;

    // Paper shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    roundRect(ctx, rightCardX + 8, cardY + 8, cardW, cardH, 12);
    ctx.fill();

    // Paper background
    ctx.fillStyle = '#FAFAFA';
    roundRect(ctx, rightCardX, cardY, cardW, cardH, 12);
    ctx.fill();

    // Paper header
    const headerGradient = createGradient(ctx, rightCardX, cardY, rightCardX + cardW, cardY, colors.purple, colors.primary);
    ctx.fillStyle = headerGradient;
    roundRect(ctx, rightCardX, cardY, cardW, 50, 12);
    ctx.fill();
    ctx.fillStyle = colors.white;
    ctx.font = 'bold 16px NotoSansCJK, Arial';
    ctx.textAlign = 'left';
    ctx.fillText('翻译结果 (Chinese)', rightCardX + 20, cardY + 32);

    // Chinese content - reduced to fit better
    ctx.fillStyle = colors.text;
    ctx.font = '13px NotoSansCJK, Arial';
    const chineseLines = [
      '摘要：本文提出了一种新颖的',
      '机器学习方法：',
      '',
      '    E = mc²',
      '',
      '    ∫₀^∞ f(x)dx = lim ∑ f(xᵢ)Δx',
      '',
      '收敛速率满足：',
      '    ||xₙ - x*|| ≤ C · ρⁿ'
    ];

    chineseLines.forEach((line, i) => {
      ctx.fillText(line, rightCardX + 25, cardY + 80 + i * 26);
    });

    // Feature badges - positioned below both cards in center
    const badgeY2 = cardY + cardH + 15;
    const featureItems = [
      { textCN: '数学公式保留', textEN: 'Math Preserved', color: '#22C55E' },
      { textCN: 'LaTeX 支持', textEN: 'LaTeX Support', color: '#3B82F6' },
      { textCN: '上下文理解', textEN: 'Context Aware', color: '#F97316' }
    ];

    const badgeSpacing = 180;
    const badgeStartX = centerX - badgeSpacing;
    const featureBadgeW = 150;
    const featureBadgeH = 52;

    featureItems.forEach((item, i) => {
      const bx = badgeStartX + i * badgeSpacing;

      // Badge background
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      roundRect(ctx, bx - featureBadgeW / 2, badgeY2, featureBadgeW, featureBadgeH, 12);
      ctx.fill();

      // Badge border
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      roundRect(ctx, bx - featureBadgeW / 2, badgeY2, featureBadgeW, featureBadgeH, 12);
      ctx.stroke();

      // Chinese text (top)
      ctx.fillStyle = colors.white;
      ctx.font = 'bold 14px NotoSansCJK, Arial';
      ctx.textAlign = 'center';
      ctx.fillText(item.textCN, bx, badgeY2 + 20);

      // English text (bottom)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '11px Arial';
      ctx.fillText(item.textEN, bx, badgeY2 + 40);
    });

    // Title and subtitle at bottom
    ctx.textAlign = 'center';
    ctx.fillStyle = colors.white;
    ctx.font = 'bold 32px Arial';
    ctx.fillText('AI Academic Paper Translator', centerX, height - 55);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '16px Arial';
    ctx.fillText('Translate academic papers while preserving mathematical formulas and LaTeX', centerX, height - 22);

    return canvas.toBuffer('image/png');
  }

  // Generate all assets
  console.log('Generating promotional assets...\n');

  // Icon 128x128
  const iconBuffer = generateIcon(128);
  fs.writeFileSync(path.join(iconsDir, 'icon128-new.png'), iconBuffer);
  console.log('✓ icon128-new.png (128x128)');

  // Small promo 440x280
  const smallPromoBuffer = generateSmallPromo();
  fs.writeFileSync(path.join(iconsDir, 'promo-small.png'), smallPromoBuffer);
  console.log('✓ promo-small.png (440x280)');

  // Large promo 1400x560
  const largePromoBuffer = generateLargePromo();
  fs.writeFileSync(path.join(iconsDir, 'promo-large.png'), largePromoBuffer);
  console.log('✓ promo-large.png (1400x560)');

  console.log('\n✅ All promotional assets generated successfully!');
  console.log(`\nFiles saved to: ${iconsDir}`);

} catch (error) {
  console.error('Error:', error.message);
  console.log('\nPlease install canvas first: npm install canvas');
}
