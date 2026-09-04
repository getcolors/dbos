(ns io.github.getcolors.dbos.tools
  (:require [green.ansible :as ansible]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.tools :as once-tools]
            [io.github.getcolors.dbos.ssh-config :as ssh-config]
            [io.github.getcolors.dbos.utils :as utils]
            [io.github.getcolors.dbos.validate :as validate]))

;; The compute and DNS stages keep ONCE's stage names, deliberately. The
;; compute stage's name keys the remote state (`<profile>/tofu-compute.tfstate`
;; through backend-advice) and the DNS stage is what the deployment knows; the
;; Compute Provider Standard constrains the template's source path, not the
;; rendered target. The local stage is this package's own and named after it.
(def compute-tool "tofu-compute")
(def dns-tool "tofu-dns")
(def ansible-local-tool "dbos-ansible-local")
(def root "io.github.getcolors.dbos.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (once-tools/tool-dir opts tool))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn backend-credential-env [opts] (once-tools/backend-credential-env opts))

(defn compute-credential-env
  "The backend's credentials plus the selected compute provider's, from ONCE's
  registry over this package's spec. Unset credentials are omitted, so build
  and dry-run stay credential-free."
  [opts]
  (not-empty
   (into (or (backend-credential-env opts) {})
         (keep (fn [[k env-var]]
                 (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (validate/tofu-env opts :provider-compute))))

(defn app-env [opts]
  [(str "DBOS_POSTGRES_PASSWORD=" (utils/par-lookup :dbos-postgres-password))
   (str "DBOS_APPLICATION_NAME=" (:dbos-application-name opts))
   (str "DBOS_APPLICATION_VERSION=" (:dbos-version opts))
   (str "DBOS_SYSTEM_DATABASE_POOL_SIZE=" (:dbos-system-database-pool-size opts))
   (str "DBOS_DURABLE_DELAY_SECONDS=" (:dbos-durable-delay-seconds opts))
   (str "DBOS_STEP_MAX_ATTEMPTS=" (:dbos-step-max-attempts opts))
   (str "DBOS_STEP_INITIAL_RETRY_SECONDS=" (:dbos-step-initial-retry-seconds opts))
   (str "DBOS_WORKFLOW_RETENTION_DAYS=" (:dbos-workflow-retention-days opts))
   (str "POSTGRES_DB=" (:postgres-database opts))
   "POSTGRES_USER=dbos"
   (str "POSTGRES_PASSWORD=" (utils/par-lookup :dbos-postgres-password))
   (str "BACKUP_R2_BUCKET=" (:postgres-backup-r2-bucket opts))
   (str "BACKUP_R2_ENDPOINT=" (:postgres-backup-r2-endpoint opts))
   (str "BACKUP_R2_REGION=" (:postgres-backup-r2-region opts))
   (str "BACKUP_R2_PREFIX=" (:postgres-backup-r2-prefix opts))
   (str "BACKUP_RETENTION_DAYS=" (:postgres-backup-retention-days opts))
   (str "BACKUP_ONCALENDAR=" (:postgres-backup-oncalendar opts))
   (str "BACKUP_R2_ACCESS_KEY_ID=" (utils/par-lookup :postgres-backup-r2-access-key-id))
   (str "BACKUP_R2_SECRET_ACCESS_KEY=" (utils/par-lookup :postgres-backup-r2-secret-access-key))])

(defn with-once-shape [opts]
  (assoc opts :once {:applications [{:host (:dbos-host opts)
                                     :image (:dbos-image opts)
                                     :env (app-env opts)}]}))

;; ---------------------------------------------------------------- compute

(def fallback-params
  "What `build` and `--dry-run` render in place of a compute output: the
  documentation address, shaped like the real `params` so every later stage
  sees the same keys either way. ONCE's."
  compute/fallback-params)

(def resolved-compute
  "Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute
  output carries no `ip`. ONCE's; `tofu-compute-step` is what wires it."
  compute/resolved-compute)

(defn with-compute-params
  "The bridge to ONCE's composed stages. `once-tools/tofu-dns-step` and
  `once-tools/ansible-remote-step` read the machine's address, user and name
  as `:once/compute-params`, the key ONCE's own compute step sets; this
  package's compute step sets it from the same params it merges at top level
  — real, fallback, or, on delete, the ones adopted from state — so the
  ONCE stages keep working unchanged."
  [opts params]
  (assoc opts :once/compute-params params))

(defn compute-data
  "Template values for the compute stage. The name, the keypair mode and the
  source lists are resolved here once, so the template interpolates values
  and never branches on which provider it belongs to."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :compute-name (validate/compute-name opts)
         :ssh-sources-hcl (tofu/hcl-list (validate/cidrs opts (validate/compute-key opts "ssh-sources")))
         :http-sources-hcl (tofu/hcl-list (validate/cidrs opts (validate/compute-key opts "http-sources")))))

(defn compute-template
  "Providers are selected by template directory, `infrastructure/<provider>/`,
  not by conditionals inside one file; the rendered target is the same
  `tofu-compute/main.tf` whichever directory it came from."
  [opts]
  (template (str "infrastructure." (:provider-compute opts)) "main.tf"))

(defn tofu-compute-step [opts]
  (let [dir (tool-dir opts compute-tool)
        specs [(spec (compute-template opts) (str dir "/main.tf") (compute-data opts))]
        result (tofu/tofu-with-spec opts specs {:dir dir :env (compute-credential-env opts)})
        fallback (fallback-params opts)]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (with-compute-params (merge result fallback) fallback)
      (= :delete (:green/event opts)) result
      :else (let [outputs (compute/output-params result)
                  resolved (resolved-compute result fallback outputs)]
              (if (wf/failed? resolved)
                resolved
                (with-compute-params resolved (merge fallback outputs)))))))

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))
