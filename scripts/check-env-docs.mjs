#!/usr/bin/env node
/**
 * check-env-docs.mjs — 防止 `guide/config.md` 的环境变量表和代码漂移。
 *
 * 扫描 backend 里所有 `process.env.*` 读取，检查每个变量是否出现在 guide/config.md。
 * 新增了对外变量却忘了写文档时，此脚本会列出缺失项并以 exit=1 失败。
 *
 * 用法： node scripts/check-env-docs.mjs   （或 npm run docs:env-check）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const CONFIG_DOC = join(REPO_ROOT, "guide", "config.md");

/** 只扫这些后缀（排除测试与构建产物）。 */
const SOURCE_EXT = /\.(?:[cm]?[jt]s)$/;

/**
 * 不要求写进文档的变量：进程/运行时内部或组织特有，不是用户配置面。
 * 加新内部变量时在这里补一行，并写清为什么不属于配置文档。
 */
const IGNORE = new Set([
  "HOME",
  "TZ",
  "NODE_OPTIONS",
  "VITEST",
  "WORKSPACE_DIR",
  "TAILSCALE_IP",
  "PI_RUNTIME",
  "PI_PKG_PATH",
]);

const ENV_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXT.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

const doc = readFileSync(CONFIG_DOC, "utf8");
const found = new Map(); // name -> Set(files)

for (const file of walk(BACKEND_DIR)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(ENV_RE)) {
    const name = match[1] ?? match[2];
    if (IGNORE.has(name)) continue;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file.slice(REPO_ROOT.length + 1));
  }
}

const missing = [...found.entries()]
  .filter(([name]) => !doc.includes(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length === 0) {
  console.log(`[env-docs] OK — ${found.size} 个对外变量都已写进 guide/config.md`);
  process.exit(0);
}

console.error("[env-docs] 以下变量在 backend 里被读取，但 guide/config.md 没有记录：");
for (const [name, files] of missing) {
  console.error(`  - ${name}  (${[...files].join(", ")})`);
}
console.error("\n请把它们补进 guide/config.md 的变量表，或（若是内部变量）加入本脚本的 IGNORE。");
process.exit(1);