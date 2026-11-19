import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DocumentSnapshot } from "./docx.js";

/**
 * 读文档的缓存。设计上只是"加速"，不是事实源：任何条目丢了都能重新拉。
 * 键必须带版本号与读取预算，否则不同版本的同一篇文档会互相污染。
 */

export interface CacheEntry {
  snapshot: DocumentSnapshot;
  /** 写入缓存的时间（毫秒），用于过期判断。 */
  fetchedAt: number;
}

export interface DocumentCache {
  /** 命中且未过期时返回条目；过期条目顺手清掉。 */
  get(key: string, ttlMs: number): Promise<CacheEntry | null>;
  set(key: string, snapshot: DocumentSnapshot): Promise<void>;
  /**
   * 清扫：删掉超过 ttl 的条目、超龄的临时文件，并把条目数压回上限。
   * 由启动、每次写缓存、身份切换三处触发；失败不影响读取。
   */
  prune(ttlMs: number): Promise<void>;
  /** 清空全部条目（登出、切换账号时用）。 */
  clear(): Promise<void>;
}

/** 缓存键：文档 id、版本号与读取预算三者共同决定一次读取结果。 */
export function documentCacheKey(
  documentId: string,
  revisionId: string,
  limits: { maxBlocks: number; maxBytes: number }
): string {
  return `${documentId}|${revisionId}|${limits.maxBlocks}|${limits.maxBytes}`;
}

function isSnapshot(value: unknown): value is DocumentSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.documentId === "string" &&
    typeof record.revisionId === "string" &&
    typeof record.title === "string" &&
    typeof record.markdown === "string" &&
    typeof record.truncated === "boolean" &&
    Array.isArray(record.blocks) &&
    record.blocks.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { block_id?: unknown }).block_id === "string" &&
        typeof (block as { block_type?: unknown }).block_type === "number" &&
        typeof (block as { text?: unknown }).text === "string"
    )
  );
}

/** 进程内缓存，主要给单测与无存储目录的场景用。 */
export class MemoryDocumentCache implements DocumentCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(key: string, ttlMs: number): Promise<CacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt >= ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, snapshot: DocumentSnapshot): Promise<void> {
    this.entries.set(key, { snapshot, fetchedAt: Date.now() });
  }

  async prune(ttlMs: number): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.fetchedAt >= ttlMs) this.entries.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** 写盘中断遗留的临时文件，超过这个年龄按垃圾清掉。 */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** 条目数上限。写入只发生在未命中之后，所以在清扫里压容量就够。 */
const DEFAULT_MAX_ENTRIES = 200;

/**
 * 磁盘缓存：一条记录一个文件，文件名取键的哈希。
 * 写入走临时文件 + rename，读到半截内容就按未命中处理。
 */
export class FileDocumentCache implements DocumentCache {
  private readonly maxEntries: number;

  constructor(private readonly dir: string, options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private fileOf(key: string): string {
    return path.join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  async get(key: string, ttlMs: number): Promise<CacheEntry | null> {
    const file = this.fileOf(key);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await fs.rm(file, { force: true }).catch(() => undefined);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { key?: unknown; fetchedAt?: unknown; snapshot?: unknown };
    if (record.key !== key || typeof record.fetchedAt !== "number" || !isSnapshot(record.snapshot)) return null;
    if (Date.now() - record.fetchedAt >= ttlMs) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      return null;
    }
    return { snapshot: record.snapshot, fetchedAt: record.fetchedAt };
  }

  async set(key: string, snapshot: DocumentSnapshot): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileOf(key);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const payload = JSON.stringify({ key, fetchedAt: Date.now(), snapshot });
    await fs.writeFile(temp, payload, "utf8");
    await fs.rename(temp, file);
  }

  async prune(ttlMs: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }

    const now = Date.now();
    const survivors: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const stat = await fs.stat(file);
        if (name.endsWith(".tmp")) {
          if (now - stat.mtimeMs >= TMP_MAX_AGE_MS) await fs.rm(file, { force: true });
          continue;
        }
        if (!name.endsWith(".json")) continue;
        if (now - stat.mtimeMs >= ttlMs) {
          await fs.rm(file, { force: true });
          continue;
        }
        survivors.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // 并发删除或权限问题都不该影响读取。
      }
    }

    if (survivors.length <= this.maxEntries) return;
    survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const { file } of survivors.slice(0, survivors.length - this.maxEntries)) {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json") || name.endsWith(".tmp"))
        .map((name) => fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined))
    );
  }
}
