import assert from "node:assert/strict";
import test from "node:test";
import { FakeFeishuServer } from "../helpers/fake-feishu.js";
import { extractDocRef, readDocument } from "../../src/core/docx.js";
import { listChatMessages } from "../../src/core/messages.js";
import { createSdkMessageReader } from "../../src/core/sdk-messages.js";
import { createSdkReader } from "../../src/core/sdk-reader.js";
import { createSdkSearcher } from "../../src/core/sdk-searcher.js";
import { createSdkWriter } from "../../src/core/sdk-writer.js";
import { searchDocuments } from "../../src/core/search.js";
import { resolveDocumentId } from "../../src/core/wiki.js";

const TEXT_BLOCK = { block_id: "blk_text", block_type: 2, text: { elements: [{ text_run: { content: "第一段" } }] } };
const HEADING_BLOCK = {
  block_id: "blk_head",
  block_type: 3,
  heading1: { elements: [{ text_run: { content: "标题" } }] },
};

async function withServer(run: (server: FakeFeishuServer) => Promise<void>): Promise<void> {
  const server = new FakeFeishuServer();
  const url = await server.start();
  try {
    server.fixtures.documents["DocAbc"] = { title: "季度总结", revisionId: "42", blocks: [HEADING_BLOCK, TEXT_BLOCK] };
    server.fixtures.wikiNodes["WkToken"] = { objToken: "DocFromWiki", objType: "docx", title: "知识库节点" };
    server.fixtures.searchUnits["周报"] = [
      {
        title_highlighted: "<em>周报</em> 第 42 期",
        summary_highlighted: "本周进度",
        result_meta: { url: "https://x.feishu.cn/docx/DocAbc", token: "DocAbc", doc_types: "DOCX" },
      },
    ];
    server.fixtures.messageItems["oc_chat"] = [
      {
        message_id: "om_1",
        msg_type: "text",
        create_time: "1760000000000",
        body: { content: '{"text":"结论：按计划推进"}' },
        sender: { id: "ou_1", sender_name: "用户000000", sender_i18n_names: { zh_cn: "张三" } },
      },
    ];
    await run(server);
  } finally {
    await server.close();
  }
  assert.equal(url.startsWith("http://127.0.0.1:"), true);
}

test("读取文档走真实 HTTP 路径：版本、块与 Markdown 一致", async () => {
  await withServer(async (server) => {
    const reader = createSdkReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });

    const snapshot = await readDocument(reader, "DocAbc", { maxBlocks: 100, maxBytes: 100_000 });
    assert.equal(snapshot.revisionId, "42");
    assert.equal(snapshot.title, "季度总结");
    assert.equal(snapshot.blocks.length, 2);
    assert.equal(snapshot.markdown, "# 标题\n\n第一段");

    const requests = server.requestsTo("/open-apis/docx/v1/documents/DocAbc");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.authorization, "Bearer u-token");

    const blockRequests = server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks");
    assert.equal(blockRequests.length, 1);
    assert.equal(blockRequests[0]?.query.get("page_size"), "500");
  });
});

test("wiki 链接先解析节点再读文档", async () => {
  await withServer(async (server) => {
    server.fixtures.documents["DocFromWiki"] = { title: "wiki 里的文档", revisionId: "7", blocks: [TEXT_BLOCK] };
    const reader = createSdkReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });

    const documentId = await resolveDocumentId(reader, extractDocRef("https://x.feishu.cn/wiki/WkToken"));
    assert.equal(documentId, "DocFromWiki");
    const snapshot = await readDocument(reader, documentId, { maxBlocks: 10, maxBytes: 10_000 });
    assert.equal(snapshot.title, "wiki 里的文档");

    const wikiRequests = server.requestsTo("/open-apis/wiki/v2/spaces/get_node");
    assert.equal(wikiRequests.length, 1);
    assert.equal(wikiRequests[0]?.query.get("token"), "WkToken");
    assert.equal(wikiRequests[0]?.query.get("obj_type"), "wiki");
  });
});

test("搜索把关键词与条数交给接口，并归一化命中项", async () => {
  await withServer(async (server) => {
    const searcher = createSdkSearcher({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });

    const result = await searchDocuments(searcher, { query: "周报", limit: 5, onlyTitle: true });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.title, "周报 第 42 期");
    assert.equal(result.hits[0]?.token, "DocAbc");

    const requests = server.requestsTo("/open-apis/search/v2/doc_wiki/search");
    assert.equal(requests.length, 1);
    const body = requests[0]?.body as Record<string, unknown>;
    assert.equal(body.query, "周报");
    assert.equal(body.page_size, 5);
    assert.deepEqual(body.doc_filter, { only_title: true });
  });
});

test("消息读取按时间区间传参，返回可读文本", async () => {
  await withServer(async (server) => {
    const reader = createSdkMessageReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });

    const page = await listChatMessages(reader, { chatId: "oc_chat", startTime: 1760000000, endTime: 1760000900, limit: 10 });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]?.text, "结论：按计划推进");
    assert.equal(page.messages[0]?.senderName, "张三");

    const requests = server.requestsTo("/open-apis/im/v1/messages");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.query.get("container_id"), "oc_chat");
    assert.equal(requests[0]?.query.get("container_id_type"), "chat");
    assert.equal(requests[0]?.query.get("start_time"), "1760000000");
    assert.equal(requests[0]?.query.get("end_time"), "1760000900");
  });
});

test("写回把文本元素与幂等键放进请求体", async () => {
  await withServer(async (server) => {
    server.overrides.set("PATCH /open-apis/docx/v1/documents/DocAbc/blocks/blk_text", () => ({
      code: 0,
      data: { document_revision_id: 43 },
    }));

    const writer = createSdkWriter({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });

    await writer.patchTextBlock({ documentId: "DocAbc", blockId: "blk_text", text: "改写后的文本", clientToken: "idem-1" });

    const requests = server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks/blk_text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "PATCH");
    assert.equal(requests[0]?.query.get("client_token"), "idem-1");
    const body = requests[0]?.body as Record<string, unknown>;
    assert.deepEqual(body.update_text_elements, { elements: [{ text_run: { content: "改写后的文本" } }] });
  });
});
