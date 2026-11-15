#!/usr/bin/env node
// 校验 PR 标题格式：squash-only 下 PR 标题会成为 main 的提交信息。
// 只校验格式，不校验语言：Dependabot 生成的英文标题也必须能通过。

import { pathToFileURL } from "node:url";

export const TYPES = ["feat", "fix", "docs", "ci", "refactor", "chore", "hotfix"];
export const MAX_LENGTH = 72;

const SCOPE = "\\([a-z0-9]+(?:[.-][a-z0-9]+)*\\)";
const TITLE_PATTERN = new RegExp(`^(${TYPES.join("|")})(${SCOPE})?: (\\S.*)$`);

/**
 * 返回错误列表；空数组表示通过。
 * @param {string} raw
 * @returns {string[]}
 */
export function validateTitle(raw) {
  const title = String(raw ?? "").trim();
  if (title.length === 0) return ["标题为空"];

  const errors = [];
  const length = [...title].length;
  if (length > MAX_LENGTH) errors.push(`标题 ${length} 字符，超过 ${MAX_LENGTH} 上限`);

  const match = TITLE_PATTERN.exec(title);
  if (!match) {
    errors.push(
      '格式应为 "<type>(<scope>): <摘要>"，type 只能是 feat / fix / docs / ci / refactor / chore / hotfix，type 与 scope 用小写英文',
    );
    return errors;
  }

  const description = match[3].trim();
  if (description.length === 0) errors.push("冒号后缺少摘要");
  if (/[。.]$/.test(description)) errors.push("标题结尾不要加句号");
  return errors;
}

function main() {
  const title = process.env.PR_TITLE ?? process.argv[2];
  if (!title) {
    console.error("缺少标题：设置 PR_TITLE 环境变量或作为第一个参数传入");
    process.exitCode = 2;
    return;
  }

  const errors = validateTitle(title);
  if (errors.length > 0) {
    console.error("PR 标题不符合约定：");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PR 标题通过：${title.trim()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
