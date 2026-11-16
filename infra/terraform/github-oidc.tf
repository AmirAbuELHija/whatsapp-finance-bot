# GitHub Actions signs in to Google Cloud with short-lived OIDC tokens (Workload Identity Federation):
# no service-account keys exist anywhere. Only this repository can use the pool.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.name}-github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.repo_ref"   = "assertion.repository + '@' + assertion.ref"
  }

  # Tokens from any other repository are rejected outright.
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  pool        = google_iam_workload_identity_pool.github.name
  any_ref     = "principalSet://iam.googleapis.com/${local.pool}/attribute.repository/${var.github_repository}"
  deploy_only = "principalSet://iam.googleapis.com/${local.pool}/attribute.repo_ref/${var.github_repository}@refs/heads/${var.deploy_branch}"
}

# ── 1. Deployer: pushes images and points the VM at the new one (main branch only) ──
resource "google_service_account" "deployer" {
  account_id   = "${var.name}-gha-deployer"
  display_name = "GitHub Actions: deploy the bot"
}

resource "google_project_iam_custom_role" "deployer" {
  role_id     = "${var.name}BotDeployer"
  title       = "WhatsApp bot deployer"
  description = "Read the VM and change its metadata (the image to run). Nothing else."
  permissions = [
    "compute.instances.get",
    "compute.instances.setMetadata",
    "compute.zoneOperations.get",
  ]
}

resource "google_project_iam_member" "deployer" {
  for_each = {
    custom = google_project_iam_custom_role.deployer.id
    logs   = "roles/logging.viewer" # to confirm the bot reconnected after a deploy
  }

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Setting metadata on a VM that runs as a service account requires "act as" on that account.
resource "google_service_account_iam_member" "deployer_acts_as_vm" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.deploy_only
}

# ── 2. Planner: read-only, for `terraform plan` on pull requests ──
resource "google_service_account" "planner" {
  account_id   = "${var.name}-gha-planner"
  display_name = "GitHub Actions: terraform plan (read-only)"
}

resource "google_project_iam_member" "planner" {
  for_each = toset(["roles/viewer", "roles/iam.securityReviewer"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_service_account_iam_member" "planner_wif" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.any_ref
}

# ── 3. Applier: `terraform apply`, main branch only, behind the GitHub "production" approval ──
resource "google_service_account" "applier" {
  account_id   = "${var.name}-gha-applier"
  display_name = "GitHub Actions: terraform apply"
}

resource "google_project_iam_member" "applier" {
  for_each = toset([
    "roles/editor",
    "roles/resourcemanager.projectIamAdmin",
    "roles/iam.roleAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/secretmanager.admin",
    "roles/artifactregistry.admin",
    "roles/storage.admin",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.applier.email}"
}

resource "google_service_account_iam_member" "applier_wif" {
  service_account_id = google_service_account.applier.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.deploy_only
}

# Plans read the Terraform state. Granted on the state bucket only (roles/viewer cannot read object data,
# and a project-wide grant would also expose the WhatsApp session backups).
resource "google_storage_bucket_iam_member" "planner_reads_state" {
  bucket = coalesce(var.state_bucket, "${var.project_id}-tfstate")
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}
