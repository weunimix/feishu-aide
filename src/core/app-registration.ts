/**
 * 应用引导注册：把"先去开放平台建一个自建应用"压缩成一次确认。
 *
 * 飞书的 `app/registration` 端点和设备流是同一个形状：先 begin 拿用户码，
 * 用户在页面上确认后 poll 拿凭据。区别是确认之后拿到的是一对应用凭据
 * （client_id / client_secret），而不是用户 token。
 *
 * 端点没有公开文档，实现依据是官方 CLI 的同名流程；它同样没有签名前置，
 * 只需要把表单字段发对。凭据一旦落盘就长期有效，登录只复用、不重建。
 */

import type { Endpoints } from "./device-flow.js";

export interface RegistrationChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface RegisteredApp {
  appId: string;
  appSecret: string;
  openId?: string;
  tenantBrand?: string;
}

export type RegistrationPoll =
  | { status: "pending" }
  | { status: "registered"; app: RegisteredApp };

export class AppRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppRegistrationError";
  }
}

/** 这些错误码表示"还没确认"，不是失败。 */
const PENDING_ERRORS = new Set(["authorization_pending", "slow_down"]);

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; status: number; statusText: string; payload: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AppRegistrationError("invalid_response", `响应不是 JSON（HTTP ${response.status}）`);
    }
  }
  return { ok: response.ok, status: response.status, statusText: response.statusText, payload };
}

function errorCodeOf(payload: Record<string, unknown>): string | undefined {
  const error = readString(payload, "error");
  if (error) return error;
  const code = payload.code;
  return typeof code === "number" ? String(code) : undefined;
}

function errorMessageOf(payload: Record<string, unknown>, fallback: string): string {
  return (
    readString(payload, "error_description") ??
    readString(payload, "error_msg") ??
    readString(payload, "msg") ??
    fallback
  );
}

/** 发起注册：返回用户需要在浏览器里确认的用户码。 */
export async function startAppRegistration(
  endpoints: Endpoints,
  fetchImpl: typeof fetch = fetch
): Promise<RegistrationChallenge> {
  const { ok, status, statusText, payload } = await postForm(
    `${endpoints.accounts}/oauth/v1/app/registration`,
    {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    },
    fetchImpl
  );

  const code = errorCodeOf(payload);
  if (code) throw new AppRegistrationError(code, errorMessageOf(payload, `应用注册失败（${code}）`));
  if (!ok) throw new AppRegistrationError(`http_${status}`, statusText || `应用注册失败（HTTP ${status}）`);

  const deviceCode = readString(payload, "device_code");
  const userCode = readString(payload, "user_code");
  const verificationUri = readString(payload, "verification_uri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AppRegistrationError(
      "invalid_response",
      "应用注册响应缺少 device_code / user_code / verification_uri"
    );
  }

  const challenge: RegistrationChallenge = {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: Number(payload.expires_in ?? 3600),
    interval: Math.max(1, Number(payload.interval ?? 5)),
  };
  const complete = readString(payload, "verification_uri_complete");
  if (complete) challenge.verificationUriComplete = complete;
  return challenge;
}

/** 轮询一次注册结果；`authorization_pending` 是正常状态，不是错误。 */
export async function pollAppRegistration(
  endpoints: Endpoints,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch
): Promise<RegistrationPoll> {
  const { ok, status, statusText, payload } = await postForm(
    `${endpoints.accounts}/oauth/v1/app/registration`,
    { action: "poll", device_code: deviceCode },
    fetchImpl
  );

  const code = errorCodeOf(payload);
  if (code && PENDING_ERRORS.has(code)) return { status: "pending" };
  if (code) throw new AppRegistrationError(code, errorMessageOf(payload, `应用注册失败（${code}）`));
  if (!ok) throw new AppRegistrationError(`http_${status}`, statusText || `应用注册失败（HTTP ${status}）`);

  const appId = readString(payload, "client_id");
  const appSecret = readString(payload, "client_secret");
  if (!appId || !appSecret) {
    throw new AppRegistrationError("invalid_response", "应用注册响应缺少 client_id / client_secret");
  }

  const app: RegisteredApp = { appId, appSecret };
  const userInfo = payload.user_info;
  if (userInfo && typeof userInfo === "object") {
    const info = userInfo as Record<string, unknown>;
    const openId = readString(info, "open_id");
    const tenantBrand = readString(info, "tenant_brand");
    if (openId) app.openId = openId;
    if (tenantBrand) app.tenantBrand = tenantBrand;
  }
  return { status: "registered", app };
}
