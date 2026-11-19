/**
 * 设备流授权（RFC 8628）。
 *
 * 只用两个端点：发起授权在 accounts 域，换 token 在 open 域。两个域都可以被
 * 覆盖，测试因此能指向本地 fake server。
 */

export type Domain = "feishu" | "lark";

export interface Endpoints {
  accounts: string;
  open: string;
}

export const OFFICIAL_ENDPOINTS: Record<Domain, Endpoints> = {
  feishu: { accounts: "https://accounts.feishu.cn", open: "https://open.feishu.cn" },
  lark: { accounts: "https://accounts.larksuite.com", open: "https://open.larksuite.com" },
};

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** 过期时间，毫秒时间戳。 */
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

export interface DeviceChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowEnv {
  appId: string;
  appSecret: string;
  endpoints: Endpoints;
  fetchImpl?: typeof fetch;
}

export class FeishuOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "FeishuOAuthError";
  }
}

function resolveFetch(env: DeviceFlowEnv): typeof fetch {
  return env.fetchImpl ?? fetch;
}

function basicAuth(appId: string, appSecret: string): string {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
}

async function postJson(
  env: DeviceFlowEnv,
  url: string,
  body: Record<string, string>,
  withBasicAuth: boolean
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (withBasicAuth) headers.Authorization = basicAuth(env.appId, env.appSecret);

  const response = await resolveFetch(env)(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new FeishuOAuthError("invalid_response", `响应不是 JSON（HTTP ${response.status}）`);
  }

  if (!response.ok) {
    const code = String(payload.error ?? payload.code ?? `http_${response.status}`);
    const description = String(
      payload.error_description ?? payload.error_msg ?? payload.msg ?? response.statusText
    );
    throw new FeishuOAuthError(code, description, response.status === 429 || response.status >= 500);
  }

  // 飞书的授权端点会用 HTTP 200 + 顶层 error 字段表达业务失败
  // （authorization_pending / slow_down / access_denied / expired_token），
  // 不能只看 HTTP 状态码，否则会被当成成功响应继续解析 access_token。
  if (typeof payload.error === "string" && payload.error.length > 0) {
    const description = String(payload.error_description ?? payload.error_msg ?? payload.msg ?? payload.error);
    throw new FeishuOAuthError(payload.error, description, payload.error === "slow_down");
  }

  return payload;
}

function tokenFromPayload(payload: Record<string, unknown>, now = Date.now()): TokenSet {
  const accessToken = payload.access_token;
  const expiresIn = Number(payload.expires_in ?? 0);
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new FeishuOAuthError("invalid_response", "响应缺少 access_token");
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new FeishuOAuthError("invalid_response", "响应缺少有效的 expires_in");
  }

  const token: TokenSet = {
    accessToken,
    expiresAt: now + expiresIn * 1000,
  };
  if (typeof payload.refresh_token === "string") token.refreshToken = payload.refresh_token;
  if (typeof payload.scope === "string") token.scope = payload.scope;
  if (typeof payload.token_type === "string") token.tokenType = payload.token_type;
  return token;
}

/** 发起设备授权，返回用户需要在浏览器里输入的用户码。 */
export async function startDeviceFlow(
  env: DeviceFlowEnv,
  options: { scope?: string } = {}
): Promise<DeviceChallenge> {
  const body: Record<string, string> = { client_id: env.appId };
  if (options.scope) body.scope = options.scope;

  const payload = await postJson(
    env,
    `${env.endpoints.accounts}/oauth/v1/device_authorization`,
    body,
    true
  );

  const deviceCode = payload.device_code;
  const userCode = payload.user_code;
  const verificationUri = payload.verification_uri;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new FeishuOAuthError("invalid_response", "设备授权响应缺少 device_code / user_code / verification_uri");
  }

  const challenge: DeviceChallenge = {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: Number(payload.expires_in ?? 600),
    interval: Math.max(1, Number(payload.interval ?? 5)),
  };
  if (typeof payload.verification_uri_complete === "string") {
    challenge.verificationUriComplete = payload.verification_uri_complete;
  }
  return challenge;
}

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "done"; token: TokenSet };

/** 轮询一次。调用方负责间隔与总时长。 */
export async function pollDeviceFlow(
  env: DeviceFlowEnv,
  challenge: DeviceChallenge,
  currentInterval: number
): Promise<PollResult> {
  try {
    const payload = await postJson(
      env,
      `${env.endpoints.open}/open-apis/authen/v2/oauth/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: env.appId,
        client_secret: env.appSecret,
        device_code: challenge.deviceCode,
      },
      false
    );
    return { status: "done", token: tokenFromPayload(payload) };
  } catch (error) {
    if (!(error instanceof FeishuOAuthError)) throw error;
    switch (error.code) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down", interval: currentInterval + 5 };
      case "access_denied":
        throw new FeishuOAuthError("access_denied", "用户拒绝了授权", false);
      case "expired_token":
        throw new FeishuOAuthError("expired_token", "设备码已过期，请重新发起授权", false);
      default:
        throw error;
    }
  }
}

export interface WaitOptions {
  /** 单次等待上限，超时抛 `expired_token`。 */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 轮询直到授权完成、被拒绝或过期。 */
export async function waitForDeviceFlow(
  env: DeviceFlowEnv,
  challenge: DeviceChallenge,
  options: WaitOptions = {}
): Promise<TokenSet> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + (options.timeoutMs ?? challenge.expiresIn * 1000);
  let interval = challenge.interval;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const result = await pollDeviceFlow(env, challenge, interval);
    if (result.status === "done") return result.token;
    if (result.status === "slow_down") interval = result.interval;
  }

  throw new FeishuOAuthError("expired_token", "授权等待超时，请重新发起授权", false);
}

/** 用 refresh token 换新的 access token。refresh token 会轮换，必须整体覆盖保存。 */
export async function refreshAccessToken(env: DeviceFlowEnv, refreshToken: string): Promise<TokenSet> {
  const payload = await postJson(
    env,
    `${env.endpoints.open}/open-apis/authen/v2/oauth/token`,
    {
      grant_type: "refresh_token",
      client_id: env.appId,
      client_secret: env.appSecret,
      refresh_token: refreshToken,
    },
    false
  );
  return tokenFromPayload(payload);
}

/** 预留的安全边界：提前 60 秒视为过期，避免"刚好过期"的竞态。 */
export function isExpired(token: TokenSet, now = Date.now(), skewMs = 60_000): boolean {
  return token.expiresAt - skewMs <= now;
}
