terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN is supplied only to the OpenTofu process.
}

resource "cloudflare_r2_bucket" "postgres" {
  account_id    = "<{ cloudflare-account-id }>"
  name          = "<{ postgres-backup-r2-bucket }>"
  jurisdiction  = "eu"
  location      = "weur"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}
