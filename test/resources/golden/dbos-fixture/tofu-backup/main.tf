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
  account_id    = "319271fed8bc6d2d9059362be1165f37"
  name          = "dbos-digitalocean"
  jurisdiction  = "eu"
  location      = "weur"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}
