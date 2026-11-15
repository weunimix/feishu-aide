import test from "node:test";
import assert from "node:assert/strict";
import { MAX_LENGTH, validateTitle } from "./check-pr-title.mjs";

test("接受中文标题与可选 scope", () => {
  assert.deepEqual(validateTitle("ci: 固定 action 版本"), []);
  assert.deepEqual(validateTitle("feat(sync): 增加增量同步"), []);
  assert.deepEqual(validateTitle("fix(core): 修复路径清洗"), []);
});

test("接受 Dependabot 生成的英文标题", () => {
  assert.deepEqual(validateTitle("ci(deps): bump actions/checkout from 1 to 2"), []);
  assert.deepEqual(validateTitle("chore(deps-dev): bump typescript from 5.6 to 5.7"), []);
});

test("拒绝空标题与纯空白", () => {
  assert.deepEqual(validateTitle(""), ["标题为空"]);
  assert.deepEqual(validateTitle("   "), ["标题为空"]);
});

test("拒绝缺少 type 或格式错误的标题", () => {
  const errors = validateTitle("update deps");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /格式应为/);
  assert.equal(validateTitle("feat增加同步").length, 1);
  assert.equal(validateTitle("feat：中文冒号").length, 1);
});

test("拒绝大写 type 与非规范的 scope", () => {
  assert.equal(validateTitle("Feat: 大写 type").length, 1);
  assert.equal(validateTitle("feat(Sync): 大写 scope").length, 1);
  assert.equal(validateTitle("feat(): 空 scope").length, 1);
});

test("拒绝标题结尾的句号", () => {
  const errors = validateTitle("fix: 修复路径。");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /不要加句号/);
});

test("长度上限按字符数计算", () => {
  const exact = `ci: ${"改".repeat(MAX_LENGTH - 4)}`;
  assert.deepEqual(validateTitle(exact), []);
  const tooLong = `ci: ${"改".repeat(MAX_LENGTH - 3)}`;
  const errors = validateTitle(tooLong);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /超过 72 上限/);
});

test("Dependabot 分组标题超长时只跳过长度检查", () => {
  const grouped =
    "chore(deps-dev): bump the dev-dependencies group across 1 directory with 2 updates";
  assert.equal([...grouped].length, 82);
  assert.deepEqual(validateTitle(grouped, { skipLengthCheck: true }), []);
  assert.equal(validateTitle(grouped).length, 1);
});
