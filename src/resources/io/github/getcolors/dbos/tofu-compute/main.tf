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
  region = "<{ digitalocean-region }>"
}

# Reuse the configured account key by name. It is data, not a deployment-owned
# resource, so this workflow can never delete the pre-existing key.
data "digitalocean_ssh_key" "operator" {
  name = "<{ digitalocean-ssh-key-name }>"
}

resource "digitalocean_droplet" "node1" {
  name     = "<{ digitalocean-name }>"
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = [data.digitalocean_ssh_key.operator.id]

  connection {
    type        = "ssh"
    user        = "root"
    host        = self.ipv4_address
    private_key = file(pathexpand("<{ digitalocean-ssh-private-key }>"))
  }

  provisioner "remote-exec" {
    inline = ["cloud-init status --wait"]
  }

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>

    postcondition {
      condition     = data.digitalocean_vpc.default.default
      error_message = "The discovered regional VPC is not DigitalOcean's default VPC."
    }
  }
}

resource "digitalocean_firewall" "node1" {
  name        = "<{ digitalocean-name }>"
  droplet_ids = [digitalocean_droplet.node1.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = <{ digitalocean-ssh-sources-hcl|safe }>
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = <{ digitalocean-http-sources-hcl|safe }>
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = <{ digitalocean-https-sources-hcl|safe }>
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
    ip       = digitalocean_droplet.node1.ipv4_address
    sudoer   = "root"
    name     = "<{ profile }>"
    user     = "root"
    vpc_uuid = data.digitalocean_vpc.default.id
  }
}
