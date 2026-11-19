/**
 * 飞书 docx 块 → Markdown。
 *
 * 只做"能读"这一档：认得的块渲染成语义等价的形式，认不得的块把它的内联文本
 * 降级成一行纯文本（确实没有文本才跳过），不丢块、不猜结构。渲染必须确定性，
 * 测试直接拿块 JSON 断言输出。
 */

export type FeishuBlock = {
  block_id?: string;
  block_type?: number;
  parent_id?: string;
  children?: string[];
  [key: string]: unknown;
};

type TextElement = {
  text_run?: { content?: string };
  equation?: { content?: string };
  mention_doc?: { title?: string; token?: string };
  mention_user?: { name?: string };
  file?: { name?: string };
  reminder?: Record<string, unknown>;
  link_preview?: { url?: string };
};

type BlockContent = {
  elements?: TextElement[];
  style?: Record<string, unknown>;
};

const CONTENT_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "todo",
  "page",
] as const;

const HEADING_LEVEL: Record<number, number> = {
  3: 1,
  4: 2,
  5: 3,
  6: 4,
  7: 5,
  8: 6,
  9: 7,
  10: 8,
  11: 9,
};

export function contentOf(block: FeishuBlock): BlockContent | undefined {
  for (const key of CONTENT_KEYS) {
    const value = block[key];
    if (value && typeof value === "object") return value as BlockContent;
  }
  return undefined;
}

export function inlineText(elements: TextElement[] | undefined): string {
  if (!Array.isArray(elements)) return "";
  return elements
    .map((element) => {
      if (typeof element.text_run?.content === "string") return element.text_run.content;
      if (typeof element.equation?.content === "string") return `$${element.equation.content}$`;
      if (element.mention_doc) {
        return `[${element.mention_doc.title ?? element.mention_doc.token ?? "文档"}]`;
      }
      if (element.mention_user) return `@${element.mention_user.name ?? "成员"}`;
      if (element.file?.name) return `[文件: ${element.file.name}]`;
      if (element.reminder) return "[提醒]";
      if (element.link_preview) return "[链接预览]";
      return "";
    })
    .join("");
}

/**
 * 未知块的兜底：在块对象里找一个带 `elements` 的字段并取其文本。
 * 只认数组形态的 `elements`，避免把 `style` 之类的对象误当正文。
 */
function fallbackText(block: FeishuBlock): string {
  for (const [key, value] of Object.entries(block)) {
    if (key === "style" || typeof value !== "object" || value === null) continue;
    const elements = (value as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) continue;
    const text = inlineText(elements as TextElement[]);
    if (text !== "") return text;
  }
  return "";
}

function renderedLines(block: FeishuBlock): string[] {
  const type = block.block_type ?? 0;
  const content = contentOf(block);
  const text = inlineText(content?.elements);
  const done = content?.style?.done === true;

  if (type === 1) return []; // page：容器，正文由子块承载
  if (HEADING_LEVEL[type]) {
    const level = HEADING_LEVEL[type];
    return text ? [`${"#".repeat(level)} ${text}`] : [];
  }
  if (type === 2 || type === 34) return text ? [text] : [];
  if (type === 12) return text ? [`- ${text}`] : [];
  if (type === 13) return text ? [`1. ${text}`] : [];
  if (type === 14) {
    const language = (content?.style?.language as number | undefined) ?? 0;
    return ["```", text, "```"].filter((line) => line !== "");
  }
  if (type === 15) return text ? [`> ${text}`] : [];
  if (type === 17) return text ? [`- [${done ? "x" : " "}] ${text}`] : [];
  if (type === 22) return ["---"];
  // 未知块：飞书新增块类型时内容通常仍是同一套 text_element 结构，
  // 降级成一行纯文本比整块丢掉更接近用户预期。
  const fallback = fallbackText(block);
  return fallback ? [fallback] : [];
}

/** 把一篇文档的块列表渲染成 Markdown。块顺序即文档顺序。 */
export function renderMarkdown(blocks: FeishuBlock[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    const lines = renderedLines(block);
    if (lines.length > 0) chunks.push(lines.join("\n"));
  }
  return chunks.join("\n\n");
}

/** 供工具结果使用：块摘要只带定位与类型，正文由 markdown 承载。 */
export function summarizeBlocks(blocks: FeishuBlock[], limit: number): Array<{
  block_id: string;
  block_type: number;
  text: string;
}> {
  return blocks.slice(0, limit).map((block) => ({
    block_id: block.block_id ?? "",
    block_type: block.block_type ?? 0,
    text: inlineText(contentOf(block)?.elements),
  }));
}
