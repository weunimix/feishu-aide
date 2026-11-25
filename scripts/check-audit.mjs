#!/usr/bin/env node
/**
 * 运行时依赖漏洞门禁：从 stdin 读 `pnpm audit --prod --json` 的输出，判断
 * production 闭包里是否存在达到阈值的已知漏洞。
 *
 * 为什么不直接写 `pnpm audit --prod --audit-level=high`：
 *
 *   1. 需要区分「有漏洞」和「审计没跑起来」。registry 不可达、输出不是 JSON、
 *      报告缺字段，这三种情况直接放行等于门禁静默失效；本脚本一律按失败处理。
 *   2. 需要一条可单测的决策边界。阈值、未知级别、报告残缺的处理写进纯函数
 *      `evaluateAudit`，CI 里跑的是同一份代码。
 *
 * 为什么只看 production：发布物不带 node_modules，用户安装时解析的是
 * dependencies。devDependencies 的告警（例如经 @deepseek-ai/dsh-tools 传入的
 * zod）不会进入用户的依赖树，卡在这里只会让门禁长期变红、最后被人关掉。
 *
 * 为什么默认阈值是 high：npm 库里 moderate 及以下有大量需要特定调用路径才能
 * 触发的条目，把它们设成硬门禁的收益低于「门禁被人绕过」的代价。需要更严时
 * 传 `--min-severity moderate`，边界由单测固定。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 严重级别从低到高。npm audit 的字段值是这五个之一。 */
export const SEVERITY_RANK = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

export const DEFAULT_MIN_SEVERITY = "high";

/**
 * 解析 audit 输出。pnpm 偶尔会在 JSON 前后混入提示行（例如 registry 警告），
 * 因此先整体解析，失败后退回到「第一个 { 到最后一个 }」。
 *
 * @param {string} text
 * @returns {{ok: true, report: unknown} | {ok: false, error: string, preview?: string}}
 */
export function parseReport(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") {
    return { ok: false, error: "audit 没有输出任何内容（命令未执行成功？）" };
  }

  try {
    return { ok: true, report: JSON.parse(trimmed) };
  } catch {
    // 落到下面的容错解析。
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return { ok: true, report: JSON.parse(trimmed.slice(start, end + 1)) };
    } catch {
      // 落到下面的失败分支。
    }
  }

  return {
    ok: false,
    error: "audit 输出不是合法 JSON",
    preview: trimmed.slice(0, 200),
  };
}

/**
 * 判断审计报告是否放行。纯函数：不做 IO，不读环境变量，结果只取决于入参。
 *
 * 安全侧默认值：报告缺 advisories、严重级别字段缺失或拼错、阈值本身非法，
 * 全部按失败处理——「无法判断」不等于「没有问题」。
 *
 * @param {unknown} report pnpm audit 的 JSON 报告
 * @param {{minSeverity?: string}} [options]
 * @returns {{ok: boolean, reason?: string, blocking: Array<{id: string, module: string, severity: string, title: string, vulnerableVersions: string, paths: string[]}>, counts: Record<string, number>}}
 */
export function evaluateAudit(report, options = {}) {
  const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const threshold = SEVERITY_RANK[minSeverity];

  if (typeof threshold !== "number") {
    return {
      ok: false,
      reason: `未知的严重级别阈值：${String(minSeverity)}（可选 ${Object.keys(SEVERITY_RANK).join(" / ")}）`,
      blocking: [],
      counts: {},
    };
  }

  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, reason: "audit 报告不是对象", blocking: [], counts: {} };
  }

  const advisories = /** @type {Record<string, unknown>} */ (report).advisories;
  if (advisories === null || typeof advisories !== "object" || Array.isArray(advisories)) {
    return {
      ok: false,
      reason: "audit 报告缺少 advisories 字段，无法判断是否存在漏洞",
      blocking: [],
      counts: {},
    };
  }

  const blocking = [];
  for (const [key, raw] of Object.entries(advisories)) {
    const advisory = /** @type {Record<string, any>} */ (raw ?? {});
    const severity = typeof advisory.severity === "string" ? advisory.severity : "unknown";
    const rank = SEVERITY_RANK[severity];

    // 未知级别按最严重处理：字段缺失或上游改了枚举值时宁可拦住。
    const isBlocking = typeof rank !== "number" || rank >= threshold;
    if (!isBlocking) continue;

    const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
    blocking.push({
      id: String(advisory.id ?? key),
      module: String(advisory.module_name ?? "unknown"),
      severity,
      title: String(advisory.title ?? ""),
      vulnerableVersions: String(advisory.vulnerable_versions ?? ""),
      paths: findings.flatMap((finding) =>
        Array.isArray(finding?.paths) ? finding.paths.map((p) => String(p)) : [],
      ),
    });
  }

  const counts =
    report.metadata && typeof report.metadata === "object" && report.metadata.vulnerabilities
      ? report.metadata.vulnerabilities
      : {};

  return { ok: blocking.length === 0, blocking, counts };
}

/** @param {string[]} argv @param {string} name */
function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} 需要一个值`);
  }
  return value;
}

/** 读完 stdin 全部内容。调用方已确认 stdin 不是 TTY。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const minSeverity = readFlag(argv, "--min-severity") ?? DEFAULT_MIN_SEVERITY;
  const inputPath = readFlag(argv, "--input");

  let text;
  if (inputPath) {
    text = readFileSync(inputPath, "utf8");
  } else if (process.stdin.isTTY) {
    console.error(
      "check-audit: 需要从 stdin 读 audit 报告，例如：\n  pnpm audit --prod --json | node scripts/check-audit.mjs",
    );
    process.exitCode = 2;
    return;
  } else {
    text = await readStdin();
  }

  const parsed = parseReport(text);
  if (!parsed.ok) {
    console.error(`check-audit: ${parsed.error}`);
    if (parsed.preview) console.error(`  输出开头：${parsed.preview}`);
    process.exitCode = 2;
    return;
  }

  const result = evaluateAudit(parsed.report, { minSeverity });
  const summary = ["critical", "high", "moderate", "low", "info"]
    .map((level) => `${level}=${result.counts[level] ?? 0}`)
    .join(" ");

  if (!result.ok && result.blocking.length === 0) {
    console.error(`check-audit: ${result.reason}`);
    process.exitCode = 2;
    return;
  }

  if (result.ok) {
    console.log(`check-audit: production 依赖无 >= ${minSeverity} 的已知漏洞（${summary}）`);
    return;
  }

  for (const item of result.blocking) {
    console.error(
      `check-audit: [${item.severity}] ${item.module} ${item.vulnerableVersions} — ${item.title}（GHSA/ID ${item.id}）`,
    );
    for (const p of item.paths.slice(0, 5)) {
      console.error(`  依赖路径：${p}`);
    }
  }
  console.error(
    `check-audit: production 依赖存在 ${result.blocking.length} 条 >= ${minSeverity} 的已知漏洞（${summary}）`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`check-audit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
