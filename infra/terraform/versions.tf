terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.12"
    }
  }

  # State lives in a private, versioned GCS bucket created by infra/bootstrap.sh:
  #   terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "whatsapp-finance-bot"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  default_labels = {
    app        = "whatsapp-finance-bot"
    managed-by = "terraform"
  }
}
