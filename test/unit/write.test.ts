import assert from "node:assert/strict";
import test from "node:test";
import type { DocReader } from "../../src/core/docx.js";
import type { DocxWriteApi } from "../../src/core/sdk-writer.js";
import { WriteConflict, runWrite, type WriteDeps, type WritePolicy } from "../../src/core/write.js";

const LIMITS = { maxBlocks: 100, maxBytes: 1_000_000 };

function setup(options: { revisionAfterWrite?: string; failSecond?: boolean } = {}) {
  let reads = 0;
  const reader: DocReader = {
    getDocument: async () => {
      reads += 1;
      const revisionId = reads > 1 ? (options.revisionAfterWrite ?? "8") : "7";
      return { title: "周报", revisionId };
    },
    listBlocks: async () => ({
      items: [
        { block_id: "b1", block_type: 2, text: { elements: [{ text_run: { content: "第一节" } }] } },
        { block_id: "b2", block_type: 2, text: { elements: [{ text_run: { content: "第二节" } }] } },
      ],
      hasMore: false,
    }),
  };

  const calls: Array<Record<string, unknown>> = [];
  const writer: DocxWriteApi = {
    async patchTextBlock(input) {
      calls.push({ kind: "patch", ...input });
      if (options.failSecond && calls.length === 2) throw new Error("接口限流");
    },
    async createTextChildren(input) {
      calls.push({ kind: "children", ...input });
      if (options.failSecond && calls.length === 2) throw new Error("接口限流");
      return ["new1"];
    },
    async createDocument(title) {
      calls.push({ kind: "document", title });
      return { documentId: "doc-new" };
    },
  };

  return { reader, writer, calls };
}

function deps(parts: ReturnType<typeof setup>, policy: Partial<WritePolicy> = {}): WriteDeps {
  return {
    reader: parts.reader,
    writer: parts.writer,
    policy: { enabled: true, confirm: "diff", requireRevisionMatch: true, ...policy },
    limits: LIMITS,
    clientToken: (seed) => `tok-${seed.length}`,
  };
}

test("diff 模式下先返回计划，不写", async () => {
  const parts = setup();
  const outcome = await runWrite(deps(parts), {
    documentId: "doc1",
    baseRevision: "7",
    ops: [{ op: "replace_text", block_id: "b1", text: "改过" }],
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.plan.length, 1);
  assert.match(outcome.plan[0] ?? "", /b1/);
  assert.deepEqual(parts.calls, []);
});

test("确认后执行并返回新版本", async () => {
  const parts = setup();
  const outcome = await runWrite(deps(parts, { confirm: "never" }), {
    documentId: "doc1",
    baseRevision: "7",
    ops: [
      { op: "replace_text", block_id: "b1", text: "改过" },
      { op: "insert_text", texts: ["新段落"], index: 1 },
    ],
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.revisionId, "8");
  assert.equal(parts.calls.length, 2);
  const [patch, children] = parts.calls;
  assert.equal(patch?.kind, "patch");
  assert.equal(patch?.text, "改过");
  assert.equal(children?.kind, "children");
  assert.deepEqual(children?.texts, ["新段落"]);
  assert.equal(children?.index, 1);
  assert.equal(children?.parentBlockId, "doc1");
  assert.ok(outcome.results.every((item) => item.ok));
});

test("版本不一致时拒绝执行", async () => {
  const parts = setup();
  await assert.rejects(
    runWrite(deps(parts), { documentId: "doc1", baseRevision: "6", ops: [{ op: "replace_text", block_id: "b1", text: "x" }] }),
    (error: unknown) => error instanceof WriteConflict && error.code === "revision_mismatch"
  );
  assert.deepEqual(parts.calls, []);
});

test("没带 base_revision 时拒绝执行", async () => {
  const parts = setup();
  await assert.rejects(
    runWrite(deps(parts), { documentId: "doc1", ops: [{ op: "replace_text", block_id: "b1", text: "x" }] }),
    (error: unknown) => error instanceof WriteConflict && error.code === "need_base_revision"
  );
});

test("写回关闭时直接拒绝", async () => {
  const parts = setup();
  await assert.rejects(
    runWrite(deps(parts, { enabled: false }), { documentId: "doc1", ops: [{ op: "create_document", title: "新文档" }] }),
    (error: unknown) => error instanceof WriteConflict && error.code === "write_disabled"
  );
});

test("替换或插入缺少文档 id 时报错", async () => {
  const parts = setup();
  await assert.rejects(
    runWrite(deps(parts), { documentId: null, ops: [{ op: "insert_text", texts: ["x"] }] }),
    (error: unknown) => error instanceof WriteConflict && error.code === "missing_document"
  );
});

test("部分失败如实汇报", async () => {
  const parts = setup({ failSecond: true });
  const outcome = await runWrite(deps(parts, { confirm: "never" }), {
    documentId: "doc1",
    baseRevision: "7",
    ops: [
      { op: "replace_text", block_id: "b1", text: "改过" },
      { op: "insert_text", texts: ["新段落"] },
    ],
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0]?.ok, true);
  assert.equal(outcome.results[1]?.ok, false);
  assert.match(outcome.results[1]?.error ?? "", /限流/);
});

test("只新建文档时不读快照", async () => {
  const parts = setup();
  let listed = 0;
  parts.reader.listBlocks = async () => {
    listed += 1;
    return { items: [], hasMore: false };
  };

  const outcome = await runWrite(deps(parts, { confirm: "never" }), {
    documentId: null,
    ops: [{ op: "create_document", title: "会议纪要" }],
  });

  assert.equal(outcome.applied, true);
  assert.equal(listed, 0);
  assert.equal(parts.calls[0]?.kind, "document");
});
