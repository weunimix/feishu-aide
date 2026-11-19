import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentSnapshot } from "../../src/core/docx.js";
import { WriteError, planWrite, summarizePlan } from "../../src/core/write-plan.js";

const SNAPSHOT: DocumentSnapshot = {
  documentId: "doc1",
  revisionId: "7",
  title: "周报",
  markdown: "第一节\n\n第二节",
  truncated: false,
  blocks: [
    { block_id: "b1", block_type: 2, text: "第一节" },
    { block_id: "b2", block_type: 3, text: "小标题" },
    { block_id: "t1", block_type: 31, text: "表格" },
  ],
};

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof WriteError && error.code === code);
}

test("替换文本块时保留修改前的文本", () => {
  const planned = planWrite(SNAPSHOT, [{ op: "replace_text", block_id: "b1", text: "改过的第一节" }]);
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0], {
    kind: "replace_text",
    blockId: "b1",
    text: "改过的第一节",
    before: "第一节",
  });
});

test("空操作列表直接拒绝", () => {
  expectCode(() => planWrite(SNAPSHOT, []), "empty_ops");
  expectCode(() => planWrite(SNAPSHOT, undefined), "empty_ops");
});

test("未知块与非文本块都拒绝", () => {
  expectCode(() => planWrite(SNAPSHOT, [{ op: "replace_text", block_id: "nope", text: "x" }]), "missing_block");
  expectCode(() => planWrite(SNAPSHOT, [{ op: "replace_text", block_id: "t1", text: "x" }]), "unsupported_block");
});

test("插入块的参数校验", () => {
  expectCode(() => planWrite(SNAPSHOT, [{ op: "insert_text", texts: [] }]), "invalid_arguments");
  expectCode(() => planWrite(SNAPSHOT, [{ op: "insert_text", texts: [""] }]), "invalid_arguments");
  expectCode(
    () => planWrite(SNAPSHOT, [{ op: "insert_text", texts: ["正文"], index: -1 }]),
    "invalid_arguments"
  );
  expectCode(
    () => planWrite(SNAPSHOT, [{ op: "insert_text", texts: ["正文"], parent_block_id: "nope" }]),
    "missing_block"
  );
});

test("插入块缺省父块与索引", () => {
  const planned = planWrite(SNAPSHOT, [{ op: "insert_text", texts: ["新段落"] }]);
  assert.deepEqual(planned[0], { kind: "insert_text", parentBlockId: "", index: null, texts: ["新段落"] });
});

test("新建文档不依赖快照", () => {
  const planned = planWrite(null, [{ op: "create_document", title: "  会议纪要  " }]);
  assert.deepEqual(planned[0], { kind: "create_document", title: "会议纪要" });
  expectCode(() => planWrite(null, [{ op: "create_document", title: "  " }]), "invalid_arguments");
});

test("不认识的操作名报 unknown_op", () => {
  expectCode(() => planWrite(SNAPSHOT, [{ op: "delete_block" }]), "unknown_op");
});

test("计划摘要能说清楚每个操作", () => {
  const planned = planWrite(SNAPSHOT, [
    { op: "replace_text", block_id: "b1", text: "第二节" },
    { op: "insert_text", texts: ["新块"] },
    { op: "create_document", title: "新文档" },
  ]);
  const lines = summarizePlan(planned);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /b1/);
  assert.match(lines[1] ?? "", /文档末尾/);
  assert.match(lines[2] ?? "", /新文档/);
});
