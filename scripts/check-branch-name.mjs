#!/usr/bin/env node
// 校验 PR head 分支名：分支名是 PR 里最早可见的意图声明。
// 机器人（Dependabot / Renovate）与 fork 分支不受本仓库约定约束，直接放行。

import { pathToFileURL } from "node:url";

export const TYPES = ["feat", "fix", "docs", "ci", "refactor", "chore", "hotfix"];
export const BOT_AUTHORS = new Set(["dependabot[bot]", "renovate[bot]"]);

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const BRANCH_PATTERN = new RegExp(`^(${TYPES.join("|")})/${SLUG}$`);

/**
 * 返回错误列表；空数组表示通过。
 * @param {string} raw
 * @param {{ author?: string, isFork?: boolean }} [context]
 * @returns {string[]}
 */
export function validateBranchName(raw, context = {}) {
  if (context.isFork) return [];

  const author = String(context.author ?? "").trim();
  if (BOT_AUTHORS.has(author)) return [];

  const branch = String(raw ?? "").trim();
  if (branch.length === 0) return ["分支名为空"];

  if (/^(dependabot|renovate)\//.test(branch)) return [];
  if (BRANCH_PATTERN.test(branch)) return [];

  return [
    `分支名 "${branch}" 不符合约定：应为 <type>/<kebab-slug>`,
    `type 只能是 ${TYPES.join(" / ")}；slug 只用小写字母、数字与连字符，例：ci/branch-name-check`,
  ];
}

function main() {
  const branch = process.env.BRANCH_NAME ?? process.argv[2];
  if (!branch) {
    console.error("缺少分支名：设置 BRANCH_NAME 环境变量或作为第一个参数传入");
    process.exitCode = 2;
    return;
  }

  const errors = validateBranchName(branch, {
    author: process.env.PR_AUTHOR ?? "",
    isFork: process.env.IS_FORK === "true",
  });
  if (errors.length > 0) {
    console.error("分支名不符合约定：");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`分支名通过：${branch.trim()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
