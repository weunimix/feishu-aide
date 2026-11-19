import test from "node:test";
import assert from "node:assert/strict";

import { filesFromTarListing, sourceOfDistFile, validatePack } from "./check-pack.mjs";

const COMPLETE_PACK = [
  "package.json",
  "cordis.patch.yml",
  "LICENSE",
  "README.md",
  "dist/index.js",
  "dist/plugin.js",
  "dist/core/auth.js",
];

const SOURCES = new Set(["src/index.ts", "src/plugin.ts", "src/core/auth.ts"]);

test("完整的发布物没有问题", () => {
  assert.deepEqual(validatePack({ files: COMPLETE_PACK, srcFiles: SOURCES }), []);
});

test("缺少入口或组合包声明时报错", () => {
  const problems = validatePack({
    files: ["package.json", "LICENSE", "README.md", "dist/index.js"],
    srcFiles: SOURCES,
  });
  assert.ok(problems.some((problem) => problem.includes("dist/plugin.js")), problems.join("; "));
  assert.ok(problems.some((problem) => problem.includes("cordis.patch.yml")), problems.join("; "));
});

test("源码、测试与脚本不能进包", () => {
  const problems = validatePack({
    files: [...COMPLETE_PACK, "src/core/auth.ts", "test/unit/auth.test.ts", "scripts/check-pack.mjs"],
    srcFiles: SOURCES,
  });
  assert.equal(problems.length, 3, problems.join("; "));
  assert.ok(problems.every((problem) => problem.includes("不应打包")));
});

test("发现 dist 里源码已删除的陈旧产物", () => {
  const problems = validatePack({
    files: [...COMPLETE_PACK, "dist/core/feishu-client.js"],
    srcFiles: SOURCES,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /陈旧产物/);
  assert.match(problems[0] ?? "", /src\/core\/feishu-client\.ts/);
});

test("d.ts 与 map 不参与源码对应检查", () => {
  assert.equal(sourceOfDistFile("dist/core/auth.d.ts"), null);
  assert.equal(sourceOfDistFile("dist/core/auth.js.map"), null);
  assert.equal(sourceOfDistFile("dist/core/auth.js"), "src/core/auth.ts");
});

test("tar 列表去掉顶层 package/ 前缀与目录项", () => {
  const listing = ["package/", "package/package.json", "package/dist/index.js", "package/README.md", ""].join("\r\n");
  assert.deepEqual(filesFromTarListing(listing), ["package.json", "dist/index.js", "README.md"]);
});
