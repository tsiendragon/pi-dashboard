# PiDash Android 4.3 · build 24

**Debug APK 预发布版**，尚未完成真机端到端验收。

## 修复：从文件选择器挑图片报「不支持的文件类型」

原因：4.0 加的「文本文件 / PDF」入口用系统文件选择器（`OpenMultipleDocuments` + `*/*`），
它**也会列出照片**；那条分支只认文本与 PDF 后缀，于是照片被当成不支持的文件类型拒掉。

修法（三处，都是让类型判断更可靠而不是放宽限制）：

1. **文件选择器也接受图片**：先按 `contentResolver.getType` 与文件名判断是否图片，
   是就交给同一条图片管线（3 MB / 4 张 / PNG-JPEG-WebP-GIF 的限制不变）。
2. **归一化 mime**：`image/jpg`、`image/pjpeg`、`image/x-png`、带 `; charset=` 的写法、
   以及只有扩展名没有 mime 的情况，统一映射到四个允许值。
3. **读文件头兜底**：provider 只给 `application/octet-stream` 或空 mime 时，
   按 PNG / JPEG / GIF / WEBP 的魔数判断，仍然不认识才拒绝。

同时把拒绝文案改清楚：`不支持：name（mime）。支持图片、PDF 与文本文件。`，
菜单项也改成「图片 / 文本 / PDF 文件」，避免再被理解成只能选文本。

3 项新单测：mime 归一化（含大小写、参数、仅扩展名、PDF/空值）、文件签名识别（含空文件与 PDF）、
文件选择器把照片判为图片。总计 138 项通过。

## 安装

- 包名 `com.sam.pidash`，minSdk 26；同签名覆盖安装保留配置与配对。

## 已验证与限制

- 138 项 Android JVM 单元测试通过；APK 构建、包版本、签名核验通过。
- **真机未验证**：厂商相册/文件管理器返回的 mime 千差万别（尤其国产 ROM），
  如果仍遇到拒绝，请把提示里的文件名与括号内 mime 一起发我。
