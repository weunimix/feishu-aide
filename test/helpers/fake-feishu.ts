import http from "node:http";

/**
 * 本地假的飞书 OpenAPI：只实现本项目用到的几个端点，
 * 让 SDK 走真实 HTTP 序列化路径，而不是在适配层外面打桩。
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface FakeDocument {
  title: string;
  revisionId: string;
  blocks: unknown[];
}

export interface FakeWikiNode {
  objToken: string;
  objType: string;
  title?: string;
}

export interface FakeFixtures {
  documents: Record<string, FakeDocument>;
  wikiNodes: Record<string, FakeWikiNode>;
  searchUnits: Record<string, unknown[]>;
  messageItems: Record<string, unknown[]>;
}

export type RouteHandler = (request: RecordedRequest, server: FakeFeishuServer) => unknown;

function json(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

export class FakeFeishuServer {
  readonly requests: RecordedRequest[] = [];
  readonly fixtures: FakeFixtures = { documents: {}, wikiNodes: {}, searchUnits: {}, messageItems: {} };
  readonly overrides = new Map<string, RouteHandler>();

  #server: http.Server | null = null;
  #url = "";

  get url(): string {
    return this.#url;
  }

  async start(): Promise<string> {
    const server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake server 没有拿到端口");
    }
    this.#url = `http://127.0.0.1:${address.port}`;
    return this.#url;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** 某条路径的全部请求，按到达顺序。 */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await readBody(req);
    const request: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    };
    this.requests.push(request);

    const override = this.overrides.get(`${request.method} ${request.path}`);
    if (override !== undefined) {
      json(res, override(request, this));
      return;
    }

    try {
      const payload = this.#route(request);
      json(res, payload ?? { code: 404, msg: "not found" });
    } catch (error) {
      json(res, { code: 500, msg: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  #route(request: RecordedRequest): unknown {
    const documentMatch = /^\/open-apis\/docx\/v1\/documents\/([^/]+)$/.exec(request.path);
    if (documentMatch !== null && request.method === "GET") {
      const documentId = documentMatch[1] ?? "";
      const document = this.fixtures.documents[documentId];
      if (document === undefined) {
        return { code: 1310202, msg: "document not found" };
      }
      return { code: 0, data: { document: { title: document.title, revision_id: document.revisionId } } };
    }

    const blocksMatch = /^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks$/.exec(request.path);
    if (blocksMatch !== null && request.method === "GET") {
      const documentId = blocksMatch[1] ?? "";
      const document = this.fixtures.documents[documentId];
      if (document === undefined) {
        return { code: 1310202, msg: "document not found" };
      }
      return { code: 0, data: { items: document.blocks, has_more: false } };
    }

    if (request.path === "/open-apis/wiki/v2/spaces/get_node") {
      const token = request.query.get("token") ?? "";
      const node = this.fixtures.wikiNodes[token];
      if (node === undefined) {
        return { code: 131006, msg: "node not found" };
      }
      return { code: 0, data: { node: { obj_token: node.objToken, obj_type: node.objType, title: node.title ?? "" } } };
    }

    if (request.path === "/open-apis/search/v2/doc_wiki/search") {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const query = typeof body.query === "string" ? body.query : "";
      const units = this.fixtures.searchUnits[query] ?? [];
      return { code: 0, data: { res_units: units, has_more: false, total: units.length } };
    }

    if (request.path === "/open-apis/im/v1/messages") {
      const chatId = request.query.get("container_id") ?? "";
      const items = this.fixtures.messageItems[chatId] ?? [];
      return { code: 0, data: { items, has_more: false } };
    }

    return { code: 404, msg: `fake server 没有实现 ${request.method} ${request.path}` };
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
