import assert from "node:assert/strict";
import test from "node:test";
import { createSdkReader } from "../../src/core/sdk-reader.js";
import { FakeFeishuServer, rawResponse } from "../helpers/fake-feishu.js";

const TOKEN = "u-token-secret";
const BODY = "机密正文";

function documentFixture() {
  return {
    title: "标题",
    revisionId: "42",
    blocks: [{ block_id: "b1", block_type: 2, text: { elements: [{ text_run: { content: BODY } }] } }],
  };
}

test("429 之后自动重试并成功，日志里没有令牌与正文", async () => {
  const server = new FakeFeishuServer();
  await server.start();
  try {
    server.fixtures.documents["DocAbc"] = documentFixture();
    let calls = 0;
    server.overrides.set("GET /open-apis/docx/v1/documents/DocAbc", () => {
      calls += 1;
      return calls === 1
        ? rawResponse(
            { code: 99991400, msg: "request trigger frequency limit" },
            { status: 429, headers: { "retry-after": "0" } }
          )
        : undefined;
    });

    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      const reader = createSdkReader({
        appId: "cli_x",
        appSecret: "secret",
        domain: "feishu",
        userAccessToken: async () => TOKEN,
        domainOverride: server.url,
      });
      const meta = await reader.getDocument("DocAbc");
      assert.equal(meta.revisionId, "42");
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }

    assert.equal(calls, 2);
    assert.equal(server.requestsTo("/open-apis/docx/v1/documents/DocAbc").length, 2);
    const text = logged.join("\n");
    assert.ok(!text.includes(TOKEN), `日志泄漏了令牌：${text}`);
    assert.ok(!text.includes(BODY), `日志泄漏了正文：${text}`);
  } finally {
    await server.close();
  }
});

test("非限流错误只请求一次，错误信息里也没有令牌", async () => {
  const server = new FakeFeishuServer();
  await server.start();
  try {
    let calls = 0;
    server.overrides.set("GET /open-apis/docx/v1/documents/DocAbc", () => {
      calls += 1;
      return rawResponse({ code: 1310202, msg: "document not found" }, { status: 404 });
    });

    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      const reader = createSdkReader({
        appId: "cli_x",
        appSecret: "secret",
        domain: "feishu",
        userAccessToken: async () => TOKEN,
        domainOverride: server.url,
      });

      await assert.rejects(
        () => reader.getDocument("DocAbc"),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(!message.includes(TOKEN), `错误信息泄漏了令牌：${message}`);
          // 业务码与 msg 必须出现在错误里，否则用户只能看到 "status code 404"。
          assert.ok(message.includes("code=1310202"), `错误信息缺少业务码：${message}`);
          assert.ok(message.includes("document not found"), `错误信息缺少原因：${message}`);
          return true;
        }
      );
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }

    // SDK 的 logger 默认会把整个 axios 错误（含请求头与响应体）打出来，
    // 适配层必须传入静音 logger；这里断言一行都不打印。
    assert.deepEqual(logged, [], `SDK 不该往控制台写任何东西：${logged.join("\n")}`);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
