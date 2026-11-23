variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region. us-central1, us-west1 and us-east1 are the only ones where an e2-micro is free."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the VM (inside var.region)."
  type        = string
  default     = "us-central1-a"
}

variable "github_repository" {
  description = "GitHub repository allowed to deploy, as owner/name (e.g. AmirAbuELHija/whatsapp-finance-bot)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Use the form owner/name."
  }
}

variable "deploy_branch" {
  description = "Only workflows running on this branch may deploy or apply Terraform."
  type        = string
  default     = "main"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "wfb"
}

variable "machine_type" {
  description = "e2-small (2 GB) leaves room for the headless Chromium that draws the \"@bot summary\" picture. e2-micro (1 GB) is free but tight: the bot then falls back to its built-in slides when Chromium can't start."
  type        = string
  default     = "e2-small"
}

variable "boot_disk_gb" {
  description = "Up to 30 GB of standard persistent disk is free."
  type        = number
  default     = 30
}

variable "enable_iap_ssh" {
  description = "Allow SSH through Identity-Aware Proxy only (no public SSH). Needed for 'gcloud compute ssh --tunnel-through-iap'."
  type        = bool
  default     = true
}

variable "admin_members" {
  description = "Who may SSH to the VM through IAP, e.g. [\"user:you@gmail.com\"]."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "Where to send alerts (bot down, logged out, budget). Empty = no alerts."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Protect the VM from accidental 'terraform destroy'."
  type        = bool
  default     = true
}

variable "state_bucket" {
  description = "Terraform state bucket (created by infra/bootstrap.sh). Empty = <project_id>-tfstate."
  type        = string
  default     = ""
}
