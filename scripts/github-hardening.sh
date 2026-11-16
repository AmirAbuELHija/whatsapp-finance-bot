#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok() and warn() only print
# Applies the repository's security settings on GitHub (run once, and again any time to re-check).
# Needs the GitHub CLI logged in as the repository admin: gh auth login
# Usage: scripts/github-hardening.sh [owner/repo]
set -euo pipefail
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
ok() { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }

echo "Hardening ${REPO}"

echo "▶ Merge settings: squash only, delete branches after merge"
gh api -X PATCH "repos/${REPO}" --silent \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true -F web_commit_signoff_required=false &&
  ok "merge settings"

echo "▶ Security features"
gh api -X PATCH "repos/${REPO}" --silent --input - <<'JSON' && ok "secret scanning + push protection" || warn "secret scanning: enable in Settings → Code security"
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT "repos/${REPO}/vulnerability-alerts" --silent && ok "Dependabot alerts" || warn "Dependabot alerts"
gh api -X PUT "repos/${REPO}/automated-security-fixes" --silent && ok "Dependabot security updates" || warn "Dependabot security updates"
gh api -X PUT "repos/${REPO}/private-vulnerability-reporting" --silent && ok "private vulnerability reporting" || warn "private vulnerability reporting"

echo "▶ Actions: read-only token by default, workflows can't approve pull requests"
gh api -X PUT "repos/${REPO}/actions/permissions/workflow" --silent \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false && ok "workflow token"
gh api -X PUT "repos/${REPO}/actions/permissions/fork-pr-contributor-approval" --silent \
  -f approval_policy=all_external_contributors 2>/dev/null && ok "fork PRs need approval" ||
  warn "fork PR approval: Settings → Actions → General → 'Require approval for all external contributors'"

echo "▶ Ruleset for main: pull request + green checks, no force-push or deletion"
existing="$(gh api "repos/${REPO}/rulesets" --jq '.[] | select(.name=="protect-main") | .id')"
method=POST
path="repos/${REPO}/rulesets"
if [[ -n "$existing" ]]; then method=PUT; path="${path}/${existing}"; fi
gh api -X "$method" "$path" --silent --input - <<'JSON' && ok "ruleset protect-main"
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Lint, types & tests (ubuntu-latest, Node 22)" },
          { "context": "Docker image builds and passes the vulnerability scan" },
          { "context": "Dependency audit" },
          { "context": "VM scripts (shellcheck)" },
          { "context": "Trivy (dependencies, secrets, IaC misconfigurations)" },
          { "context": "CodeQL (TypeScript)" } ] } }
  ]
}
JSON

echo
echo "Done. Changes to main now go through a pull request with green checks."
echo "Check: Settings → Rules → protect-main, and Settings → Code security."
