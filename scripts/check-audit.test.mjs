import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MIN_SEVERITY, evaluateAudit, parseReport, SEVERITY_RANK } from "./check-audit.mjs";

/** pnpm audit 的干净输出（与 2026-11-25 实测一致：56 个 production 依赖）。 */
function cleanReport() {
  return {
    actions: [],
    advisories: {},
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: 56,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 56,
    },
  };
}

/** 一条 high 级 advisory，字段取自 pnpm 真实输出形状。 */
function reportWith(advisory) {
  const report = cleanReport();
  report.advisories = { 1098394: advisory };
  report.metadata.vulnerabilities.high = 1;
  return report;
}

const ZOD_ADVISORY = {
  id: 1098394,
  module_name: "zod",
  severity: "high",
  title: "zod 拒绝服务漏洞",
  vulnerable_versions: "<4.6.6",
  findings: [{ version: "4.4.3", paths: [".>@deepseek-ai/dsh-tools>zod"] }],
};

test("干净报告放行", () => {
  const result = evaluateAudit(cleanReport());
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("high 级漏洞拦截，并带出模块、版本范围与依赖路径", () => {
  const result = evaluateAudit(reportWith(ZOD_ADVISORY));
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.deepEqual(result.blocking[0], {
    id: "1098394",
    module: "zod",
    severity: "high",
    title: "zod 拒绝服务漏洞",
    vulnerableVersions: "<4.6.6",
    paths: [".>@deepseek-ai/dsh-tools>zod"],
  });
});

test("critical 也在默认阈值内", () => {
  const result = evaluateAudit(reportWith({ ...ZOD_ADVISORY, severity: "critical" }));
  assert.equal(result.ok, false);
});

test("moderate 低于默认阈值时放行，但统计里仍然可见", () => {
  const report = reportWith({ ...ZOD_ADVISORY, severity: "moderate" });
  const result = evaluateAudit(report);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, report.metadata.vulnerabilities);
});

test("显式把阈值降到 moderate 时同一份报告被拦", () => {
  const report = reportWith({ ...ZOD_ADVISORY, severity: "moderate" });
  const result = evaluateAudit(report, { minSeverity: "moderate" });
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].severity, "moderate");
});

test("未知严重级别按最严重处理，不放行", () => {
  const result = evaluateAudit(reportWith({ ...ZOD_ADVISORY, severity: "Severe" }));
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].severity, "Severe");
});

test("severity 字段缺失也不放行", () => {
  const { severity: _omit, ...withoutSeverity } = ZOD_ADVISORY;
  const result = evaluateAudit(reportWith(withoutSeverity));
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].severity, "unknown");
});

test("缺少 advisories 字段的失败不是「有漏洞」，而是「无法判断」", () => {
  const result = evaluateAudit({ metadata: { vulnerabilities: {} } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking, []);
  assert.match(result.reason, /advisories/);
});

test("报告不是对象时失败", () => {
  assert.equal(evaluateAudit(null).ok, false);
  assert.equal(evaluateAudit([]).ok, false);
  assert.equal(evaluateAudit("ok").ok, false);
});

test("非法阈值失败而不是静默用默认值", () => {
  const result = evaluateAudit(cleanReport(), { minSeverity: "严重" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /未知的严重级别阈值/);
});

test("默认阈值是 high，级别表覆盖 npm audit 的五个值", () => {
  assert.equal(DEFAULT_MIN_SEVERITY, "high");
  assert.deepEqual(Object.keys(SEVERITY_RANK), ["info", "low", "moderate", "high", "critical"]);
});

test("parseReport 解析纯 JSON", () => {
  const parsed = parseReport(JSON.stringify(cleanReport()));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.report, cleanReport());
});

test("parseReport 容忍 JSON 前后的提示行", () => {
  const parsed = parseReport(`WARN registry 响应慢\n${JSON.stringify(cleanReport())}\n`);
  assert.equal(parsed.ok, true);
});

test("parseReport 对空输出与非 JSON 输出失败", () => {
  const empty = parseReport("  \n ");
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有输出任何内容/);

  const garbage = parseReport("ERROR 无法连接 registry");
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /不是合法 JSON/);
  assert.match(garbage.preview, /无法连接 registry/);
});
