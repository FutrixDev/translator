// Blab Translation · 第七轮：C1 晨光定向打磨。Canvas 2D，100×100 网格，每个尺寸原生绘制。
// 一叠书页从底部枢轴对称扇开：四张彩页 = 多种语言（翻译），翻飞的书页 = 阅读；
// 最前一页是一笔成形的书泡（页身与气泡尾同一条轮廓），白色播放键 = 视频；星芒点出魔法感。
// 经典脚本，file:// 直接打开可跑；导出脚本注入同一份。
(function (root) {
  const INK = '#10172A';
    const PIVOT = [50, 90];
  const CARD = { x: 32, y: 22, w: 36, h: 48, r: 9 };
  // 背后四页，由外向内绘制；沿扇面按彩虹顺序排开
  const PAGES = [
    { a: -24, c: ['#FF9A8B', '#FF5E62'] }, // 珊瑚
    { a: 24, c: ['#6FD6FF', '#2F9BF0'] },  // 天蓝
    { a: -12, c: ['#FFD37A', '#FFA53D'] }, // 琥珀
    { a: 12, c: ['#7BEBC3', '#22C08E'] },  // 薄荷
  ];
  const FRONT = ['#8C72FF', '#3F55F2'];
  const SPARKS = [
    { x: 80, y: 17, r: 7, c: '#FFB23F' },
    { x: 17.5, y: 22, r: 4.2, c: '#7C6BFF' },
    { x: 30, y: 11, r: 2.6, c: '#FF6B63' },
  ];

  // 尺寸档：细节按档逐级减少，保证小图不糊
  function tier(size) {
    if (size <= 20) return { spread: 1.18, sparks: 0, shade: false, rim: false, lines: false, play: 1.2 };
    if (size <= 36) return { spread: 1.06, sparks: 1, shade: true, rim: false, lines: false, play: 1.08 };
    if (size <= 64) return { spread: 1, sparks: 2, shade: true, rim: true, lines: false, play: 1 };
    return { spread: 1, sparks: 3, shade: true, rim: true, lines: true, play: 1 };
  }

  function rotAround(ctx, deg) {
    ctx.translate(PIVOT[0], PIVOT[1]);
    ctx.rotate(deg * Math.PI / 180);
    ctx.translate(-PIVOT[0], -PIVOT[1]);
  }
  function lin(ctx, [c0, c1], x0, y0, x1, y1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    return g;
  }
  function pagePath(dy = 0) {
    const p = new Path2D();
    p.roundRect(CARD.x, CARD.y + dy, CARD.w, CARD.h, CARD.r);
    return p;
  }
  // 书泡：圆角页身的右下角直接顺势流成气泡尾，没有拼接缝；尾尖带小圆头
  function bubblePath(dy = 0) {
    const { x, w, r } = CARD, y = CARD.y + dy, b = CARD.y + CARD.h + dy, R = x + w;
    const p = new Path2D();
    p.moveTo(x + r, y);
    p.lineTo(R - r, y);
    p.arcTo(R, y, R, y + r, r);
    p.lineTo(R, b - 7);
    p.bezierCurveTo(R, b - 1, R + 0.8, b + 5, R + 3.9, b + 8.4);
    p.quadraticCurveTo(R + 4.8, b + 9.6, R + 3.2, b + 9.7);
    p.bezierCurveTo(R - 1.5, b + 9.6, R - 6, b + 6.8, R - 8.3, b + 2.4);
    p.quadraticCurveTo(R - 9.4, b, R - 11.6, b);
    p.lineTo(x + r, b);
    p.arcTo(x, b, x, b - r, r);
    p.lineTo(x, y + r);
    p.arcTo(x, y, x + r, y, r);
    p.closePath();
    return p;
  }
  function roundTri(p, pts, r) {
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m0 = mid(pts[2], pts[0]);
    p.moveTo(m0[0], m0[1]);
    for (let i = 0; i < 3; i++) {
      const a = pts[i], b = pts[(i + 1) % 3], m = mid(a, b);
      p.arcTo(a[0], a[1], m[0], m[1], r);
    }
    p.closePath();
  }
  // 播放键按几何重心缩放，重心落在页身中心 (50, 46)
  function playPath(s) {
    const cx = 50, cy = 46;
    const pts = [[44.5, 36.5], [44.5, 55.5], [60.5, 46]].map(([px, py]) => [cx + (px - 49.83) * s, cy + (py - cy) * s]);
    const p = new Path2D();
    roundTri(p, pts, 2.8 * s);
    return p;
  }
  // 上沿一道细高光：形状减去自身下移一点，只剩顶边一弯月牙
  function rim(ctx, pathAt, alpha) {
    ctx.save();
    ctx.clip(pathAt(0));
    const crescent = new Path2D();
    crescent.addPath(pathAt(0));
    crescent.addPath(pathAt(0.75));
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fill(crescent, 'evenodd');
    ctx.restore();
  }
  // 四角星芒：凹弧四角星，带同色微光
  function sparkle(ctx, u, { x, y, r, c }, glow) {
    ctx.save();
    if (glow) {
      ctx.shadowColor = c + '99';
      ctx.shadowBlur = r * 0.7 * u;
    }
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.12, y - r * 0.12, x + r, y);
    ctx.quadraticCurveTo(x + r * 0.12, y + r * 0.12, x, y + r);
    ctx.quadraticCurveTo(x - r * 0.12, y + r * 0.12, x - r, y);
    ctx.quadraticCurveTo(x - r * 0.12, y - r * 0.12, x, y - r);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.restore();
  }
  function sparkles(ctx, size) {
    const t = tier(size), u = size / 100;
    SPARKS.slice(0, t.sparks).forEach((s, i) => {
      // 单颗时放大一点，免得在 32px 只剩两个像素
      sparkle(ctx, u, t.sparks === 1 ? { ...s, r: 8.5 } : s, t.rim);
    });
  }

  // 扇面本体（不含底板和星芒）
  function drawFan(ctx, size) {
    const t = tier(size), u = size / 100;
    for (const pg of PAGES) {
      ctx.save();
      rotAround(ctx, pg.a * t.spread);
      if (t.shade) {
        ctx.shadowColor = 'rgba(60,30,90,0.20)';
        ctx.shadowBlur = 5 * u;
        ctx.shadowOffsetY = 1.5 * u;
      }
      ctx.fillStyle = lin(ctx, pg.c, CARD.x, CARD.y, CARD.x + CARD.w, CARD.y + CARD.h);
      ctx.fill(pagePath());
      ctx.shadowColor = 'transparent';
      if (t.rim) rim(ctx, pagePath, 0.32);
      if (t.lines) {
        // 露在外侧的两行字：左侧页靠左排，右侧页靠右排
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (const [dy, w] of [[7, 13], [12.5, 9]]) {
          const x = pg.a > 0 ? CARD.x + CARD.w - 5 - w : CARD.x + 5;
          ctx.beginPath();
          ctx.roundRect(x, CARD.y + dy, w, 2.6, 1.3);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    // 前页：书泡 + 播放键
    ctx.save();
    if (t.shade) {
      ctx.shadowColor = 'rgba(50,40,160,0.30)';
      ctx.shadowBlur = 7 * u;
      ctx.shadowOffsetY = 2.2 * u;
    }
    ctx.fillStyle = lin(ctx, FRONT, CARD.x, CARD.y, CARD.x + CARD.w, CARD.y + CARD.h + 10);
    ctx.fill(bubblePath());
    ctx.restore();
    if (t.rim) {
      // 左上斜向柔光 + 顶边细高光，像一张微微发亮的纸
      ctx.save();
      ctx.clip(bubblePath());
      ctx.fillStyle = lin(ctx, ['rgba(255,255,255,0.26)', 'rgba(255,255,255,0)'], CARD.x, CARD.y, CARD.x + 18, CARD.y + 24);
      ctx.fillRect(CARD.x, CARD.y, CARD.w, CARD.h);
      ctx.restore();
      rim(ctx, bubblePath, 0.34);
    }
    ctx.save();
    if (t.rim) {
      ctx.shadowColor = 'rgba(30,20,120,0.28)';
      ctx.shadowBlur = 2.5 * u;
      ctx.shadowOffsetY = 0.8 * u;
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.fill(playPath(t.play));
    ctx.restore();
  }

  // 以网格 (50, 50) 为中心放大 k 倍，再整体下移 1，让带尾巴的扇面视觉居中
  function place(ctx, k) {
    ctx.translate(50, 51);
    ctx.scale(k, k);
    ctx.translate(-50, -50);
  }
  function grid(ctx, size, x, y, fn) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 100, size / 100);
    fn();
    ctx.restore();
  }
  // 暖白底：上浅下略暖，白色页面上也能看出底板边界；再叠一层桃粉色柔光（不掺灰紫，避免底部发脏）
  function paintShell(ctx, x0, y0, x1, y1, cx, cy, rad) {
    const base = ctx.createLinearGradient(0, y0, 0, y1);
    base.addColorStop(0, '#FFFAF3');
    base.addColorStop(1, '#FCEBDD');
    ctx.fillStyle = base;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, rad);
    g.addColorStop(0, 'rgba(255,178,120,0.30)');
    g.addColorStop(0.55, 'rgba(255,150,170,0.10)');
    g.addColorStop(1, 'rgba(255,190,170,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  function scaleFor(size) {
    return size <= 20 ? 1.1 : size <= 36 ? 1.04 : 0.96;
  }

  // 应用图标：暖白圆角方块。扩展、favicon、apple-touch、APK 旧式图标都用它。
  function drawTile(ctx, size, x = 0, y = 0) {
    grid(ctx, size, x, y, () => {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, 100, 100, 22.5);
      ctx.clip();
      paintShell(ctx, 0, 0, 100, 100, 50, 58, 52);
      ctx.restore();
      sparkles(ctx, size);
      place(ctx, scaleFor(size));
      drawFan(ctx, size);
    });
  }

  // 裸标（透明底）：字标组合、网站页头用。星芒保留。
  function drawMark(ctx, size, x = 0, y = 0) {
    grid(ctx, size, x, y, () => {
      ctx.translate(50, 50);
      ctx.scale(1.12, 1.12);
      ctx.translate(-50, -50);
      sparkles(ctx, size);
      place(ctx, 1);
      drawFan(ctx, size);
    });
  }

  // Android 自适应图标：108dp 画布，前景落在中央 66dp 安全区；背景层单独画暖白柔光。
  function drawAdaptiveForeground(ctx, size) {
    const inner = size * (66 / 108), off = (size - inner) / 2;
    grid(ctx, inner, off, off, () => {
      sparkles(ctx, 512);
      place(ctx, 1.02);
      drawFan(ctx, 512);
    });
  }
  function drawAdaptiveBackground(ctx, size) {
    grid(ctx, size, 0, 0, () => paintShell(ctx, 0, 0, 100, 100, 50, 56, 60));
  }

  // 满版（不裁圆角）：Play 商店 512 图标由商店自己套遮罩
  function drawFullBleed(ctx, size) {
    grid(ctx, size, 0, 0, () => {
      paintShell(ctx, 0, 0, 100, 100, 50, 58, 52);
      sparkles(ctx, size);
      place(ctx, scaleFor(size));
      drawFan(ctx, size);
    });
  }

  // Android TV 横幅 320×180（按 w 缩放）：暖白柔光底，左侧标志，右侧字标；副标按产品名传入
  function drawBanner(ctx, w, tagline = 'Translation') {
    const s = w / 320, h = 180 * s;
    ctx.save();
    ctx.scale(s, s);
    paintShell(ctx, 0, 0, 320, 180, 92, 100, 120);
    ctx.restore();
    drawMark(ctx, 140 * s, 20 * s, 20 * s);
    ctx.save();
    ctx.fillStyle = INK;
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${44 * s}px "SF Pro Rounded", "Nunito", system-ui, sans-serif`;
    ctx.fillText('Blab', 176 * s, 98 * s);
    ctx.font = `600 ${19 * s}px "SF Pro Rounded", "Nunito", system-ui, sans-serif`;
    ctx.fillStyle = '#4A55E8';
    ctx.fillText(tagline, 178 * s, 126 * s);
    ctx.restore();
    return h;
  }

  root.BlabR7 = {
    STYLES: [{ key: 'C1', zh: 'C1 晨光 · 打磨', en: 'Dawn, polished', draw: (ctx, size) => drawTile(ctx, size) }],
    drawTile, drawMark, drawFullBleed, drawAdaptiveForeground, drawAdaptiveBackground, drawBanner,
  };
})(typeof window !== 'undefined' ? window : globalThis);
