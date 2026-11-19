import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeFeishuServer } from "../helpers/fake-feishu.js";
import { FileDocumentCache } from "../../src/core/cache.js";
import { readDocumentCached } from "../../src/core/docx.js";
import { createSdkReader } from "../../src/core/sdk-reader.js";

const TEXT_BLOCK = { block_id: "blk_text", block_type: 2, text: { elements: [{ text_run: { content: "第一段" } }] } };

test("同一版本第二次读取命中缓存：块接口只请求一次，元信息每次确认", async () => {
  const server = new FakeFeishuServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-aide-cache-e2e-"));
  await server.start();
  try {
    server.fixtures.documents["DocAbc"] = { title: "季度总结", revisionId: "42", blocks: [TEXT_BLOCK] };
    const reader = createSdkReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });
    const cache = new FileDocumentCache(dir);
    const limits = { maxBlocks: 100, maxBytes: 100_000 };

    const first = await readDocumentCached(reader, "DocAbc", limits, { cache, ttlSeconds: 600 });
    const second = await readDocumentCached(reader, "DocAbc", limits, { cache, ttlSeconds: 600 });

    assert.equal(first.fromCache, undefined);
    assert.equal(second.fromCache, true);
    assert.equal(second.markdown, "第一段");
    assert.equal(second.revisionId, "42");

    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc").length, 2);
    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks").length, 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("版本变化后重新拉块，返回新内容", async () => {
  const server = new FakeFeishuServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-aide-cache-e2e-"));
  await server.start();
  try {
    server.fixtures.documents["DocAbc"] = { title: "季度总结", revisionId: "42", blocks: [TEXT_BLOCK] };
    const reader = createSdkReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });
    const cache = new FileDocumentCache(dir);
    const limits = { maxBlocks: 100, maxBytes: 100_000 };

    await readDocumentCached(reader, "DocAbc", limits, { cache, ttlSeconds: 600 });
    server.fixtures.documents["DocAbc"] = {
      title: "季度总结",
      revisionId: "43",
      blocks: [{ block_id: "blk_text", block_type: 2, text: { elements: [{ text_run: { content: "改过的第一段" } }] } }],
    };
    const second = await readDocumentCached(reader, "DocAbc", limits, { cache, ttlSeconds: 600 });

    assert.equal(second.fromCache, undefined);
    assert.equal(second.revisionId, "43");
    assert.equal(second.markdown, "改过的第一段");
    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks").length, 2);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
