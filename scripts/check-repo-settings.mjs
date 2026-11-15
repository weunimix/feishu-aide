#!/usr/bin/env node
// 仓库设置漂移检测：读取 GitHub 线上设置，与 docs/repo-settings.baseline.json 比对。
// 这些设置不在 git 里，改一次没有 diff；本脚本把它们变成可断言的值。
// 需要 admin 级只读 token（fine-grained PAT: Administration read + Metadata read）。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BASELINE_PATH = path.resolve(process.cwd(), "docs/repo-settings.baseline.json");

const API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "feishu-aide-repo-audit",
};

async function api(token, route) {
  const res = await fetch(`${API}${route}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (res.status === 204) return true;
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function sorted(values) {
  return [...(values ?? [])].sort((a, b) => a.localeCompare(b));
}

/** 规则集只保留与门禁相关的字段；上下文顺序不影响语义，统一排序后再比。 */
export function normalizeRuleset(raw) {
  return {
    name: raw.name,
    target: raw.target,
    enforcement: raw.enforcement,
    conditions: raw.conditions,
    bypass_actors: (raw.bypass_actors ?? []).map((actor) => ({
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      bypass_mode: actor.bypass_mode,
    })),
    rules: (raw.rules ?? [])
      .map((rule) => {
        if (rule.type !== "required_status_checks") return { ...rule };
        const parameters = rule.parameters;
        return {
          type: rule.type,
          parameters: {
            ...parameters,
            required_status_checks: (parameters.required_status_checks ?? [])
              .map((check) => ({ ...check }))
              .sort((a, b) => a.context.localeCompare(b.context)),
          },
        };
      })
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

/** 把 API 原始响应整理成稳定的审计对象（纯函数，便于测试）。 */
export function buildAudit(input) {
  const repo = input.repository;
  const selected = input.selectedActions ?? {};
  const workflow = input.workflowPermissions;
  const analysis = repo.security_and_analysis ?? {};

  return {
    repository: {
      allow_squash_merge: repo.allow_squash_merge,
      allow_merge_commit: repo.allow_merge_commit,
      allow_rebase_merge: repo.allow_rebase_merge,
      allow_auto_merge: repo.allow_auto_merge,
      delete_branch_on_merge: repo.delete_branch_on_merge,
      has_wiki: repo.has_wiki,
      has_projects: repo.has_projects,
      has_discussions: repo.has_discussions,
    },
    security: {
      secret_scanning: analysis.secret_scanning?.status ?? "unavailable",
      secret_scanning_push_protection: analysis.secret_scanning_push_protection?.status ?? "unavailable",
      secret_scanning_validity_checks: analysis.secret_scanning_validity_checks?.status ?? "unavailable",
      dependabot_alerts: Boolean(input.vulnerabilityAlerts),
      dependabot_security_updates: input.automatedSecurityFixes?.enabled ?? false,
      private_vulnerability_reporting: input.privateVulnerabilityReporting?.enabled ?? false,
    },
    actions: {
      enabled: input.actionsPermissions?.enabled,
      allowed_actions: input.actionsPermissions?.allowed_actions,
      sha_pinning_required: input.actionsPermissions?.sha_pinning_required,
      github_owned_allowed: selected.github_owned_allowed ?? false,
      verified_allowed: selected.verified_allowed ?? false,
      patterns_allowed: sorted(selected.patterns_allowed),
      default_workflow_permissions: workflow?.default_workflow_permissions,
      can_approve_pull_request_reviews: workflow?.can_approve_pull_request_reviews,
    },
    rulesets: (input.rulesets ?? [])
      .map(normalizeRuleset)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** 收集线上状态。owner/repo 与 token 都从外部传入，便于测试替身。 */
export async function collectLive(token, owner, repo) {
  const routes = {
    repository: `/repos/${owner}/${repo}`,
    actionsPermissions: `/repos/${owner}/${repo}/actions/permissions`,
    selectedActions: `/repos/${owner}/${repo}/actions/permissions/selected-actions`,
    workflowPermissions: `/repos/${owner}/${repo}/actions/permissions/workflow`,
    vulnerabilityAlerts: `/repos/${owner}/${repo}/vulnerability-alerts`,
    automatedSecurityFixes: `/repos/${owner}/${repo}/automated-security-fixes`,
    privateVulnerabilityReporting: `/repos/${owner}/${repo}/private-vulnerability-reporting`,
    rulesets: `/repos/${owner}/${repo}/rulesets`,
  };

  const entries = await Promise.all(
    Object.entries(routes).map(async ([key, route]) => [key, await api(token, route)]),
  );
  const input = Object.fromEntries(entries);

  const rulesetList = Array.isArray(input.rulesets) ? input.rulesets : [];
  input.rulesets = await Promise.all(
    rulesetList.map((item) => api(token, `/repos/${owner}/${repo}/rulesets/${item.id}`)),
  );
  return input;
}

function flatten(value, prefix, out) {
  if (value === null || typeof value !== "object") {
    out.set(prefix || "(root)", value);
    return out;
  }
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, value.length);
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** 返回人类可读的差异行；空数组表示一致。 */
export function diffAudit(expected, actual) {
  const expectedFlat = flatten(expected, "", new Map());
  const actualFlat = flatten(actual, "", new Map());
  const keys = new Set([...expectedFlat.keys(), ...actualFlat.keys()]);
  const lines = [];
  for (const key of [...keys].sort()) {
    const want = expectedFlat.has(key) ? JSON.stringify(expectedFlat.get(key)) : "(缺失)";
    const got = actualFlat.has(key) ? JSON.stringify(actualFlat.get(key)) : "(缺失)";
    if (want !== got) lines.push(`${key}: 期望 ${want}，实际 ${got}`);
  }
  return lines;
}

async function main() {
  const write = process.argv.includes("--write");
  const token = process.env.REPO_AUDIT_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error("缺少 token：设置 REPO_AUDIT_TOKEN（只读 admin）或 GH_TOKEN");
    process.exitCode = 2;
    return;
  }

  const owner = process.env.AUDIT_OWNER || "mmw-devs";
  const repo = process.env.AUDIT_REPO || "feishu-aide";
  const live = buildAudit(await collectLive(token, owner, repo));

  if (write) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(live, null, 2)}\n`, "utf8");
    console.log(`已写入基线：${path.relative(process.cwd(), BASELINE_PATH)}`);
    return;
  }

  const expected = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const lines = diffAudit(expected, live);
  if (lines.length === 0) {
    console.log("仓库设置与基线一致");
    return;
  }
  console.error("仓库设置发生漂移：");
  for (const line of lines) console.error(`- ${line}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`审计失败：${error.message}`);
    process.exitCode = 1;
  });
}
