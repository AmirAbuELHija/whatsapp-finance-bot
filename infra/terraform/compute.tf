# ── The VM's identity: only what the bot needs ──────────────────────────────
resource "google_service_account" "vm" {
  account_id   = "${var.name}-vm"
  display_name = "WhatsApp bot VM"
  depends_on   = [google_project_service.this]
}

resource "google_project_iam_member" "vm" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_artifact_registry_repository_iam_member" "vm_pulls" {
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.vm.email}"
}

# ── The VM ──────────────────────────────────────────────────────────────────
data "google_compute_image" "cos" {
  family  = "cos-stable"
  project = "cos-cloud"
}

locals {
  registry_host = "${var.region}-docker.pkg.dev"
  image_repo    = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.this.repository_id}/bot"

  vm_files = {
    for f in ["common.sh", "run-bot.sh", "backup-auth.sh", "deploy-watcher.sh"] :
    f => file("${path.module}/../vm/${f}")
  }

  cloud_init = templatefile("${path.module}/../vm/cloud-init.yaml.tftpl", {
    project_id    = var.project_id
    secret_name   = google_secret_manager_secret.bot_env.secret_id
    bucket        = google_storage_bucket.backups.name
    registry_host = local.registry_host
    files         = local.vm_files
  })
}

resource "google_compute_instance" "bot" {
  name         = "${var.name}-bot"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["${var.name}-bot"]

  allow_stopping_for_update = true
  deletion_protection       = var.deletion_protection

  boot_disk {
    auto_delete = true
    initialize_params {
      image = data.google_compute_image.cos.self_link
      size  = var.boot_disk_gb
      type  = "pd-standard" # the free-tier disk type
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.this.id
    # Ephemeral public IP for outbound traffic only (no firewall rule lets anything in).
    access_config {
      network_tier = "STANDARD"
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"] # access is limited by IAM roles, not scopes
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
    preemptible         = false
  }

  metadata = {
    user-data                 = local.cloud_init
    enable-oslogin            = "TRUE"
    block-project-ssh-keys    = "TRUE"
    google-logging-enabled    = "true"
    google-monitoring-enabled = "true"
    cos-update-strategy       = "update_enabled"
    # The image to run. CI changes this on every deploy; the VM notices and restarts the bot.
    bot-image = ""
  }

  lifecycle {
    # Deploys change bot-image outside Terraform; COS updates itself, so don't recreate on new images.
    ignore_changes = [metadata["bot-image"], boot_disk[0].initialize_params[0].image]
  }

  depends_on = [
    google_project_iam_member.vm,
    google_secret_manager_secret_iam_member.vm_reads_env,
    google_storage_bucket_iam_member.vm_backups,
    google_artifact_registry_repository_iam_member.vm_pulls,
  ]
}

# ── Admins: SSH through IAP with OS Login (no SSH keys in metadata) ──────────
resource "google_project_iam_member" "admins" {
  for_each = {
    for pair in setproduct(var.admin_members, ["roles/iap.tunnelResourceAccessor", "roles/compute.osAdminLogin"]) :
    "${pair[0]}|${pair[1]}" => { member = pair[0], role = pair[1] }
  }

  project = var.project_id
  role    = each.value.role
  member  = each.value.member
}
