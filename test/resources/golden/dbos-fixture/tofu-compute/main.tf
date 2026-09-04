terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  # DIGITALOCEAN_TOKEN is supplied only to the OpenTofu process.
}

# Supplying only the configured region makes the provider retrieve that
# region's account-level default VPC. This deployment never creates a VPC and
# never stores a discovered UUID in colors.yml.
data "digitalocean_vpc" "default" {
  region = "ams3"
}

resource "digitalocean_droplet" "node1" {
  name     = "dbos-fixture"
  region   = "ams3"
  size     = "s-4vcpu-8gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = ["00000000"]

  connection {
    type = "ssh"
    user = "root"
    host = self.ipv4_address
  }

  provisioner "remote-exec" {
    inline = ["cloud-init status --wait"]
  }

  lifecycle {
    prevent_destroy = true

    postcondition {
      condition     = data.digitalocean_vpc.default.default
      error_message = "The discovered regional VPC is not DigitalOcean's default VPC."
    }
  }
}

resource "digitalocean_firewall" "node1" {
  name        = "dbos-fixture"
  droplet_ids = [digitalocean_droplet.node1.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["129.159.242.163/32"]
  }

  # 80 and 443 from the HTTP sources, and nothing else. A rule with no source
  # is not "closed" to DigitalOcean but an API error, so the HTTP rules are
  # emitted only when there is a source to name; an empty http-sources list
  # means no public HTTP at all.
  dynamic "inbound_rule" {
    for_each = length(["0.0.0.0/0", "::/0"]) > 0 ? [
      { protocol = "tcp", port_range = "80" },
      { protocol = "tcp", port_range = "443" },
    ] : []
    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port_range
      source_addresses = ["0.0.0.0/0", "::/0"]
    }
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

output "params" {
  value = {
    provider = "digitalocean"
    ip       = digitalocean_droplet.node1.ipv4_address
    sudoer   = "root"
    name     = "dbos-fixture"
    user     = "root"
    vpc_uuid = data.digitalocean_vpc.default.id
  }
}
