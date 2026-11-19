import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileDocumentCache, MemoryDocumentCache } from "../../src/core/cache.js";
import type { DocumentSnapshot } from "../../src/core/docx.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "feishu-aide-cache-"));
}

function snapshot(revisionId = "10"): DocumentSnapshot {
  return {
    documentId: "DocAbc",
    revisionId,
    title: "测试文档",
    blocks: [{ block_id: "blk_text", block_type: 2, text: "第一段" }],
    markdown: "第一段",
    truncated: false,
  };
}

test("内存缓存：写入后可命中，超过 ttl 视为未命中", async () => {
  const cache = new MemoryDocumentCache();
  await cache.set("k1", snapshot());

  const hit = await cache.get("k1", 60_000);
  assert.equal(hit?.snapshot.markdown, "第一段");
  assert.equal(await cache.get("k2", 60_000), null);
  assert.equal(await cache.get("k1", 0), null);
});

test("内存缓存：prune 清掉过期条目", async () => {
  const cache = new MemoryDocumentCache();
  await cache.set("k1", snapshot());
  await cache.prune(0);
  assert.equal(await cache.get("k1", 60_000), null);
});

test("磁盘缓存：跨实例读回同一份快照", async () => {
  const dir = await tempDir();
  try {
    await new FileDocumentCache(dir).set("k1", snapshot());
    const hit = await new FileDocumentCache(dir).get("k1", 60_000);
    assert.deepEqual(hit?.snapshot, snapshot());
    assert.equal(await new FileDocumentCache(dir).get("k2", 60_000), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("磁盘缓存：内容损坏按未命中处理", async () => {
  const dir = await tempDir();
  try {
    const cache = new FileDocumentCache(dir);
    await cache.set("k1", snapshot());
    // 找到落盘文件并写坏它。
    const { readdir } = await import("node:fs/promises");
    const [name] = await readdir(dir);
    assert.ok(name);
    await writeFile(path.join(dir, name), "{ 不是 JSON", "utf8");
    assert.equal(await cache.get("k1", 60_000), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("磁盘缓存：prune 清掉过期文件、保留新文件", async () => {
  const dir = await tempDir();
  try {
    const cache = new FileDocumentCache(dir);
    await cache.set("old", snapshot("1"));
    await cache.set("new", snapshot("2"));

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    assert.equal(names.length, 2);
    const oldFile = names.find((name) => name.length > 0);
    assert.ok(oldFile);
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path.join(dir, oldFile), past, past);

    await cache.prune(60_000);
    assert.equal((await readdir(dir)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("内存缓存：clear 清空全部条目", async () => {
  const cache = new MemoryDocumentCache();
  await cache.set("k1", snapshot());
  await cache.clear();
  assert.equal(await cache.get("k1", 60_000), null);
});

test("磁盘缓存：prune 清掉超龄临时文件、保留新临时文件", async () => {
  const dir = await tempDir();
  try {
    const cache = new FileDocumentCache(dir);
    const staleTmp = path.join(dir, "orphan.tmp");
    const freshTmp = path.join(dir, "inflight.tmp");
    await writeFile(staleTmp, "{}", "utf8");
    await writeFile(freshTmp, "{}", "utf8");
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(staleTmp, past, past);

    await cache.prune(60_000);
    const names = await readdir(dir);
    assert.equal(names.includes("orphan.tmp"), false);
    assert.equal(names.includes("inflight.tmp"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("磁盘缓存：条目数超过上限时淘汰最旧的", async () => {
  const dir = await tempDir();
  try {
    const cache = new FileDocumentCache(dir, { maxEntries: 1 });
    await cache.set("old", snapshot("1"));

    // 把 old 的落盘文件改成很旧的 mtime，确定淘汰顺序。
    const past = new Date(Date.now() - 10 * 60_000);
    for (const name of await readdir(dir)) {
      const raw = await readFile(path.join(dir, name), "utf8");
      if (raw.includes('"key":"old"')) await utimes(path.join(dir, name), past, past);
    }

    await cache.set("fresh", snapshot("2"));
    await cache.prune(60_000);

    assert.equal((await readdir(dir)).length, 1);
    assert.equal(await cache.get("old", 60_000), null);
    assert.ok(await cache.get("fresh", 60_000));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("磁盘缓存：clear 清空条目与残留临时文件", async () => {
  const dir = await tempDir();
  try {
    const cache = new FileDocumentCache(dir);
    await cache.set("k1", snapshot());
    await writeFile(path.join(dir, "orphan.tmp"), "{}", "utf8");

    await cache.clear();
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await cache.get("k1", 60_000), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
