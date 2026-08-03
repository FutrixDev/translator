# Blab Translation 品牌与 Chrome 商店视觉包

日期：2026-07-26

## 品牌定义

- 英文名：`Blab Translation`
- 中文名：`叭叭翻译`
- 品牌口号：`叭叭翻译，翻译一切`
- 核心意象：一只灵活、友好、聪明的八爪鱼，用八只触手接住不同载体中的表达。
- 视觉母题：`八只手，接住每一种表达`

这里的八爪鱼不是单纯的可爱吉祥物。它把产品现有的网页全文、划词、悬停、输入框、YouTube 字幕、数学公式与代码保护、漫画图片、自定义模型八类能力统一为同一个品牌动作：伸手接住，然后自然翻译。

## 视觉原则

1. Logo 优先保证浏览器工具栏小尺寸识别，轮廓必须简洁、居中、留足安全边距。
2. 八爪鱼必须恰好八只触手；不使用随机字母、假语言字符或廉价 AI 星光。
3. 角色友好但不幼稚，适合面向大众的生产力工具。
4. 主色使用海洋靛蓝与珊瑚橙，辅以薄荷绿和深海墨色；避免泛用蓝紫渐变堆叠。
5. Chrome 宣传图少文字、强品牌、全画幅填满，缩小一半仍能读出品牌与产品动作。
6. 画面中的品牌名与口号由 GPT Image 2 在生成阶段原生完成；文字错误必须重新生成，不后期贴字或修字。

## 推荐色板

| 角色 | 色值 | 用途 |
| --- | --- | --- |
| Ocean Indigo | `#4054F4` | 主品牌色、八爪鱼主体 |
| Coral Talk | `#FF6B63` | 语言活力、重点动作 |
| Mint Signal | `#35D0A0` | 已完成、翻译结果 |
| Deep Ink | `#10172A` | 深色背景、文字 |
| Warm Shell | `#FFF7EE` | 浅色背景 |

## 交付结构

- `design-matrix.md`：Logo 与 Chrome 宣传图的路线和验收标准
- `prompts-and-images.md`：可复用 GPT Image 2 原始提示词
- `image-manifest.json`：文件、尺寸、用途、提示词与状态清单
- `images/`：生成的独立成品图

## 已选方向

- 主标：`L1 — Bubble Octopus / 对话泡泡八爪鱼`
- Chrome 小型宣传图：品牌名 + 中文口号 + 八触手角色
- Chrome 横幅：`Logo-led Alternative`，主标保持完整，网页、字幕、代码与漫画通过背景内容流表达

`L2 — Octo B` 与 `L3 — Reach Everything` 作为探索候选保留。最初的“八条触手分别连接八类功能”横幅因为 GPT Image 2 两轮都生成了 9 条触手，已移入 `images/rejected/`，不会被误当成正式成品。

## Chrome 商店规格

- 商店图标：`128 × 128`
- Small promo tile：`440 × 280`
- Marquee promo tile：`1400 × 560`
- 功能展示图：`1280 × 800`

Logo 源图会保留高分辨率母版，再导出 Chrome 所需尺寸。宣传图按各自画幅独立生成，不把一张图机械裁切成多种尺寸。

规格依据：

- [Chrome Web Store：Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Chrome Web Store：Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)
- [Chrome Web Store：Supplying Images](https://developer.chrome.com/docs/webstore/images)
