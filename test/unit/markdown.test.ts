import assert from "node:assert/strict";
import test from "node:test";
import { inlineText, renderMarkdown, summarizeBlocks, type FeishuBlock } from "../../src/core/markdown.js";

function textBlock(text: string, blockType = 2, style: Record<string, unknown> = {}): FeishuBlock {
  return {
    block_id: "blk",
    block_type: blockType,
    text: { elements: [{ text_run: { content: text } }], style },
  };
}

test("标题按层级渲染", () => {
  assert.equal(renderMarkdown([textBlock("一级", 3), textBlock("二级", 4)]), "# 一级\n\n## 二级");
});

test("正文、列表、引用、待办与分割线", () => {
  const blocks: FeishuBlock[] = [
    textBlock("正文"),
    textBlock("项目一", 12),
    textBlock("要点", 15),
    { block_id: "a", block_type: 17, todo: { elements: [{ text_run: { content: "完成" } }], style: { done: true } } },
    { block_id: "b", block_type: 22 },
  ];
  assert.equal(renderMarkdown(blocks), "正文\n\n- 项目一\n\n> 要点\n\n- [x] 完成\n\n---");
});

test("代码块用围栏包住", () => {
  const block: FeishuBlock = {
    block_id: "c",
    block_type: 14,
    code: { elements: [{ text_run: { content: "const a = 1;" } }], style: { language: 1 } },
  };
  assert.equal(renderMarkdown([block]), "```\nconst a = 1;\n```");
});

test("未知块与空块被跳过而不是产出垃圾", () => {
  const blocks: FeishuBlock[] = [
    { block_id: "x", block_type: 999 },
    textBlock(""),
    textBlock("保留"),
  ];
  assert.equal(renderMarkdown(blocks), "保留");
});

test("行内元素保留文档引用与公式", () => {
  const elements = [
    { text_run: { content: "见 " } },
    { mention_doc: { title: "设计稿", token: "doxcn" } },
    { equation: { content: "E=mc^2" } },
  ];
  assert.equal(inlineText(elements), "见 [设计稿]$E=mc^2$");
});

test("块摘要只带定位与纯文本", () => {
  const summary = summarizeBlocks([textBlock("甲"), textBlock("乙")], 1);
  assert.deepEqual(summary, [{ block_id: "blk", block_type: 2, text: "甲" }]);
});
