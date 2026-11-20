#!/usr/bin/env node
// 校验「发布的版本号」在三处一致：package.json、README 里的 Releases 安装地址、
// 以及发版时打的 tag。
//
// 为什么需要它：版本号是手改的，README 里的安装地址也是手写的。改了
// package.json 却忘了改 README，用户照 README 装到的是上一个版本的 tarball；
// tag 与 package.json 不一致，Release 里挂的资产名和实际版本对不上。这两种
// 漂移都不会让构建失败，只会在用户那里变成「装完还是旧功能」或 404。
//
// 用法：
//   node scripts/check-release-version.mjs          # 比对 README 与 package.json
//   node scripts/check-release-version.mjs --tag v0.2.2  # 比对 tag 与 package.json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** README 里的安装地址：releases/download/v0.2.2/feishu-aide-0.2.2.tgz */
const INSTALL_URL = /releases\/download\/v(\d+\.\d+\.\d+)\/(feishu-aide-\d+\.\d+\.\d+\.tgz)/g;

/**
 * 取出 README 里所有 Releases 安装地址。
 * @param {string} readme
 * @returns {{ tag: string, file: string }[]}
 */
export function versionsInReadme(readme) {
  const found = [];
  for (const match of readme.matchAll(INSTALL_URL)) {
    const tag = match[1];
    const file = match[2];
    if (tag !== undefined && file !== undefined) found.push({ tag, file });
  }
  return found;
}

/**
 * README 的安装地址必须存在，且 tag 与文件名都等于当前版本。
 * @param {{ readme: string, version: string }} input
 * @returns {string[]} 问题列表；空数组表示通过
 */
export function checkReadmeVersion({ readme, version }) {
  const refs = versionsInReadme(readme);
  if (refs.length === 0) {
    return ["README 里没有 Releases 安装地址（形如 releases/download/v0.2.2/feishu-aide-0.2.2.tgz）"];
  }

  const problems = [];
  for (const ref of refs) {
    const fileVersion = ref.file.slice("feishu-aide-".length, -".tgz".length);
    if (ref.tag !== version) {
      problems.push(`README 安装地址的 tag 是 v${ref.tag}，package.json 是 ${version}`);
    }
    if (fileVersion !== version) {
      problems.push(`README 安装地址的文件名是 ${ref.file}，package.json 是 ${version}`);
    }
  }
  return [...new Set(problems)];
}

/**
 * 发版 tag 必须形如 vX.Y.Z，且与 package.json 的版本一致。
 * @param {{ tag: string, version: string }} input
 * @returns {string[]} 问题列表；空数组表示通过
 */
export function checkTagVersion({ tag, version }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    return [`tag 必须形如 v0.2.2，收到 ${JSON.stringify(tag)}`];
  }
  if (tag.slice(1) !== version) {
    return [`tag ${tag} 与 package.json 的 ${version} 不一致`];
  }
  return [];
}

function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const tagIndex = process.argv.indexOf("--tag");
  const problems =
    tagIndex > 0
      ? checkTagVersion({ tag: process.argv[tagIndex + 1] ?? "", version })
      : checkReadmeVersion({ readme: readFileSync(path.join(ROOT, "README.md"), "utf8"), version });

  if (problems.length > 0) {
    console.error("版本不一致：");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(tagIndex > 0 ? `tag 与版本一致：${version}` : `README 安装地址与版本一致：${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
