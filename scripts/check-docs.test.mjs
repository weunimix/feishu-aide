#!/usr/bin/env node
/**
 * check-docs 的纯函数单测：解析、路径规范化、覆盖率、索引与影响查询。
 * 运行：node scripts/check-docs.test.mjs（CI 里由 pnpm test:policy 收集）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDocMap,
  findImpact,
  normalizeRef,
  parseDoc,
  sameJson,
  slugify,
  validateBlocks,
} from "./check-docs.mjs";

const DOC = "docs/example.md";

test("parseDoc 收集块、标注与显式锚点", () => {
  const text = [
    "# 标题",
    "",
    "## 同步 {#sync}",
    "<!-- src: src/sync/a.ts, src/sync/b.ts -->",
    "",
    "正文",
    "",
    "## 计划",
    "<!-- src: none -->",
    "",
  ].join("\n");

  const { blocks, problems } = parseDoc(text, DOC);

  assert.deepEqual(problems, []);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    doc: DOC,
    anchor: "sync",
    heading: "同步",
    line: 3,
    src: ["src/sync/a.ts", "src/sync/b.ts"],
    none: false,
    annotated: true,
  });
  assert.deepEqual(blocks[1].src, []);
  assert.equal(blocks[1].none, true);
});

test("parseDoc 忽略代码块里的标题与标注", () => {
  const text = ["## 真块", "<!-- src: none -->", "```sh", "## 假标题", "<!-- src: src/x.ts -->", "```", ""].join(
    "\n"
  );

  const { blocks } = parseDoc(text, DOC);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].heading, "真块");
  assert.deepEqual(blocks[0].src, []);
});

test("parseDoc 拒绝出现在首个二级标题之前的标注", () => {
  const { problems } = parseDoc(["# 标题", "<!-- src: none -->", ""].join("\n"), DOC);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /二级标题/);
});

test("parseDoc 拒绝重复锚点", () => {
  const text = ["## 同名", "<!-- src: none -->", "## 同名", "<!-- src: none -->", ""].join("\n");
  const { problems } = parseDoc(text, DOC);

  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /重复/);
});

test("slugify 去掉中英文标点并合并空白", () => {
  assert.equal(slugify("目标能力（尚未实现）"), "目标能力尚未实现");
  assert.equal(slugify("Docs  SSOT / 文档"), "docs-ssot-文档");
  assert.equal(slugify("###"), "section");
});

test("normalizeRef 拒绝逃逸、绝对路径、反斜杠与目录", () => {
  assert.deepEqual(normalizeRef("./src/a.ts"), { value: "src/a.ts" });
  assert.match(normalizeRef("../a.ts").error, /逃出仓库/);
  assert.match(normalizeRef("/etc/passwd").error, /相对路径/);
  assert.match(normalizeRef("C:/x").error, /相对路径/);
  assert.match(normalizeRef("src\\a.ts").error, /用 \/ 分隔/);
  assert.match(normalizeRef("src/").error, /目录/);
});

test("validateBlocks 要求每个块有标注，且不能混用 none 与路径", () => {
  const text = ["## 有标注", "<!-- src: none -->", "## 缺标注", "正文", ""].join("\n");
  const { blocks } = parseDoc(text, DOC);
  const kind = () => "file";

  const issues = validateBlocks({ docs: [{ doc: DOC, blocks }], kind, srcFiles: [] });

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /缺少 src 标注/);

  const mixed = parseDoc(["## 混用", "<!-- src: none -->", "<!-- src: src/a.ts -->", ""].join("\n"), DOC);
  const mixedIssues = validateBlocks({
    docs: [{ doc: DOC, blocks: mixed.blocks }],
    kind,
    srcFiles: ["src/a.ts"],
  });
  assert.match(mixedIssues[0].message, /同时声明/);
});

test("validateBlocks 检查引用存在性、类型与覆盖率", () => {
  const text = [
    "## 已有",
    "<!-- src: src/a.ts -->",
    "## 缺失",
    "<!-- src: src/missing.ts -->",
    "## 目录",
    "<!-- src: src/core -->",
    "",
  ].join("\n");
  const { blocks } = parseDoc(text, DOC);
  const kind = (rel) => (rel === "src/core" ? "dir" : rel === "src/a.ts" ? "file" : null);

  const issues = validateBlocks({
    docs: [{ doc: DOC, blocks }],
    kind,
    srcFiles: ["src/a.ts", "src/b.ts"],
  });

  const messages = issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /src 引用不存在：src\/missing\.ts/);
  assert.match(messages, /必须是文件：src\/core/);
  assert.match(messages, /没有被任何文档块引用：src\/b\.ts/);
  assert.doesNotMatch(messages, /src\/a\.ts/);
});

test("validateBlocks 的豁免必须带理由、存在且未被引用", () => {
  const text = ["## 已引用", "<!-- src: src/a.ts -->", ""].join("\n");
  const { blocks } = parseDoc(text, DOC);
  const kind = (rel) => (rel === "src/a.ts" || rel === "src/c.ts" ? "file" : null);

  const issues = validateBlocks({
    docs: [{ doc: DOC, blocks }],
    kind,
    srcFiles: ["src/a.ts", "src/c.ts"],
    ignore: { "src/a.ts": "已被引用", "src/c.ts": "  ", "src/gone.ts": "已删除" },
  });

  const messages = issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /已被文档引用/);
  assert.match(messages, /必须写明理由/);
  assert.match(messages, /已失效/);
  assert.doesNotMatch(messages, /src\/a\.ts（/);
});

test("buildDocMap 输出去重排序且格式稳定", () => {
  const text = ["## B", "<!-- src: src/z.ts, src/a.ts, src/z.ts -->", "## A", "<!-- src: none -->", ""].join("\n");
  const { blocks } = parseDoc(text, "docs/b.md");
  const map = buildDocMap([{ doc: "docs/b.md", blocks }]);

  assert.deepEqual(map.docs["docs/b.md"], [
    { anchor: "b", heading: "B", src: ["src/a.ts", "src/z.ts"] },
    { anchor: "a", heading: "A", src: [] },
  ]);
  assert.equal(map.generatedBy, "scripts/check-docs.mjs");
});

test("findImpact 支持文件、目录与反斜杠", () => {
  const text = ["## 同步", "<!-- src: src/sync/a.ts, src/sync/b.ts -->", "## 路径", "<!-- src: src/core/path-safety.ts -->", ""].join(
    "\n"
  );
  const { blocks } = parseDoc(text, DOC);
  const docs = [{ doc: DOC, blocks }];

  assert.equal(findImpact(docs, "src/sync/a.ts").length, 1);
  assert.equal(findImpact(docs, "src/sync").length, 1);
  assert.equal(findImpact(docs, "src\\sync\\b.ts").length, 1);
  assert.equal(findImpact(docs, "src/none.ts").length, 0);
});

test("sameJson 忽略键顺序", () => {
  assert.equal(sameJson({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
  assert.equal(sameJson({ a: [{ x: 1, y: 2 }] }, { a: [{ y: 2, x: 1 }] }), true);
});
