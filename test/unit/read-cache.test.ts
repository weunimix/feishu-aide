import assert from "node:assert/strict";
import test from "node:test";
import { MemoryDocumentCache } from "../../src/core/cache.js";
import { readDocumentCached, type DocReader } from "../../src/core/docx.js";
import type { FeishuBlock } from "../../src/core/markdown.js";

type CountingReader = DocReader & { docCalls: number; blockCalls: number };

function makeReader(state: { revisionId: string; blocks: FeishuBlock[] }): CountingReader {
  const reader: CountingReader = {
    docCalls: 0,
    blockCalls: 0,
    async getDocument() {
      reader.docCalls += 1;
      return { title: "测试文档", revisionId: state.revisionId };
    },
    async listBlocks() {
      reader.blockCalls += 1;
      return { items: state.blocks, hasMore: false };
    },
  };
  return reader;
}

const LIMITS = { maxBlocks: 500, maxBytes: 262_144 };

function blocks(text: string): FeishuBlock[] {
  return [{ block_id: "blk_text", block_type: 2, text: { elements: [{ text_run: { content: text } }] } }];
}

test("同一版本第二次读取命中缓存，不再翻页拉块", async () => {
  const reader = makeReader({ revisionId: "10", blocks: blocks("第一段") });
  const cache = new MemoryDocumentCache();

  const first = await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 60 });
  const second = await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 60 });

  assert.equal(reader.blockCalls, 1);
  assert.equal(reader.docCalls, 2);
  assert.equal(first.fromCache, undefined);
  assert.equal(second.fromCache, true);
  assert.equal(second.markdown, "第一段");
  assert.equal(second.revisionId, "10");
});

test("版本变化后不复用旧缓存", async () => {
  const state = { revisionId: "10", blocks: blocks("第一段") };
  const reader = makeReader(state);
  const cache = new MemoryDocumentCache();

  await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 60 });
  state.revisionId = "11";
  state.blocks = blocks("改过的第一段");
  const fresh = await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 60 });

  assert.equal(reader.blockCalls, 2);
  assert.equal(fresh.fromCache, undefined);
  assert.equal(fresh.revisionId, "11");
  assert.equal(fresh.markdown, "改过的第一段");
});

test("ttl 为 0 时完全不使用缓存", async () => {
  const reader = makeReader({ revisionId: "10", blocks: blocks("第一段") });
  const cache = new MemoryDocumentCache();

  await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 0 });
  const second = await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 0 });

  assert.equal(reader.blockCalls, 2);
  assert.equal(second.fromCache, undefined);
});

test("读取预算不同时各自成键，不互相污染", async () => {
  const reader = makeReader({ revisionId: "10", blocks: blocks("第一段") });
  const cache = new MemoryDocumentCache();

  await readDocumentCached(reader, "DocAbc", { maxBlocks: 1, maxBytes: 262_144 }, { cache, ttlSeconds: 60 });
  const wider = await readDocumentCached(reader, "DocAbc", LIMITS, { cache, ttlSeconds: 60 });

  assert.equal(reader.blockCalls, 2);
  assert.equal(wider.fromCache, undefined);
});

test("缓存写入失败不影响读取结果", async () => {
  const reader = makeReader({ revisionId: "10", blocks: blocks("第一段") });
  const broken = {
    async get() {
      return null;
    },
    async set() {
      throw new Error("磁盘满了");
    },
    async prune() {
      throw new Error("目录不可用");
    },
    async clear() {
      throw new Error("目录不可用");
    },
  };

  const snapshot = await readDocumentCached(reader, "DocAbc", LIMITS, { cache: broken, ttlSeconds: 60 });
  assert.equal(snapshot.markdown, "第一段");
});
