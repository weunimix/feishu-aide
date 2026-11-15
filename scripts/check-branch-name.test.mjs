import test from "node:test";
import assert from "node:assert/strict";

import { validateBranchName } from "./check-branch-name.mjs";

const reject = (name, context) => {
  const errors = validateBranchName(name, context);
  assert.ok(errors.length > 0, `应拒绝：${name}`);
  assert.match(errors[0], /不符合约定|分支名为空/);
};

test("接受 <type>/<kebab-slug>", () => {
  assert.deepEqual(validateBranchName("ci/branch-name-check"), []);
  assert.deepEqual(validateBranchName("feat/sync-incremental-cache"), []);
});

test("接受全部约定的 type", () => {
  for (const type of ["feat", "fix", "docs", "ci", "refactor", "chore", "hotfix"]) {
    assert.deepEqual(validateBranchName(`${type}/some-change`), [], type);
  }
});

test("拒绝缺少 type 的分支名", () => {
  reject("main");
  reject("tmp");
});

test("拒绝大写、下划线、点与空 slug", () => {
  reject("ci/Foo");
  reject("ci/foo_bar");
  reject("ci/foo.bar");
  reject("ci/foo-");
  reject("ci/");
});

test("拒绝未知 type 与多级路径", () => {
  reject("feature/foo");
  reject("ci/foo/bar");
});

test("空分支名单独报错", () => {
  assert.deepEqual(validateBranchName(""), ["分支名为空"]);
});

test("跳过 Dependabot 与 Renovate 作者", () => {
  assert.deepEqual(validateBranchName("dependabot/npm_and_yarn/tsx-4.21.0", { author: "dependabot[bot]" }), []);
  assert.deepEqual(validateBranchName("renovate/tsx-4.x", { author: "renovate[bot]" }), []);
});

test("即使作者不是 bot，也跳过 bot 分支前缀", () => {
  assert.deepEqual(validateBranchName("dependabot/npm_and_yarn/tsx-4.21.0", { author: "weunimix" }), []);
});

test("fork 出来的 PR 不校验", () => {
  assert.deepEqual(validateBranchName("my-fork-branch", { author: "someone", isFork: true }), []);
});
