import os from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { AuthManager } from "./core/auth.js";
import { resolveConfig, type FeishuAideConfig } from "./core/config.js";
import { OFFICIAL_ENDPOINTS, type DeviceFlowEnv } from "./core/device-flow.js";
import { DocReadError, extractDocRef, readDocument } from "./core/docx.js";
import { createSdkReader } from "./core/sdk-reader.js";
import { FileTokenStore } from "./core/token-store.js";

export const name = "feishu-aide";
export const inject = ["tools"];

function resolveStorageDir(config: FeishuAideConfig): string {
  if (config.storage.dir) return config.storage.dir;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "feishu-aide");
}

function requireAppCredentials(config: FeishuAideConfig): { appId: string; appSecret: string } {
  const { appId, appSecret } = config.auth;
  if (!appId || !appSecret) {
    throw new Error(
      "未配置飞书自建应用：请在插件配置里填写 auth.appId 与 auth.appSecret（自建应用的 App ID / App Secret）"
    );
  }
  return { appId, appSecret };
}

export function apply(ctx: Context, input?: unknown): void {
  const config = resolveConfig(input);
  const store = new FileTokenStore(resolveStorageDir(config));

  const env = (): DeviceFlowEnv => ({
    ...requireAppCredentials(config),
    endpoints: OFFICIAL_ENDPOINTS[config.auth.domain],
  });

  // 懒构造：没配应用凭据时只有真正调用工具才报错，不影响宿主启动。
  let manager: AuthManager | null = null;
  const auth = (): AuthManager => (manager ??= new AuthManager(env(), store));

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_status",
      description: "查看飞书授权状态：是否已授权、访问令牌过期时间与授权范围。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            authorized: { type: "boolean", required: true },
            expiresAt: { type: "number" },
            scope: { type: "string" },
            domain: { type: "string", required: true },
          },
        },
        render: (_args, value) =>
          value.authorized
            ? [
                {
                  type: "text",
                  text: `已授权（${value.domain}），令牌将于 ${new Date(value.expiresAt ?? 0).toLocaleString()} 过期`,
                },
              ]
            : [{ type: "text", text: "未授权：调用 feishu_auth_login 发起设备授权" }],
      },
      async execute() {
        const status = await auth().status();
        return { ...status, domain: config.auth.domain };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_auth_login",
      description: "发起飞书设备授权：返回用户码与验证地址，用户在浏览器完成授权后插件在后台保存令牌。",
      parameters: {
        scope: { type: "string", description: "可选，空格分隔的权限范围，例如 docx:document wiki:wiki" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            userCode: { type: "string", required: true },
            verificationUri: { type: "string", required: true },
            expiresIn: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `请在浏览器打开 ${value.verificationUri} 并输入用户码 ${value.userCode}（约 ${Math.round(
              value.expiresIn / 60
            )} 分钟内有效）`,
          },
        ],
      },
      async execute(args) {
        const current = auth();
        const challenge = await current.startLogin(args.scope);
        void current.completeLogin(challenge).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`飞书设备授权未完成：${message}`);
        });
        return {
          status: "pending",
          userCode: challenge.userCode,
          verificationUri: challenge.verificationUri,
          expiresIn: challenge.expiresIn,
        };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "feishu_doc_read",
      description: "读取一篇飞书文档（docx 链接或 document_id），返回标题、版本号、块列表与渲染后的 Markdown。",
      parameters: {
        ref: { type: "string", required: true, description: "文档 URL 或 token" },
        maxBlocks: { type: "number", description: "本次最多读取的块数，缺省取插件配置" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            documentId: { type: "string", required: true },
            revisionId: { type: "string", required: true },
            title: { type: "string", required: true },
            markdown: { type: "string", required: true },
            blocks: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  block_id: { type: "string", required: true },
                  block_type: { type: "number", required: true },
                  text: { type: "string", required: true },
                },
              },
            },
            truncated: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.markdown }],
      },
      async execute(args) {
        const ref = extractDocRef(args.ref);
        if (ref.kind === "wiki") {
          throw new DocReadError(
            "unsupported_ref",
            "wiki 链接需要先解析成文档 token：当前版本暂不支持自动解析，请直接给出 /docx/ 链接或 document_id"
          );
        }

        const reader = createSdkReader({
          ...requireAppCredentials(config),
          domain: config.auth.domain,
          userAccessToken: () => auth().getAccessToken(),
        });

        return readDocument(reader, ref.token, {
          maxBlocks: args.maxBlocks ?? config.read.maxBlocks,
          maxBytes: config.read.maxBytes,
        });
      },
    })
  );
}
