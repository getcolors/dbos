(ns io.github.getcolors.dbos.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [green.providers :as provider-ops]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are the non-secret keys that provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, and `:tofu-env` the
  subset OpenTofu reads from the process environment itself. Keeping the three
  together is what stops a provider being validated against one set of keys and
  run with another. The keys of this map are the advertised providers; a
  provider without a template directory and a golden is not advertised, and
  this package advertises one.

  Two keys the template reads are deliberately not required. `digitalocean-name`
  is an optional override of the profile (Compute Name Standard), and
  `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard)."
  {"digitalocean"
   {:required [:digitalocean-region :digitalocean-size :digitalocean-image
               :digitalocean-ssh-sources :digitalocean-http-sources]
    :secrets [:do-token]
    :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered. The
  dbos-digitalocean state in R2 may hold such a legacy `params`, so this is
  what the Compute Provider Standard's legacy rule accepts it as."
  "digitalocean")

(def spec
  "How this package describes itself to ONCE's `compute`, the Compute Provider
  Standard's operations over a package-owned registry. The registry and the
  default are the data above; `:sources` names the firewall lists the template
  reads — SSH must list at least one CIDR, an empty HTTP list means no public
  HTTP. The name rules are ONCE's."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]}})

(def retired-keys
  "Keys this package read before it adopted the workspace standards. They are
  accepted and ignored — never refused — so the desired state of a deployment
  created before the adoption keeps validating unchanged.

  - `digitalocean-ssh-key-name`, `digitalocean-ssh-private-key` and
    `digitalocean-ssh-authorized-keys`: the old key model, an account key
    belonging to another deployment looked up by name. Replaced by the SSH
    Keypair Standard: `digitalocean-ssh-keys` (an account key id) opts out,
    its absence means the package generates and owns `~/.ssh/<profile>`.
  - `digitalocean-https-sources`: 443 is now sourced from
    `digitalocean-http-sources`, with 80, as the Compute Provider Standard §5
    has it.
  - `digitalocean-vpc-mode`: there was only ever one value. The regional
    default VPC is discovered at runtime; ONCE's provider checks refuse
    `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` instead."
  [:digitalocean-ssh-key-name :digitalocean-ssh-private-key
   :digitalocean-ssh-authorized-keys :digitalocean-https-sources
   :digitalocean-vpc-mode])

(def required
  "Every key desired state must carry. The provider-scoped keys come from
  `compute-providers`."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :dbos-host :dbos-image :dbos-version :dbos-version-source-url
   :dbos-version-discovered :dbos-node-version :dbos-application-name
   :dbos-data-dir :dbos-durable-delay-seconds :dbos-step-max-attempts
   :dbos-step-initial-retry-seconds :dbos-workflow-retention-days
   :postgres-version :postgres-data-dir :postgres-database
   :dbos-system-database-pool-size :postgres-backup-r2-bucket
   :postgres-backup-r2-endpoint :postgres-backup-r2-region
   :postgres-backup-r2-prefix :postgres-backup-retention-days
   :postgres-backup-oncalendar
   :cloudflare-zone :cloudflare-proxied])

(def application-secrets
  "Credentials Ansible looks up at play time on the host. A delete never runs
  that play — ONCE's remote stage only renders on delete — so these are
  demanded on a real create alone."
  [:dbos-postgres-password
   :postgres-backup-r2-access-key-id :postgres-backup-r2-secret-access-key])

(def profile-par (green-cli/par-name :profile))
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def version-re #"^[0-9]+\.[0-9]+\.[0-9]+$")
(def image-re #"^ghcr\.io/getcolors/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$")

(defn placeholder? [x] (provider-ops/placeholder? x))

(def compute-key
  "`:<provider>-<suffix>`: desired state names compute keys after the
  provider, so the shared steps reach them through the selected provider
  rather than a fixed prefix. ONCE's; named here so `tools` reads the same."
  compute/key)

(def compute-name
  "What this deployment's machine is called: `digitalocean-name` when present,
  else the profile (Compute Name Standard). ONCE's; the droplet, the firewall
  and the `params.name` output derive every label from this one answer."
  compute/name)

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(def cidrs
  "A source list as desired state or an overlay string carries it. ONCE's, so
  the validator and the template can never disagree about what an entry is."
  compute/cidrs)

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set. This package takes profile from colors.yml only.")]))

(defn state-errors
  "Every problem with desired state at once: the missing keys (this package's
  and the selected provider's), the package's own checks, then the Compute
  Provider Standard's — selection, the network contract and the provider
  rules, DigitalOcean's VPC refusals among them — which are ONCE's over
  `spec`. The retired keys are not looked at."
  [opts]
  (vec
   (concat
    (for [k (concat required (compute/required-keys spec opts))
          :when (placeholder? (get opts k))]
      (str k " is required"))
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
               (not (str/includes? (str (:dbos-image opts)) "@sha256:"))
               (not (str/includes? (str (:dbos-image opts)) (str (:dbos-version opts)))))
      [":dbos-image tag must match :dbos-version or use an immutable sha256 digest"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
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
    (compute/state-errors spec opts))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(defn infrastructure-secrets
  "Credentials every real create and delete needs: the selected compute
  provider's, Cloudflare's, and the backend's."
  [opts]
  (concat (compute/secrets spec opts) [:cloudflare-api-token] (backend-secrets opts)))

(defn secret-errors
  "The credentials a real `event` needs. A create needs the application
  secrets Ansible resolves on the host as well; a delete does not, because
  the remote stage only renders on delete."
  ([opts] (secret-errors opts :create))
  ([opts event]
   (let [keys (concat (infrastructure-secrets opts)
                      (when (= :create event) application-secrets))]
     (for [k (distinct keys) :when (placeholder? (get opts k))]
       (str "required credential is not set: " (green-cli/par-name k))))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute (compute/tofu-env spec opts)
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
