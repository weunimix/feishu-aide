#!/usr/bin/env node
/**
 * 查询“改这个文件会影响哪些文档块”。
 *
 * 用法：
 *   node scripts/doc-impact.mjs src/core/path-safety.ts
 *   node scripts/doc-impact.mjs src/sync            # 目录按前缀匹配
 *   node scripts/doc-impact.mjs --json src/sync/a.ts
 *
 * 映射直接从文档块里的 `<!-- src: ... -->` 标注现算，不依赖 docs/doc-map.json，
 * 因此在未提交/本地修改的文档上也成立。输出是给 agent 的阅读清单，不是门禁：
 * 没人能靠“碰一下文档”让这个查询给出错误答案——它不检查动作，只回答归属。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findImpact, listDocFiles, parseDoc } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDocs() {
  return listDocFiles().map((doc) => {
    const text = readFileSync(path.join(ROOT, doc), "utf8");
    return { doc, blocks: parseDoc(text, doc).blocks };
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "用法：node scripts/doc-impact.mjs [--json] <文件或目录> [更多路径…]\n\n" +
        "列出改动这些路径时会影响的文档块（来自文档中的 src 标注）。\n"
    );
    process.exitCode = args.length === 0 ? 2 : 0;
    return;
  }

  const json = args.includes("--json");
  const queries = args.filter((arg) => arg !== "--json");
  const docs = loadDocs();

  const results = queries.map((query) => ({ query, hits: findImpact(docs, query) }));

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  let missing = 0;
  for (const { query, hits } of results) {
    if (hits.length === 0) {
      missing += 1;
      console.log(`${query}：没有文档块引用它`);
      continue;
    }
    console.log(`${query}：影响 ${hits.length} 个文档块`);
    for (const hit of hits) {
      console.log(`  - ${hit.doc}#${hit.anchor}  ${hit.heading}`);
    }
  }

  if (missing === queries.length) {
    console.error("没有命中任何文档块：确认路径拼写，或该文件尚未在文档中登记。");
    process.exitCode = 1;
  }
}

main();
