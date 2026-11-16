#!/usr/bin/env bash
# One-time setup of the Google Cloud project, run from your own computer (you are the project owner).
# After this, GitHub Actions manages everything with short-lived, keyless credentials.
#
# Needs: gcloud (logged in: gcloud auth login && gcloud auth application-default login), terraform >= 1.6,
#        and optionally the GitHub CLI (gh auth login) to set the repository variables for you.
#
# Usage: infra/bootstrap.sh <gcp-project-id> <github-owner/repo> <alert-email> [budget-usd]
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <gcp-project-id> <github-owner/repo> <alert-email> [monthly-budget-usd]" >&2
  exit 64
fi
PROJECT_ID="$1"
REPO="$2"
ALERT_EMAIL="$3"
BUDGET_USD="${4:-10}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
STATE_BUCKET="${PROJECT_ID}-tfstate"
HERE="$(cd "$(dirname "$0")" && pwd)"
TF_DIR="${HERE}/terraform"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

step "Project ${PROJECT_ID}"
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com storage.googleapis.com \
  compute.googleapis.com billingbudgets.googleapis.com

step "Terraform state bucket gs://${STATE_BUCKET} (private, versioned)"
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${STATE_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi

step "Terraform variables"
if [[ ! -f "${TF_DIR}/terraform.tfvars" ]]; then
  cat >"${TF_DIR}/terraform.tfvars" <<VARS
project_id        = "${PROJECT_ID}"
region            = "${REGION}"
zone              = "${ZONE}"
github_repository = "${REPO}"
alert_email       = "${ALERT_EMAIL}"
# Project owners can already SSH through IAP; add others here, e.g. ["user:friend@gmail.com"].
admin_members     = []
VARS
  echo "Wrote ${TF_DIR}/terraform.tfvars (git-ignored)"
fi

step "Create the infrastructure (first apply runs here; later ones run in GitHub Actions)"
terraform -chdir="$TF_DIR" init -backend-config="bucket=${STATE_BUCKET}"
terraform -chdir="$TF_DIR" apply

step "Budget alert: ${BUDGET_USD} USD/month, counted before credits"
billing="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
if [[ -n "$billing" ]] && ! gcloud billing budgets list --billing-account="$billing" --format='value(displayName)' | grep -qx "wfb ${PROJECT_ID}"; then
  number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  gcloud billing budgets create --billing-account="$billing" --display-name="wfb ${PROJECT_ID}" \
    --budget-amount="${BUDGET_USD}USD" --filter-projects="projects/${number}" \
    --credit-types-treatment=exclude-all-credits \
    --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 ||
    echo "⚠️  Could not create the budget alert. Create it in the console: Billing → Budgets & alerts."
fi

step "GitHub repository variables (not secrets: nothing here grants access by itself)"
vars_json="$(terraform -chdir="$TF_DIR" output -json github_variables)"
admins="[]"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  while IFS='=' read -r key value; do
    gh variable set "$key" --repo "$REPO" --body "$value"
  done < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' <<<"$vars_json")
  gh variable set TF_STATE_BUCKET --repo "$REPO" --body "$STATE_BUCKET"
  gh variable set ALERT_EMAIL --repo "$REPO" --body "$ALERT_EMAIL"
  gh variable set TF_ADMIN_MEMBERS --repo "$REPO" --body "$admins"

  step "GitHub environment 'production': deploys and applies wait for your approval, main branch only"
  me="$(gh api user -q .id)"
  gh api -X PUT "repos/${REPO}/environments/production" --input - <<JSON || echo "⚠️  Required reviewers need a public repo or GitHub Pro; set it up in Settings → Environments."
{"reviewers":[{"type":"User","id":${me}}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
  gh api -X POST "repos/${REPO}/environments/production/deployment-branch-policies" -f name=main >/dev/null 2>&1 || true
else
  echo "GitHub CLI not logged in. Add these in GitHub → Settings → Secrets and variables → Actions → Variables:"
  jq -r 'to_entries[] | "  \(.key)=\(.value)"' <<<"$vars_json"
  echo "  TF_STATE_BUCKET=${STATE_BUCKET}"
  echo "  ALERT_EMAIL=${ALERT_EMAIL}"
  echo "  TF_ADMIN_MEMBERS=${admins}"
fi

cat <<NEXT

✅ Infrastructure is ready. Next:
  1. Upload the bot settings:   infra/upload-config.sh ${PROJECT_ID} .env
  2. Move the WhatsApp login:   stop the bot on your Mac, then  infra/upload-session.sh ${PROJECT_ID} auth
  3. Push to main: GitHub Actions builds, scans and deploys the bot.
NEXT
