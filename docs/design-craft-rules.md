# UI 工艺规则（design craft rules）

这份文件把「做到什么程度算精致」固化成可检查的规则，避免后续改动把这些不变量破坏掉。
每条都标了出处，改之前先读。

## 1. 阴影：同一天光，分层，带色

- **唯一光源**：所有阴影方向一致，水平偏移 = 垂直偏移的一半（`x : y = 1 : 2`），模拟光从左上方来。
- **层级越高，偏移/模糊越大、透明度越小**（`--shadow-sm/md/lg/xl` 按此递进）。
- **不用纯黑**：阴影颜色由 `--shadow-color` 提供（各主题一个带色相的近黑色）。
- **多层**：`md` 以上用 2–3 层叠出真实感。
- 文件：`frontend/src/themes/*.css` 的 `--shadow-*`；改主题只调 `--shadow-color` 与透明度。

出处：Josh W. Comeau《Designing Beautiful Shadows in CSS》；Ian Storm Taylor《Never Use Black》。

## 2. 实心语义底色上的文字：一律用 `--*-fg`

- `bg-accent` → `text-accent-fg`；`bg-danger` → `text-danger-fg`；`bg-ok` → `text-ok-fg`。
- **禁止**在语义实心底色上写 `text-white`（浅色主题下不可读，曾全仓 63 处违规）。
- 规则来源：不同主题的 accent 明度不同，唯一正确的字色随主题变化。

出处：Refactoring UI《Don't use grey text on colored backgrounds》。

## 3. 状态色必须通过色盲校验

- 改任何 `--ok/--warn/--danger/--accent` 后必须跑：`npm run check:theme-cvd`。
- 判定：红绿三对（成功/错误、成功/警告、错误/警告）在 deutan/protan 下 ΔE00 < 10 即为塌陷，必须修。

## 4. 少用边框

分隔两个元素时的优先级：**背景色差 > 间距 > 阴影 > 边框**。
消息卡片、工具卡这类同类元素之间，用背景差和间距区分，边框只作兜底且降透明度。

出处：Refactoring UI《Use fewer borders》。

## 5. 字号与层级

- **字号底线 10px**（暗色模式下小字更吃亏，低于 10px 不应出现）。
- **用命名档位，不写一次性 `text-[Npx]`**。当前档位定义在 `frontend/tailwind.config.js` 的 `fontSize`：

  | 类名 | 字号 / 行高 | 用途 |
  |---|---|---|
  | `text-2xs` | 11 / 16 | 微标签、工具行、徽标 |
  | `text-meta` | 12 / 18 | 次级信息 |
  | `text-body-s` | 13 / 20 | 三级正文 |
  | `text-sm` | 14 / — | 消息正文 |

- 行高必须与字号配对（不要靠继承 body 的 1.55）。
- 层级优先用**颜色和字重**表达，而不是一味缩小字号。

出处：Refactoring UI《Use color and weight to create hierarchy instead of size》；NN/g《Dark Mode vs. Light Mode》（引 Piepenbrock 2013）。

## 5b. 正文行宽

消息正文宽度上限 720px（原来 820px）。约 90 字符以内更适合阅读，过宽会让眼睛迷失行首。

## 6. 全局交互细节（不要各组件自己实现）

- **按压态**：`button:not(:disabled):active` 由全局规则给 `filter:brightness(.93)`，不再单独加。
- **焦点环**：用 `:focus-visible`（键盘才显示）；`.focus-ring` 类负责带光晕的输入控件。
- **减少动效**：全局 `@media (prefers-reduced-motion: reduce)` 已关闭动画与过渡，新动效无需重复处理。
- **缓动**：用 `--ease-out` / `--ease-in` 与 `--dur-fast/base/slow`，不要写死新数值。
- **过渡属性要写明确**：用 `transition`（颜色/透明度/阴影/变换/滤镜），**不要用 `transition-all`**——它会把宽高、内外边距也纳入动画，容易掉帧。真要动宽高时写具体属性，如 `transition-[width]`。

出处：NN/g《Executing UX Animations: Duration and Motion Characteristics》。

## 7. 按钮层级

一个页面只有一个真正的**主操作**（实心高对比）；次要操作用描边或低对比底；低频操作用链接样式。
**破坏性操作如果不是主操作，不要给大红色实心样式。**

出处：Refactoring UI《Not every button needs a background color》。