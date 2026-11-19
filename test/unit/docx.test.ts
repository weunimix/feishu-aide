import assert from "node:assert/strict";
import test from "node:test";
import { DocReadError, extractDocRef, readDocument, type DocReader } from "../../src/core/docx.js";
import type { FeishuBlock } from "../../src/core/markdown.js";

const LIMITS = { maxBlocks: 100, maxBytes: 1_000_000 };

function fakeReader(overrides: Partial<DocReader> = {}): DocReader {
  return {
    getDocument: async () => ({ title: "设计稿", revisionId: "42" }),
    listBlocks: async () => ({ items: [], hasMore: false }),
    ...overrides,
  };
}

test("从 URL 与裸 token 解析文档引用", () => {
  assert.deepEqual(extractDocRef("https://example.feishu.cn/docx/AbC123?from=x"), {
    kind: "docx",
    token: "AbC123",
  });
  assert.deepEqual(extractDocRef("https://example.feishu.cn/wiki/Wk9"), { kind: "wiki", token: "Wk9" });
  assert.deepEqual(extractDocRef("AbC123"), { kind: "token", token: "AbC123" });
});

test("无法识别的引用报 invalid_ref", () => {
  assert.throws(() => extractDocRef("   "), (error: unknown) => {
    return error instanceof DocReadError && error.code === "invalid_ref";
  });
  assert.throws(() => extractDocRef("https://example.com/unknown/x"), (error: unknown) => {
    return error instanceof DocReadError && error.code === "invalid_ref";
  });
});

test("按页拉取直到 has_more 为假", () => {
  const pages: Record<string, FeishuBlock[]> = {
    "": [{ block_id: "1", block_type: 2, text: { elements: [{ text_run: { content: "甲" } }] } }],
    next: [{ block_id: "2", block_type: 2, text: { elements: [{ text_run: { content: "乙" } }] } }],
  };
  const reader = fakeReader({
    listBlocks: async (_id, token) => {
      const page = { items: pages[token ?? ""] ?? [], hasMore: !token };
      return token ? page : { ...page, pageToken: "next" };
    },
  });

  return readDocument(reader, "AbC", LIMITS).then((snapshot) => {
    assert.equal(snapshot.markdown, "甲\n\n乙");
    assert.equal(snapshot.revisionId, "42");
    assert.equal(snapshot.title, "设计稿");
    assert.equal(snapshot.truncated, false);
    assert.equal(snapshot.blocks.length, 2);
  });
});

test("超过块数上限即截断并标记", async () => {
  const items: FeishuBlock[] = Array.from({ length: 5 }, (_, index) => ({
    block_id: String(index),
    block_type: 2,
    text: { elements: [{ text_run: { content: `第${index}段` } }] },
  }));
  const reader = fakeReader({ listBlocks: async () => ({ items, hasMore: true, pageToken: "next" }) });

  const snapshot = await readDocument(reader, "AbC", { maxBlocks: 3, maxBytes: 1_000_000 });
  assert.equal(snapshot.blocks.length, 3);
  assert.equal(snapshot.truncated, true);
});

test("超过字节上限报 too_large", async () => {
  const reader = fakeReader({
    listBlocks: async () => ({
      items: [{ block_id: "1", block_type: 2, text: { elements: [{ text_run: { content: "x".repeat(5000) } }] } }],
      hasMore: false,
    }),
  });

  await assert.rejects(
    readDocument(reader, "AbC", { maxBlocks: 100, maxBytes: 1024 }),
    (error: unknown) => error instanceof DocReadError && error.code === "too_large"
  );
});
