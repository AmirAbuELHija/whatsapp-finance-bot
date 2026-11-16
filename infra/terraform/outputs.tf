output "instance" {
  value = google_compute_instance.bot.name
}

output "image_repository" {
  description = "Push images here."
  value       = local.image_repo
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}

output "secret" {
  value = google_secret_manager_secret.bot_env.secret_id
}

output "github_variables" {
  description = "Set these as GitHub repository variables (Settings → Secrets and variables → Actions → Variables). None of them is secret."
  value = {
    GCP_PROJECT_ID   = var.project_id
    GCP_REGION       = var.region
    GCP_ZONE         = var.zone
    GCP_INSTANCE     = google_compute_instance.bot.name
    GCP_IMAGE_REPO   = local.image_repo
    GCP_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA  = google_service_account.deployer.email
    GCP_PLANNER_SA   = google_service_account.planner.email
    GCP_APPLIER_SA   = google_service_account.applier.email
  }
}
