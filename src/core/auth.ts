import {
  isExpired,
  startDeviceFlow,
  waitForDeviceFlow,
  refreshAccessToken,
  type DeviceChallenge,
  type DeviceFlowEnv,
  type TokenSet,
} from "./device-flow.js";
import type { TokenStore } from "./token-store.js";

/**
 * 授权状态的编排：谁过期、谁刷新、谁登录。
 * 并发刷新只允许一次——多个工具同时发现过期时共享同一个刷新 Promise。
 */

export interface AuthStatus {
  authorized: boolean;
  expiresAt?: number;
  scope?: string;
}

export class AuthManager {
  private refreshing: Promise<TokenSet> | null = null;

  constructor(
    private readonly env: DeviceFlowEnv,
    private readonly store: TokenStore
  ) {}

  async status(): Promise<AuthStatus> {
    const token = await this.store.load();
    if (!token) return { authorized: false };
    return {
      authorized: !isExpired(token),
      expiresAt: token.expiresAt,
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }

  /** 取可用的 access token：过期就用 refresh token 换，刷新失败即视为未授权。 */
  async getAccessToken(): Promise<string> {
    const token = await this.store.load();
    if (!token) throw new Error("尚未授权飞书账号，请先调用 feishu_auth_login");
    if (!isExpired(token)) return token.accessToken;

    if (!token.refreshToken) {
      await this.store.clear();
      throw new Error("授权已过期且没有 refresh token，请重新调用 feishu_auth_login");
    }

    this.refreshing ??= refreshAccessToken(this.env, token.refreshToken)
      .then(async (next) => {
        await this.store.save(next);
        return next;
      })
      .finally(() => {
        this.refreshing = null;
      });

    try {
      return (await this.refreshing).accessToken;
    } catch (error) {
      await this.store.clear();
      throw error;
    }
  }

  async startLogin(scope?: string): Promise<DeviceChallenge> {
    return startDeviceFlow(this.env, scope ? { scope } : {});
  }

  /** 授权完成后落盘；调用方负责在后台执行，不要阻塞工具返回。 */
  async completeLogin(challenge: DeviceChallenge): Promise<TokenSet> {
    const token = await waitForDeviceFlow(this.env, challenge);
    await this.store.save(token);
    return token;
  }

  async logout(): Promise<void> {
    await this.store.clear();
  }
}
