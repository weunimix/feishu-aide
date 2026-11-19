import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 自动注册得到的应用凭据。用户 token 会过期，应用凭据不会——它代表"这个
 * 插件在这个租户里有一个应用"，重新登录只复用，不重复创建。
 *
 * 因此登出清的是令牌，不清这里；只有显式重置才删 `app.json`。
 * 文件权限 0600，内容永不进日志与工具结果。
 */

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

export interface AppCredentialStore {
  load(): Promise<AppCredentials | null>;
  save(credentials: AppCredentials): Promise<void>;
  clear(): Promise<void>;
}

export class FileAppCredentialStore implements AppCredentialStore {
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "app.json");
  }

  async load(): Promise<AppCredentials | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 损坏的应用凭据等同于没有：宁可重新走一次确认，也不要拿半个凭据发请求。
      return null;
    }
    return isAppCredentials(parsed) ? parsed : null;
  }

  async save(credentials: AppCredentials): Promise<void> {
    const payload = JSON.stringify(credentials, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writeChain;
  }

  async clear(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await rm(this.file, { force: true });
    });
    return this.writeChain;
  }
}

function isAppCredentials(value: unknown): value is AppCredentials {
  if (!value || typeof value !== "object") return false;
  const credentials = value as Record<string, unknown>;
  return (
    typeof credentials.appId === "string" &&
    credentials.appId.length > 0 &&
    typeof credentials.appSecret === "string" &&
    credentials.appSecret.length > 0
  );
}

export class MemoryAppCredentialStore implements AppCredentialStore {
  private credentials: AppCredentials | null = null;

  async load(): Promise<AppCredentials | null> {
    return this.credentials;
  }

  async save(credentials: AppCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = null;
  }
}
