import {
  isExpired,
  pollDeviceFlow,
  refreshAccessToken,
  startDeviceFlow,
  type DeviceChallenge,
  type DeviceFlowEnv,
  type Endpoints,
  type TokenSet,
} from "./device-flow.js";
import {
  pollAppRegistration,
  startAppRegistration,
  type RegistrationChallenge,
} from "./app-registration.js";
import type { AppCredentialStore, AppCredentials } from "./app-credentials.js";
import type { TokenStore } from "./token-store.js";

/**
 * 授权状态的编排：先确认应用、再确认用户，最后谁过期谁刷新。
 *
 * 两个待办状态（应用注册 / 用户授权）都只在内存里：它们几分钟内就过期，
 * 落盘只会制造"重启后还在等一个早就失效的确认"这种假状态。用户每调用一次
 * `feishu_auth_login` 就往前推进一步，没有后台轮询，也没有并发写。
 */

export interface AuthStatus {
  authorized: boolean;
  expiresAt?: number;
  scope?: string;
  /** 还有一步等用户确认：`register` 建应用，`authorize` 授权用户。 */
  pending?: "register" | "authorize";
}

export interface LoginResult {
  stage: "register" | "authorize" | "authorized";
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  scope?: string;
}

export interface AuthManagerOptions {
  domain: "feishu" | "lark";
  endpoints: Endpoints;
  /** `auto`：首次使用时自动注册应用；`self-hosted`：必须由配置提供应用凭据。 */
  mode: "auto" | "self-hosted";
  configCredentials: { appId: string; appSecret: string };
  credentials: AppCredentialStore;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
}

export class AuthManager {
  private refreshing: Promise<TokenSet> | null = null;
  /** 每次登出 / 重新登录都自增，用来让在途刷新不回写已经作废的身份。 */
  private generation = 0;
  private registration: RegistrationChallenge | null = null;
  private authorization: DeviceChallenge | null = null;

  constructor(private readonly options: AuthManagerOptions) {}

  async status(): Promise<AuthStatus> {
    const token = await this.options.tokens.load();
    const status: AuthStatus = { authorized: token !== null && !isExpired(token) };
    if (token) {
      status.expiresAt = token.expiresAt;
      if (token.scope) status.scope = token.scope;
    }
    const pending = this.pendingStage();
    if (pending) status.pending = pending;
    return status;
  }

  /** 应用凭据：配置里显式给的优先，否则用自动注册的结果。 */
  async getAppCredentials(): Promise<AppCredentials> {
    const { appId, appSecret } = this.options.configCredentials;
    if (appId && appSecret) return { appId, appSecret };

    if (this.options.mode === "self-hosted") {
      throw new Error("配置要求使用自建应用（auth.mode=self-hosted），但 auth.appId 与 auth.appSecret 未填写");
    }

    const stored = await this.options.credentials.load();
    if (stored) return stored;
    throw new Error("尚未创建飞书应用：调用 feishu_auth_login 按提示完成一次确认后，插件会自动创建并保存应用凭据");
  }

  /** 取可用的 access token：过期就用 refresh token 换，刷新失败即视为未授权。 */
  async getAccessToken(): Promise<string> {
    const token = await this.options.tokens.load();
    if (!token) throw new Error("尚未授权飞书账号，请先调用 feishu_auth_login");
    if (!isExpired(token)) return token.accessToken;

    if (!token.refreshToken) {
      await this.options.tokens.clear();
      throw new Error("授权已过期且没有 refresh token，请重新调用 feishu_auth_login");
    }

    const generation = this.generation;
    const env = await this.env();
    this.refreshing ??= refreshAccessToken(env, token.refreshToken)
      .then(async (next) => {
        // 刷新期间用户登出或换了账号：这份 token 不再写回。
        if (generation !== this.generation) return next;
        await this.options.tokens.save(next);
        return next;
      })
      .finally(() => {
        this.refreshing = null;
      });

    try {
      return (await this.refreshing).accessToken;
    } catch (error) {
      await this.options.tokens.clear();
      throw error;
    }
  }

  /**
   * 推进一步登录：没有应用就先建应用，有了就发起授权，已经在等就轮询一次。
   * 每次调用要么拿到下一个确认地址，要么直接完成。
   */
  async login(scope?: string): Promise<LoginResult> {
    if (this.authorization) {
      const env = await this.env();
      const result = await pollDeviceFlow(env, this.authorization, this.authorization.interval);
      if (result.status === "done") {
        this.generation += 1;
        this.refreshing = null;
        await this.options.tokens.save(result.token);
        this.authorization = null;
        const done: LoginResult = { stage: "authorized" };
        if (result.token.scope) done.scope = result.token.scope;
        return done;
      }
      if (result.status === "slow_down") {
        this.authorization = { ...this.authorization, interval: result.interval };
      }
      return this.authorizeResult(this.authorization);
    }

    if (this.registration) {
      const polled = await pollAppRegistration(
        this.options.endpoints,
        this.registration.deviceCode,
        this.resolveFetch()
      );
      if (polled.status === "pending") return this.registerResult(this.registration);
      await this.options.credentials.save({ appId: polled.app.appId, appSecret: polled.app.appSecret });
      this.registration = null;
      return this.startAuthorization(scope);
    }

    if (!(await this.hasAppCredentials())) {
      const challenge = await startAppRegistration(this.options.endpoints, this.resolveFetch());
      this.registration = challenge;
      return this.registerResult(challenge);
    }
    return this.startAuthorization(scope);
  }

  async logout(): Promise<void> {
    this.generation += 1;
    this.refreshing = null;
    this.registration = null;
    this.authorization = null;
    await this.options.tokens.clear();
  }

  private pendingStage(): "register" | "authorize" | undefined {
    if (this.registration) return "register";
    if (this.authorization) return "authorize";
    return undefined;
  }

  private async hasAppCredentials(): Promise<boolean> {
    const { appId, appSecret } = this.options.configCredentials;
    if (appId && appSecret) return true;
    if (this.options.mode === "self-hosted") {
      throw new Error("配置要求使用自建应用（auth.mode=self-hosted），但 auth.appId 与 auth.appSecret 未填写");
    }
    return (await this.options.credentials.load()) !== null;
  }

  private resolveFetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async env(): Promise<DeviceFlowEnv> {
    const credentials = await this.getAppCredentials();
    const env: DeviceFlowEnv = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      endpoints: this.options.endpoints,
    };
    if (this.options.fetchImpl) env.fetchImpl = this.options.fetchImpl;
    return env;
  }

  private async startAuthorization(scope?: string): Promise<LoginResult> {
    const env = await this.env();
    const challenge = await startDeviceFlow(env, scope ? { scope } : {});
    this.authorization = challenge;
    return this.authorizeResult(challenge);
  }

  private registerResult(challenge: RegistrationChallenge): LoginResult {
    return {
      stage: "register",
      userCode: challenge.userCode,
      verificationUri: challenge.verificationUriComplete ?? challenge.verificationUri,
      expiresIn: challenge.expiresIn,
    };
  }

  private authorizeResult(challenge: DeviceChallenge): LoginResult {
    return {
      stage: "authorize",
      userCode: challenge.userCode,
      verificationUri: challenge.verificationUriComplete ?? challenge.verificationUri,
      expiresIn: challenge.expiresIn,
    };
  }
}
