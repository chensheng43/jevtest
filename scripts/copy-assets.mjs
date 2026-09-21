/**
 * tsc 只产出 .ts 的编译结果，不会复制非 TS 资产。
 *
 * snapshot.js 以文本读出后注入 page.evaluate，从不作为模块 import，
 * 所以它必须保持 .js 并以原始形态出现在 dist/ 里；
 * web/public/* 是浏览器直接加载的静态文件，同理。
 *
 * 这个脚本把它们补进 dist/，并逐一回读确认。`jevtest doctor` 会检查同一件事，
 * 目的是让「资产没复制」在本地就暴露，而不是等到部署后才炸。
 */
import { access, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 源路径 -> dist 内的目标路径，均为相对 root。 */
const ASSETS = [
  ["src/browser/snapshot.js", "dist/browser/snapshot.js"],
  ["src/web/public", "dist/web/public"],
];

for (const [from, to] of ASSETS) {
  await cp(join(root, from), join(root, to), { recursive: true });
  await access(join(root, to));
  console.log(`copied ${from} -> ${to}`);
}

console.log(`\n${ASSETS.length} 项资产已就位。`);
