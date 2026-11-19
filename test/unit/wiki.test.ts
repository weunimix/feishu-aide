import assert from "node:assert/strict";
import test from "node:test";
import type { DocReader } from "../../src/core/docx.js";
import { WikiTargetError, resolveDocumentId } from "../../src/core/wiki.js";

function readerWith(resolveWikiToken?: DocReader["resolveWikiToken"]): DocReader {
  const reader: DocReader = {
    getDocument: async () => ({ title: "文档", revisionId: "1" }),
    listBlocks: async () => ({ items: [], hasMore: false }),
  };
  if (resolveWikiToken) reader.resolveWikiToken = resolveWikiToken;
  return reader;
}

test("docx 链接与裸 token 原样返回", async () => {
  let called = 0;
  const reader = readerWith(async () => {
    called += 1;
    return { objToken: "unused", objType: "docx" };
  });

  assert.equal(await resolveDocumentId(reader, { kind: "docx", token: "AbC123" }), "AbC123");
  assert.equal(await resolveDocumentId(reader, { kind: "token", token: "AbC123" }), "AbC123");
  assert.equal(called, 0);
});

test("wiki 节点解析成背后的文档 id", async () => {
  const reader = readerWith(async (token) => {
    assert.equal(token, "Wk9");
    return { objToken: "Dox9", objType: "docx", title: "知识库节点" };
  });

  assert.equal(await resolveDocumentId(reader, { kind: "wiki", token: "Wk9" }), "Dox9");
});

test("wiki 节点不是文档时明确拒绝", async () => {
  const reader = readerWith(async () => ({ objToken: "Sht1", objType: "sheet" }));

  await assert.rejects(
    resolveDocumentId(reader, { kind: "wiki", token: "Wk9" }),
    (error: unknown) => error instanceof WikiTargetError && error.code === "unsupported_obj"
  );
});

test("读取器不支持解析 wiki 时给出可操作提示", async () => {
  const reader = readerWith();

  await assert.rejects(
    resolveDocumentId(reader, { kind: "wiki", token: "Wk9" }),
    (error: unknown) => error instanceof WikiTargetError && error.code === "resolver_missing"
  );
});
