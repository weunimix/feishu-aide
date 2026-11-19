import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { apply } from "../../src/plugin.js";

interface CapturedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown> };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function tempStorage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feishu-aide-plugin-"));
}

function fakeContext(): { ctx: Context; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const ctx = {
    tools: {
      register: (tool: unknown) => {
        tools.push(tool as CapturedTool);
      },
    },
    logger: { warn: () => undefined },
  } as unknown as Context;
  return { ctx, tools };
}

function toolNamed(tools: CapturedTool[], name: string): CapturedTool {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool !== undefined, `没有注册工具 ${name}`);
  return tool;
}

test("装配后注册全部七个工具", () => {
  const { ctx, tools } = fakeContext();
  const storage = { dir: tempStorage() };
  apply(ctx, { storage });

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "feishu_auth_login",
      "feishu_auth_logout",
      "feishu_auth_status",
      "feishu_chat_messages",
      "feishu_doc_read",
      "feishu_doc_search",
      "feishu_doc_write",
    ]
  );
});

test("每个工具都有描述与可渲染的输出 schema", () => {
  const { ctx, tools } = fakeContext();
  apply(ctx, { storage: { dir: tempStorage() } });

  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺少描述`);
    assert.equal(tool.output.schema.type, "object", `${tool.name} 的输出 schema 不是 object`);
    assert.equal(
      (tool.output.schema as { additionalProperties?: unknown }).additionalProperties,
      false,
      `${tool.name} 的输出 schema 没有封闭字段`
    );
  }
});

test("未配置应用凭据时读文档给出可操作提示", async () => {
  const { ctx, tools } = fakeContext();
  apply(ctx, { storage: { dir: tempStorage() } });

  await assert.rejects(
    () => toolNamed(tools, "feishu_doc_read").execute({ ref: "https://example.feishu.cn/docx/DocAbc" }),
    /未配置飞书自建应用/
  );
});

test("默认状态是未授权，登出后仍是未授权", async () => {
  const { ctx, tools } = fakeContext();
  apply(ctx, { storage: { dir: tempStorage() } });

  assert.deepEqual(await toolNamed(tools, "feishu_auth_status").execute({}), {
    authorized: false,
    domain: "feishu",
  });
  assert.deepEqual(await toolNamed(tools, "feishu_auth_logout").execute({}), { authorized: false });
});
