# Blab Translation 视觉包 QA

## 结论

正式交付通过：

- 主标母版与透明母版
- Chrome `16 / 32 / 48 / 128px` 图标
- Chrome `440 × 280` Small promo tile
- Chrome `1400 × 560` Marquee promo tile

## 检查项

| 检查 | 结果 |
| --- | --- |
| 主标是否恰好八条触手 | 通过 |
| 32px 是否仍能认出八爪鱼与气泡头 | 通过 |
| 透明 Logo 是否具有真实 Alpha 通道 | 通过 |
| Chrome 图标尺寸是否准确 | 通过 |
| Small promo 是否为 440×280 | 通过 |
| Marquee 是否为 1400×560 | 通过 |
| 两张宣传图品牌名是否为 `Blab Translation` | 通过 |
| 两张宣传图中文口号是否为 `叭叭翻译，翻译一切` | 通过 |
| 是否出现 Chrome 官方徽章、虚假评分或水印 | 未出现 |
| 是否展示不存在的产品能力或数据 | 未出现 |
| 是否通过后期贴字或修字 | 否 |

## 失败与保留

### 连接触手版 Marquee

两次 GPT Image 2 生成均出现 9 条触手。画面与文字可用，但不符合主标一致性，因此移入 `images/rejected/`，不作为正式成品。

### Feature Story

两次 GPT Image 2 生成分别出现 10 条与 12 条触手。达到两次重试上限后停止，没有写入正式文件路径。

## 透明 Logo 说明

GPT Image 2 首次“透明背景”请求生成了视觉棋盘格，但文件实际没有 Alpha，已判定失败并移入 `images/rejected/logo-failed-checkerboard-no-alpha.png`。第二次让 GPT Image 2 在纯色分离背景上原生生成同一主标，再仅用 `ffmpeg colorkey` 导出 Alpha 通道与不同尺寸；没有后期添加文字、修字或重画形状。
