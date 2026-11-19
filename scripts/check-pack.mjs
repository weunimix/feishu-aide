#!/usr/bin/env node
// 校验 `pnpm pack` 的产物内容：入口与组合包声明必须在，源码/测试/脚本不能进包，
// 且 dist 里不能出现 src 已删除文件的陈旧产物。
//
// 为什么要查「陈旧产物」：`pnpm build` 只做 tsc，不清空 dist。删过源码文件之后
// 再打包，旧的 .js 仍会被 `files: ["dist"]` 收进 tarball——Node 不会加载它，
// 但它会跟着发布物一起进用户的 node_modules，且没有任何检查会发现。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 包里必须存在的文件：入口、组合包声明、许可与说明。 */
export const REQUIRED_FILES = [
  "package.json",
  "cordis.patch.yml",
  "dist/index.js",
  "dist/plugin.js",
  "LICENSE",
  "README.md",
];

/** 这些前缀下的文件只属于仓库，不该出现在发布物里。 */
export const FORBIDDEN_PREFIXES = [
  "src/",
  "test/",
  "scripts/",
  ".github/",
  "node_modules/",
  "tmp/",
];

/** dist 产物对应的源码路径：dist/core/auth.js → src/core/auth.ts。 */
export function sourceOfDistFile(file) {
  if (!file.startsWith("dist/") || !file.endsWith(".js")) return null;
  return `src/${file.slice("dist/".length, -".js".length)}.ts`;
}

/**
 * 返回问题列表；空数组表示通过。
 * @param {{ files: string[], srcFiles: Set<string> }} input
 * @returns {string[]}
 */
export function validatePack({ files, srcFiles }) {
  const problems = [];
  const present = new Set(files);

  for (const required of REQUIRED_FILES) {
    if (!present.has(required)) problems.push(`缺少必要文件：${required}`);
  }

  for (const file of files) {
    const forbidden = FORBIDDEN_PREFIXES.find((prefix) => file.startsWith(prefix));
    if (forbidden) problems.push(`不应打包（${forbidden}）：${file}`);
  }

  for (const file of files) {
    const source = sourceOfDistFile(file);
    if (source === null || srcFiles.has(source)) continue;
    problems.push(`dist 里有源码已删除的陈旧产物：${file}（找不到 ${source}）`);
  }

  return problems;
}

/**
 * 从 `tar -tzf` 的输出里取出包内路径（去掉顶层 `package/`）。
 * @param {string} listing
 * @returns {string[]}
 */
export function filesFromTarListing(listing) {
  return String(listing)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith("package/") ? line.slice("package/".length) : line))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
}

/** 读 `src/` 下的全部 .ts 文件，作为「源码里应该有什么」的依据。 */
export function listSourceFiles(root = process.cwd()) {
  const files = new Set();
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${relative}/`);
      else if (entry.name.endsWith(".ts")) files.add(relative);
    }
  };
  walk(join(root, "src"), "src/");
  return files;
}

// Windows 上 pnpm 是 .cmd 垫片：不带 shell 直接 spawn .cmd 会 EINVAL
// （Node 修复 CVE-2024-27980 之后的既定行为），因此这里统一走 shell。
function quote(argument) {
  return /[\s"]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

function run(command, args, options = {}) {
  const line = [command, ...args.map(quote)].join(" ");
  const result = spawnSync(line, { shell: true, encoding: "utf8", ...options });
  if (result.error) throw new Error(`无法执行 ${line}：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${line} 失败（退出码 ${result.status}）：${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function packWithPnpm() {
  const directory = mkdtempSync(join(tmpdir(), "feishu-aide-pack-"));
  try {
    run("pnpm", ["pack", "--pack-destination", directory]);
    const tarball = readdirSync(directory).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("pnpm pack 没有产出 .tgz");
    // 用 cwd + 纯文件名调 tar：Git Bash 的 GNU tar 会把 `C:\...` 里的冒号
    // 当成远程主机名（Cannot connect to C），相对路径能绕开这个差异。
    return filesFromTarListing(run("tar", ["-tzf", tarball], { cwd: directory }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const fromIndex = process.argv.indexOf("--from");
  let files;
  try {
    files = fromIndex > 0 ? filesFromTarListing(readFileSync(process.argv[fromIndex + 1], "utf8")) : packWithPnpm();
  } catch (error) {
    console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const problems = validatePack({ files, srcFiles: listSourceFiles() });
  if (problems.length > 0) {
    console.error("打包产物不符合要求：");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`打包产物通过：${files.length} 个文件`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
