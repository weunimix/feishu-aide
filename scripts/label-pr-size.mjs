#!/usr/bin/env node
// 按 PR 改动行数打 size 标签：让“这个 PR 是否过大”在列表里可见。
// 只打标签，不阻断合并——体积是信号，不是门禁。

import { pathToFileURL } from "node:url";

export const SIZE_THRESHOLDS = [
  { label: "size/xs", max: 10 },
  { label: "size/s", max: 50 },
  { label: "size/m", max: 200 },
  { label: "size/l", max: 500 },
];

/**
 * 按总改动行数（新增 + 删除）选择 size 标签。
 * @param {number} total
 * @returns {string}
 */
export function sizeFor(total) {
  const lines = Number(total) || 0;
  for (const { label, max } of SIZE_THRESHOLDS) {
    if (lines <= max) return label;
  }
  return "size/xl";
}

async function api(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  if (!token || !repo || !number) {
    console.error("缺少环境变量：GITHUB_TOKEN、GITHUB_REPOSITORY、PR_NUMBER");
    process.exitCode = 2;
    return;
  }
  if (process.env.IS_FORK === "true") {
    console.log("fork PR 的 token 没有写权限，跳过 size 标签");
    return;
  }

  const pr = await api(`/repos/${repo}/pulls/${number}`);
  const total = (pr.additions ?? 0) + (pr.deletions ?? 0);
  const desired = sizeFor(total);
  console.log(`PR #${number} 改动 ${total} 行 → ${desired}`);

  const labels = (await api(`/repos/${repo}/issues/${number}/labels`)).map((item) => item.name);
  const stale = labels.filter((name) => name.startsWith("size/") && name !== desired && name !== "size");

  for (const name of stale) {
    await api(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }
  if (!labels.includes(desired)) {
    await api(`/repos/${repo}/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [desired] }),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
