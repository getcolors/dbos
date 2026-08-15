(ns io.github.getcolors.dbos.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [green.providers :as provider-ops]))

(def required
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :dbos-host :dbos-image :dbos-version :dbos-version-source-url
   :dbos-version-discovered :dbos-node-version :dbos-application-name
   :dbos-data-dir :dbos-durable-delay-seconds :dbos-step-max-attempts
   :dbos-step-initial-retry-seconds :dbos-workflow-retention-days
   :postgres-version :postgres-data-dir :postgres-database
   :dbos-system-database-pool-size :postgres-backup-r2-bucket
   :postgres-backup-r2-endpoint :postgres-backup-r2-region
   :postgres-backup-r2-prefix :postgres-backup-retention-days
   :postgres-backup-oncalendar :digitalocean-name :digitalocean-region
   :digitalocean-size :digitalocean-image :digitalocean-ssh-authorized-keys
   :digitalocean-ssh-key-name :digitalocean-ssh-private-key :digitalocean-ssh-sources :digitalocean-http-sources
   :digitalocean-https-sources :digitalocean-vpc-mode
   :cloudflare-zone :cloudflare-proxied])

(def runtime-secrets
  [:do-token :cloudflare-api-token :dbos-postgres-password
   :postgres-backup-r2-access-key-id :postgres-backup-r2-secret-access-key])

(def profile-par (green-cli/par-name :profile))
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def version-re #"^[0-9]+\.[0-9]+\.[0-9]+$")
(def image-re #"^ghcr\.io/getcolors/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$")
(def cidr-re #"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-fA-F:]+/[0-9]{1,3}$")

(defn placeholder? [x] (provider-ops/placeholder? x))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set. This package takes profile from colors.yml only.")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (placeholder? (get opts k))] (str k " is required"))
    (when-not (or (placeholder? (:dbos-host opts))
                  (re-matches host-re (str (:dbos-host opts))))
      [":dbos-host must be a fully qualified hostname"])
    (when-not (or (placeholder? (:dbos-image opts))
                  (re-matches image-re (str (:dbos-image opts))))
      [":dbos-image must be ghcr.io/getcolors/dbos with an explicit tag or digest"])
    (when-not (or (placeholder? (:dbos-version opts))
                  (re-matches version-re (str (:dbos-version opts))))
      [":dbos-version must be an exact semantic version"])
    (when (and (not (placeholder? (:dbos-version opts)))
               (not (str/includes? (str (:dbos-image opts)) (str (:dbos-version opts)))))
      [":dbos-image tag must match :dbos-version"])
    (when-not (= "digitalocean" (:provider-compute opts))
      [":provider-compute must be digitalocean"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (= "default" (:digitalocean-vpc-mode opts))
      [":digitalocean-vpc-mode must be default"])
    (when (or (contains? opts :digitalocean-vpc-uuid)
              (contains? opts :digitalocean-vpc-cidr))
      ["a VPC UUID or CIDR must not be configured; the regional default VPC is discovered at runtime"])
    (when-not (= (:cloudflare-zone opts) (:dbos-host opts))
      [":dbos-host must be the apex of :cloudflare-zone"])
    (for [k [:dbos-durable-delay-seconds :dbos-step-max-attempts
             :dbos-step-initial-retry-seconds :dbos-workflow-retention-days
             :dbos-system-database-pool-size :postgres-backup-retention-days]
          :let [v (get opts k)]
          :when (and (not (placeholder? v)) (not (and (integer? v) (pos? v))))]
      (str k " must be a positive integer"))
    (when (and (integer? (:dbos-system-database-pool-size opts))
               (< (:dbos-system-database-pool-size opts) 5))
      [":dbos-system-database-pool-size must be at least 5 for production"])
    (for [k [:digitalocean-ssh-sources :digitalocean-http-sources :digitalocean-https-sources]
          cidr (get opts k [])
          :when (not (re-matches cidr-re (str cidr)))]
      (str k " contains invalid CIDR " cidr)))))

(defn secret-errors [opts]
  (let [keys (cond-> runtime-secrets
               (= "r2" (:provider-backend opts))
               (into [:r2-access-key-id :r2-secret-access-key]))]
    (map #(str "required credential is not set: " (green-cli/par-name %))
         (filter #(placeholder? (get opts %)) keys))))
