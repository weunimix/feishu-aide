import assert from "node:assert/strict";
import test from "node:test";
import { FakeFeishuServer } from "../helpers/fake-feishu.js";
import { createSdkReader } from "../../src/core/sdk-reader.js";
import { createSdkWriter } from "../../src/core/sdk-writer.js";
import { runWrite, WriteConflict, type WriteDeps, type WriteRequest } from "../../src/core/write.js";

const BLOCK_HEAD = {
  block_id: "blk_head",
  block_type: 3,
  heading1: { elements: [{ text_run: { content: "标题" } }] },
};
const BLOCK_BODY = {
  block_id: "blk_body",
  block_type: 2,
  text: { elements: [{ text_run: { content: "第一段" } }] },
};

const REPLACE_BODY = [{ op: "replace_text", block_id: "blk_body", text: "改写后的正文" }];

function textOfBlock(server: FakeFeishuServer, blockId: string): string {
  const document = server.fixtures.documents["DocAbc"];
  const block = document?.blocks.find((item) => item.block_id === blockId);
  const elements = block?.text?.elements;
  if (!Array.isArray(elements)) return "";
  return elements
    .map((element) => {
      const record = typeof element === "object" && element !== null ? (element as Record<string, unknown>) : {};
      const run = typeof record.text_run === "object" && record.text_run !== null ? (record.text_run as Record<string, unknown>) : {};
      return typeof run.content === "string" ? run.content : "";
    })
    .join("");
}

async function withServer(
  policy: WriteDeps["policy"],
  run: (server: FakeFeishuServer, deps: WriteDeps) => Promise<void>
): Promise<void> {
  const server = new FakeFeishuServer();
  await server.start();
  try {
    server.fixtures.documents["DocAbc"] = {
      title: "季度总结",
      revisionId: "42",
      blocks: [structuredClone(BLOCK_HEAD), structuredClone(BLOCK_BODY)],
    };
    const reader = createSdkReader({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });
    const writer = createSdkWriter({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      userAccessToken: async () => "u-token",
      domainOverride: server.url,
    });
    const deps: WriteDeps = { reader, writer, policy, limits: { maxBlocks: 100, maxBytes: 100_000 } };
    await run(server, deps);
  } finally {
    await server.close();
  }
}

const STRICT_POLICY: WriteDeps["policy"] = { enabled: true, confirm: "never", requireRevisionMatch: true };

test("版本不匹配的写被拒绝，且不发出任何写请求", async () => {
  await withServer(STRICT_POLICY, async (server, deps) => {
    const request: WriteRequest = { documentId: "DocAbc", baseRevision: "41", ops: REPLACE_BODY, apply: true };

    await assert.rejects(runWrite(deps, request), (error: unknown) => {
      assert.ok(error instanceof WriteConflict);
      assert.equal(error.code, "revision_mismatch");
      assert.match(error.message, /当前版本 42/);
      return true;
    });

    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks/blk_body").length, 0);
    assert.equal(server.docWrites, 0);
    assert.equal(textOfBlock(server, "blk_body"), "第一段");
  });
});

test("缺少 base_revision 时拒绝写回", async () => {
  await withServer(STRICT_POLICY, async (server, deps) => {
    const request: WriteRequest = { documentId: "DocAbc", ops: REPLACE_BODY, apply: true };

    await assert.rejects(runWrite(deps, request), (error: unknown) => {
      assert.ok(error instanceof WriteConflict);
      assert.equal(error.code, "need_base_revision");
      return true;
    });

    assert.equal(server.docWrites, 0);
  });
});

test("confirm=always 且未确认时只返回计划", async () => {
  await withServer({ enabled: true, confirm: "always", requireRevisionMatch: true }, async (server, deps) => {
    const request: WriteRequest = { documentId: "DocAbc", baseRevision: "42", ops: REPLACE_BODY };

    const outcome = await runWrite(deps, request);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.plan.length, 1);
    assert.match(outcome.plan[0] ?? "", /blk_body/);
    assert.deepEqual(outcome.results, []);
    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks/blk_body").length, 0);
  });
});

test("同一请求重试只落一次盘：幂等键相同、版本只涨一次", async () => {
  // 重试的是同一个 baseRevision，因此关掉版本比对，模拟客户端重放原请求。
  await withServer({ enabled: true, confirm: "never", requireRevisionMatch: false }, async (server, deps) => {
    const request: WriteRequest = { documentId: "DocAbc", baseRevision: "42", ops: REPLACE_BODY, apply: true };

    const first = await runWrite(deps, request);
    assert.equal(first.applied, true);
    assert.equal(first.revisionId, "43");

    const second = await runWrite(deps, request);
    assert.equal(second.applied, true);
    assert.equal(second.revisionId, "43");

    const patches = server.requestsTo("/open-apis/docx/v1/documents/DocAbc/blocks/blk_body");
    assert.equal(patches.length, 2);
    assert.equal(patches[0]?.query.get("client_token"), patches[1]?.query.get("client_token"));
    assert.notEqual(patches[0]?.query.get("client_token"), "");

    assert.equal(server.docWrites, 1, "同一幂等键只应改动文档一次");
    assert.equal(server.fixtures.documents["DocAbc"]?.revisionId, "43");
    assert.equal(textOfBlock(server, "blk_body"), "改写后的正文");
  });
});

test("部分失败如实报告：一个块成功、一个块失败", async () => {
  await withServer(STRICT_POLICY, async (server, deps) => {
    server.overrides.set("PATCH /open-apis/docx/v1/documents/DocAbc/blocks/blk_body", () => ({
      code: 1310203,
      msg: "block not found",
    }));

    const request: WriteRequest = {
      documentId: "DocAbc",
      baseRevision: "42",
      apply: true,
      ops: [
        { op: "replace_text", block_id: "blk_head", text: "新标题" },
        { op: "replace_text", block_id: "blk_body", text: "改写后的正文" },
      ],
    };

    const outcome = await runWrite(deps, request);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.results[0]?.ok, true);
    assert.equal(outcome.results[1]?.ok, false);
    assert.match(outcome.results[1]?.error ?? "", /1310203/);
    assert.equal(textOfBlock(server, "blk_head"), "新标题");
    assert.equal(textOfBlock(server, "blk_body"), "第一段");
  });
});
