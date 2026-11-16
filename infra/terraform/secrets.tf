# The bot's .env (API keys, allowed users...) lives in Secret Manager, never in Git or Terraform state.
# Terraform only creates the empty secret; add the content once with:
#   gcloud secrets versions add wfb-bot-env --data-file=.env
resource "google_secret_manager_secret" "bot_env" {
  secret_id = "${var.name}-bot-env"

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "vm_reads_env" {
  secret_id = google_secret_manager_secret.bot_env.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}
