import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TokenSet } from "./device-flow.js";

/**
 * 授权状态的唯一持有者。进程内只允许一个 writer：插件启动时构造一次，
 * 交给所有工具共用。文件写入走"临时文件 + rename"，避免半截 JSON。
 */
export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(token: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export class FileTokenStore implements TokenStore {
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "tokens.json");
  }

  async load(): Promise<TokenSet | null> {
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
      // 损坏的 token 文件等同于未授权：宁可让用户重新登录，也不要带半个凭据跑。
      return null;
    }
    return isTokenSet(parsed) ? parsed : null;
  }

  async save(token: TokenSet): Promise<void> {
    const payload = JSON.stringify(token, null, 2);
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

function isTokenSet(value: unknown): value is TokenSet {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.accessToken === "string" &&
    token.accessToken.length > 0 &&
    typeof token.expiresAt === "number" &&
    Number.isFinite(token.expiresAt)
  );
}

export class MemoryTokenStore implements TokenStore {
  private token: TokenSet | null = null;

  async load(): Promise<TokenSet | null> {
    return this.token;
  }

  async save(token: TokenSet): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}
