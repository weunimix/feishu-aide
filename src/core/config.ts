import Schema from "@deepseek-ai/schemastery";

/** 允许的写操作种类；配置里可以收窄。 */
export const WRITE_OPERATIONS = ["replace_text", "insert_text", "create_document"] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/**
 * 插件配置。`auth.mode=auto` 时首次使用会自动创建应用，用户只做两次确认；
 * 只有显式选择 `self-hosted` 才必须填写 `auth.appId` / `auth.appSecret`。
 * 其余项都有能直接跑起来的默认值。
 */
export interface FeishuAideConfig {
  auth: {
    mode: "auto" | "self-hosted";
    domain: "feishu" | "lark";
    appId: string;
    appSecret: string;
  };
  storage: { dir: string };
  read: { maxBlocks: number; maxBytes: number; cacheTtlSeconds: number };
  write: {
    enabled: boolean;
    confirm: "diff" | "always" | "never";
    requireRevisionMatch: boolean;
    operations: WriteOperation[];
  };
}

/** 交给 DSH 渲染配置表单用的 schema；默认值与 `FeishuAideConfig` 必须保持一致。 */
export const Config: Schemastery = Schema.object({
  auth: Schema.object({
    mode: Schema.union(["auto", "self-hosted"] as const)
      .default("auto")
      .description("auto：首次使用自动创建应用；self-hosted：使用自己建的应用"),
    domain: Schema.union(["feishu", "lark"] as const)
      .default("feishu")
      .description("飞书（feishu）还是国际版 Lark（lark）"),
    appId: Schema.string()
      .default("")
      .description("仅 self-hosted 需要：自建应用的 App ID，例如 cli_xxx"),
    appSecret: Schema.string()
      .role("secret")
      .default("")
      .description("仅 self-hosted 需要：自建应用的 App Secret"),
  }),
  storage: Schema.object({
    dir: Schema.string()
      .default("")
      .description("本地状态目录，留空则使用 DSH home 下的 feishu-aide"),
  }),
  read: Schema.object({
    maxBlocks: Schema.number()
      .min(1)
      .default(500)
      .description("单次返回的块数上限"),
    maxBytes: Schema.number()
      .min(1024)
      .default(262144)
      .description("单次返回的字节上限"),
    cacheTtlSeconds: Schema.number()
      .min(0)
      .default(600)
      .description("非写回路径的缓存有效期"),
  }),
  write: Schema.object({
    enabled: Schema.boolean().default(true).description("是否允许写回飞书"),
    confirm: Schema.union(["diff", "always", "never"] as const)
      .default("diff")
      .description("写回前的确认方式"),
    requireRevisionMatch: Schema.boolean()
      .default(true)
      .description("写回前校验版本，失败即拒绝"),
    operations: Schema.array(
      Schema.union(["replace_text", "insert_text", "create_document"] as const)
    )
      .default([...WRITE_OPERATIONS])
      .description("允许的写操作种类，收窄后其余操作会被拒绝"),
  }),
});

export function resolveConfig(input?: unknown): FeishuAideConfig {
  const resolve = Config as unknown as (value: unknown) => FeishuAideConfig;
  return resolve(input ?? {});
}
