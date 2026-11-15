import test from "node:test";
import assert from "node:assert/strict";
import { buildAudit, diffAudit, normalizeRuleset } from "./check-repo-settings.mjs";

const repository = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
  has_wiki: false,
  has_projects: false,
  has_discussions: false,
  security_and_analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
    secret_scanning_validity_checks: { status: "disabled" },
  },
};

function liveInput(overrides = {}) {
  return {
    repository,
    actionsPermissions: { enabled: true, allowed_actions: "selected", sha_pinning_required: true },
    selectedActions: {
      github_owned_allowed: true,
      verified_allowed: true,
      patterns_allowed: ["pnpm/action-setup@*"],
    },
    workflowPermissions: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    vulnerabilityAlerts: true,
    automatedSecurityFixes: { enabled: true },
    privateVulnerabilityReporting: { enabled: true },
    rulesets: [
      {
        name: "main-protection",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        bypass_actors: [],
        rules: [
          { type: "deletion" },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              do_not_enforce_on_create: false,
              required_status_checks: [
                { context: "verify (windows-latest)" },
                { context: "verify (ubuntu-latest)" },
                { context: "PR title" },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("buildAudit 把线上响应整理成稳定结构", () => {
  const audit = buildAudit(liveInput());
  assert.equal(audit.repository.allow_squash_merge, true);
  assert.equal(audit.repository.allow_merge_commit, false);
  assert.equal(audit.security.secret_scanning_validity_checks, "disabled");
  assert.equal(audit.security.dependabot_alerts, true);
  assert.deepEqual(audit.actions.patterns_allowed, ["pnpm/action-setup@*"]);
  assert.equal(audit.actions.default_workflow_permissions, "read");
  assert.equal(audit.rulesets.length, 1);
});

test("required_status_checks 的上下文顺序不影响结果", () => {
  const a = buildAudit(liveInput());
  const reordered = buildAudit(
    liveInput({
      rulesets: [
        {
          ...liveInput().rulesets[0],
          rules: [
            { type: "deletion" },
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                do_not_enforce_on_create: false,
                required_status_checks: [
                  { context: "PR title" },
                  { context: "verify (ubuntu-latest)" },
                  { context: "verify (windows-latest)" },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(diffAudit(a, reordered), []);
});

test("规则按 type 排序，规则集按名称排序", () => {
  const ruleset = normalizeRuleset({
    name: "z",
    target: "branch",
    enforcement: "active",
    conditions: {},
    bypass_actors: [],
    rules: [
      { type: "required_linear_history" },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  });
  assert.deepEqual(
    ruleset.rules.map((rule) => rule.type),
    ["deletion", "non_fast_forward", "required_linear_history"],
  );
});

test("diffAudit 定位到具体字段", () => {
  const expected = buildAudit(liveInput());
  const actual = buildAudit(liveInput({ actionsPermissions: { enabled: true, allowed_actions: "all" } }));
  const lines = diffAudit(expected, actual);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.includes("actions.allowed_actions")));
  assert.ok(lines.some((line) => line.includes("actions.sha_pinning_required")));
});

test("缺失字段会报告为缺失，而不是静默通过", () => {
  const expected = { a: 1, nested: { b: true } };
  const lines = diffAudit(expected, { a: 1 });
  assert.deepEqual(lines, ["nested.b: 期望 true，实际 (缺失)"]);
});

test("security 字段缺失时标记为 unavailable", () => {
  const audit = buildAudit(liveInput({ repository: { ...repository, security_and_analysis: undefined } }));
  assert.equal(audit.security.secret_scanning, "unavailable");
  assert.equal(audit.security.dependabot_security_updates, true);
});
