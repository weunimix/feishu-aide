import test from "node:test";
import assert from "node:assert/strict";

import { sizeFor } from "./label-pr-size.mjs";

test("按边界选择 size 标签", () => {
  assert.equal(sizeFor(0), "size/xs");
  assert.equal(sizeFor(10), "size/xs");
  assert.equal(sizeFor(11), "size/s");
  assert.equal(sizeFor(50), "size/s");
  assert.equal(sizeFor(51), "size/m");
  assert.equal(sizeFor(200), "size/m");
  assert.equal(sizeFor(201), "size/l");
  assert.equal(sizeFor(500), "size/l");
  assert.equal(sizeFor(501), "size/xl");
});

test("非法输入按 0 处理", () => {
  assert.equal(sizeFor(undefined), "size/xs");
  assert.equal(sizeFor(-5), "size/xs");
});
