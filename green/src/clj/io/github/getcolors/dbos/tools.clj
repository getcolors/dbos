(ns io.github.getcolors.dbos.tools
  (:require [green.ansible :as ansible]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.tools :as once-tools]
            [io.github.getcolors.dbos.ssh-config :as ssh-config]
            [io.github.getcolors.dbos.utils :as utils]
            [io.github.getcolors.dbos.validate :as validate]
            [io.github.getcolors.dbos.machine :as machine]))

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

(def fallback-params machine/fallback-params)
(defn with-compute-params [opts params] (assoc (merge opts params) :once/compute-params params))
(def tofu-compute-step machine/step)

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
                    :ssh_hosts [{:name (:profile opts) :ip (:ip opts) :user (:user opts) :identity_file (:ssh-private-key-path opts)}]
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))


(defn bootstrap-step [opts]
  (let [dir (tool-dir opts "dbos-bootstrap")]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.json" :playbooks {:create "main.yml"} :host-key-checking false}
      [(spec (template "bootstrap" "main.yml") (str dir "/main.yml") opts)
       (sc/content-spec (str dir "/inventory.json") (once-tools/inventory (assoc opts :hosts [(:ip opts)] :users [])))])))
