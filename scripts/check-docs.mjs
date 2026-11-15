#!/usr/bin/env node
/**
 * 文档块与源码的映射检查。
 *
 * 每篇文档（README.md 与 docs/ 下的 *.md）的二级标题（`##`）构成一个块，
 * 块内必须用 HTML 注释声明它描述哪些源码文件：
 *
 *   ## 增量同步 {#sync-incremental}
 *   <!-- src: src/sync/incremental.ts, src/sync/cursor.ts -->
 *
 * 不描述代码的块（计划、决策、流程说明）显式写 `<!-- src: none -->`，
 * 不允许缺省：缺省会让“漏写映射”和“不需要映射”无法区分。
 *
 * 为什么不用中心 doc-map.json 维护映射：映射和内容必须同生共死。写在块里，
 * 文件改名/删除会变成悬空引用，可以被断言；写在中心 JSON 里，腐化了也没人发现。
 *
 * 这个检查断言的是事实，不是动作：
 *   1. 每个块都有 src 标注（none 也算）；
 *   2. 每个被引用的路径存在、是仓库内相对路径、不是目录；
 *   3. src/ 下每个 .ts 至少被一个块引用（豁免必须写进 doc-coverage-ignore.json 并带理由）；
 *   4. 提交的 docs/doc-map.json 与文档内容一致（它由本脚本生成，不要手改）。
 *
 * 因此“随便在文档里加一句”无法让它变绿——绕过方式只有补真实映射或显式豁免。
 *
 * 检查范围不含 AGENTS.md、CONTRIBUTING.md 与 PR 模板：它们是流程文档，
 * 不描述源码，强制它们写 `src: none` 只会制造噪音。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = "docs/doc-map.json";
const IGNORE_PATH = "docs/doc-coverage-ignore.json";

/** @typedef {{doc: string, anchor: string, heading: string, line: number, src: string[], none: boolean, annotated: boolean}} Block */
/** @typedef {{doc: string, line: number, message: string}} Problem */

/** @param {string} text */
export function slugify(text) {
  return (
    text
      .toLowerCase()
      // 去掉标点（含中文标点），保留字母、数字、空白与连字符
      .replace(/[`~!@#$%^&*()[\]{}|\\:;"'<>,.?/，。！？、；：“”‘’《》【】（）—-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * 解析一篇文档里的块。纯函数，不读文件系统。
 * @param {string} text
 * @param {string} doc 仓库相对路径，例如 README.md
 * @returns {{blocks: Block[], problems: Problem[]}}
 */
export function parseDoc(text, doc) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const problems = [];
  /** @type {Block|null} */
  let current = null;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^##(?!#)\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const raw = heading[1].trim();
      const explicit = /^(.*?)\s*\{#([A-Za-z0-9_-]+)\}$/.exec(raw);
      const title = explicit ? explicit[1].trim() : raw;
      current = {
        doc,
        anchor: explicit ? explicit[2] : slugify(title),
        heading: title,
        line: index + 1,
        src: [],
        none: false,
        annotated: false,
      };
      blocks.push(current);
      continue;
    }

    const annotation = /^<!--\s*src:\s*(.+?)\s*-->$/.exec(line.trim());
    if (annotation) {
      const value = annotation[1].trim();
      if (!current) {
        problems.push({ doc, line: index + 1, message: "src 标注必须位于某个二级标题之下" });
        continue;
      }
      current.annotated = true;
      if (/^none$/i.test(value)) {
        current.none = true;
      } else {
        current.src.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      }
    }
  }

  const seen = new Map();
  for (const block of blocks) {
    const duplicate = seen.get(block.anchor);
    if (duplicate) {
      problems.push({
        doc,
        line: block.line,
        message: `锚点 "${block.anchor}" 与第 ${duplicate.line} 行重复，请用 {#anchor} 显式指定`,
      });
    } else {
      seen.set(block.anchor, block);
    }
  }

  return { blocks, problems };
}

/**
 * 规范化一条 src 引用；返回 {value} 或 {error}。
 * @param {string} raw
 * @returns {{value?: string, error?: string}}
 */
export function normalizeRef(raw) {
  const value = raw.trim();
  if (!value) return { error: "src 引用为空" };
  if (value.includes("\\")) return { error: `src 引用必须用 / 分隔：${value}` };
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return { error: `src 引用必须是仓库相对路径：${value}` };
  const withoutDot = value.startsWith("./") ? value.slice(2) : value;
  if (withoutDot.split("/").some((segment) => segment === "..")) return { error: `src 引用不能逃出仓库：${value}` };
  if (withoutDot.endsWith("/")) return { error: `src 引用必须是文件而不是目录：${value}` };
  return { value: withoutDot };
}

/**
 * 校验所有文档块。exists/kind 由调用方注入，方便单测。
 * @param {{docs: Array<{doc: string, blocks: Block[]}>, problems?: Problem[], kind: (rel: string) => "file"|"dir"|null, srcFiles: string[], ignore?: Record<string, string>}} input
 * @returns {Problem[]}
 */
export function validateBlocks({ docs, problems = [], kind, srcFiles, ignore = {} }) {
  const issues = [...problems];
  const covered = new Set();

  for (const { doc, blocks } of docs) {
    for (const block of blocks) {
      if (!block.annotated) {
        issues.push({ doc, line: block.line, message: `块「${block.heading}」缺少 src 标注（可写 <!-- src: none -->）` });
        continue;
      }
      if (block.none && block.src.length > 0) {
        issues.push({ doc, line: block.line, message: `块「${block.heading}」同时声明了 none 和文件路径` });
      }
      for (const raw of block.src) {
        const normalized = normalizeRef(raw);
        if (normalized.error) {
          issues.push({ doc, line: block.line, message: normalized.error });
          continue;
        }
        const rel = normalized.value;
        const fileKind = kind(rel);
        if (fileKind === null) {
          issues.push({ doc, line: block.line, message: `src 引用不存在：${rel}` });
          continue;
        }
        if (fileKind !== "file") {
          issues.push({ doc, line: block.line, message: `src 引用必须是文件：${rel}` });
          continue;
        }
        covered.add(rel);
      }
    }
  }

  for (const [rel, reason] of Object.entries(ignore)) {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      issues.push({ doc: IGNORE_PATH, line: 0, message: `豁免 ${rel} 必须写明理由` });
    }
    if (!srcFiles.includes(rel)) {
      issues.push({ doc: IGNORE_PATH, line: 0, message: `豁免项已失效（文件不存在或不在 src/ 下）：${rel}` });
    }
    if (covered.has(rel)) {
      issues.push({ doc: IGNORE_PATH, line: 0, message: `豁免项已被文档引用，应当删除：${rel}` });
    }
  }

  for (const rel of srcFiles) {
    if (covered.has(rel)) continue;
    if (Object.hasOwn(ignore, rel)) continue;
    issues.push({
      doc: "",
      line: 0,
      message: `源码文件没有被任何文档块引用：${rel}（在合适文档中标注，或在 ${IGNORE_PATH} 写明豁免理由）`,
    });
  }

  return issues;
}

/**
 * 生成提交用的索引。块的顺序与文档内一致，src 去重后排序，保证输出稳定。
 * @param {Array<{doc: string, blocks: Block[]}>} docs
 */
export function buildDocMap(docs) {
  const map = {};
  for (const { doc, blocks } of [...docs].sort((a, b) => a.doc.localeCompare(b.doc))) {
    map[doc] = blocks.map((block) => ({
      anchor: block.anchor,
      heading: block.heading,
      src: [...new Set(block.src)].sort(),
    }));
  }
  return { generatedBy: "scripts/check-docs.mjs", docs: map };
}

/**
 * 找出改动某个路径会影响哪些文档块。query 可以是文件或目录。
 * @param {Array<{doc: string, blocks: Block[]}>} docs
 * @param {string} query
 */
export function findImpact(docs, query) {
  const normalized = query.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const hits = [];
  for (const { doc, blocks } of docs) {
    for (const block of blocks) {
      const matched = block.src.some((rel) => rel === normalized || rel.startsWith(`${normalized}/`));
      if (matched) hits.push({ doc, anchor: block.anchor, heading: block.heading, src: block.src });
    }
  }
  return hits;
}

/**
 * @param {string} root
 * @param {string} relDir
 * @param {(name: string) => boolean} accept
 * @returns {string[]} 仓库相对路径（/ 分隔）
 */
export function listFiles(root, relDir, accept) {
  const found = [];
  const stack = [relDir];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile() && accept(entry.name)) found.push(childRel);
    }
  }
  return found.sort();
}

/** 检查的文档集合：README.md + docs/**\/*.md */
export function listDocFiles(root = ROOT) {
  return ["README.md", ...listFiles(root, "docs", (name) => name.endsWith(".md"))].sort();
}

/** @param {string} root */
export function listSrcFiles(root = ROOT) {
  return listFiles(root, "src", (name) => name.endsWith(".ts"));
}

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

/** @param {unknown} a @param {unknown} b */
export function sameJson(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function formatProblem(problem) {
  return problem.line > 0 ? `${problem.doc}:${problem.line}: ${problem.message}` : `${problem.doc || "coverage"}: ${problem.message}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "用法：node scripts/check-docs.mjs [--write]\n\n" +
        "检查 README.md 与 docs/ 下每个二级标题块的 src 标注、引用有效性、\n" +
        "src/ 覆盖率，以及 docs/doc-map.json 是否与文档一致。\n" +
        "--write 重新生成 docs/doc-map.json（提交前运行）。\n"
    );
    return;
  }
  const write = args.includes("--write");

  const docs = listDocFiles().map((doc) => {
    const text = readFileSync(path.join(ROOT, doc), "utf8");
    const parsed = parseDoc(text, doc);
    return { doc, blocks: parsed.blocks, problems: parsed.problems };
  });

  const srcFiles = listSrcFiles();
  const kind = (rel) => {
    try {
      const stat = statSync(path.join(ROOT, rel));
      return stat.isFile() ? "file" : "dir";
    } catch {
      return null;
    }
  };

  let ignore = {};
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, IGNORE_PATH), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) ignore = raw;
    else throw new Error("顶层必须是对象");
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error(`${IGNORE_PATH} 无法解析：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const problems = validateBlocks({
    docs,
    problems: docs.flatMap((entry) => entry.problems),
    kind,
    srcFiles,
    ignore,
  });

  const generated = buildDocMap(docs);
  const blockCount = docs.reduce((sum, entry) => sum + entry.blocks.length, 0);

  if (write) {
    writeFileSync(path.join(ROOT, MAP_PATH), `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    console.log(`doc-map 已生成：${blockCount} 个块，${srcFiles.length} 个源码文件`);
  } else {
    let committed = null;
    try {
      committed = JSON.parse(readFileSync(path.join(ROOT, MAP_PATH), "utf8"));
    } catch (error) {
      problems.push({
        doc: MAP_PATH,
        line: 0,
        message: `无法读取或解析（${error instanceof Error ? error.message : String(error)}）；运行 pnpm docs:map 生成`,
      });
    }
    if (committed !== null && !sameJson(committed, generated)) {
      problems.push({ doc: MAP_PATH, line: 0, message: "与文档不一致；运行 pnpm docs:map 重新生成并提交" });
    }
  }

  if (problems.length === 0) {
    console.log(
      `文档块检查通过：${docs.length} 篇文档，${blockCount} 个块，${srcFiles.length} 个源码文件全部有归属`
    );
    return;
  }

  for (const problem of problems) console.error(formatProblem(problem));
  console.error(`文档块检查失败：${problems.length} 个问题`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-docs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
