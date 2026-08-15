(ns io.github.getcolors.dbos.tools
  (:require [clojure.walk :as walk]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.tools :as once-tools]
            [io.github.getcolors.dbos.utils :as utils]))

(def compute-tool "tofu-compute")
(def dns-tool "tofu-dns")

(defn tool-dir [opts tool] (once-tools/tool-dir opts tool))
(defn backend-credential-env [opts] (once-tools/backend-credential-env opts))

(defn app-env [opts]
  [(str "DBOS_SYSTEM_DATABASE_URL=postgresql://dbos:"
        (utils/par-lookup :dbos-postgres-password)
        "@127.0.0.1:5432/" (:postgres-database opts))
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

(defn- output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

(defn tofu-compute-step [opts]
  (let [dir (tool-dir opts compute-tool)
        data (assoc opts
                    :digitalocean-ssh-sources-hcl (tofu/hcl-list (:digitalocean-ssh-sources opts))
                    :digitalocean-http-sources-hcl (tofu/hcl-list (:digitalocean-http-sources opts))
                    :digitalocean-https-sources-hcl (tofu/hcl-list (:digitalocean-https-sources opts)))
        specs [{:template :io.github.getcolors.dbos.tofu-compute/main.tf
                :target (str dir "/main.tf")
                :data data
                :opts sc/preserve-jinja-delimiters}]
        env (cond-> (backend-credential-env opts)
              (:do-token opts) (assoc "DIGITALOCEAN_TOKEN" (:do-token opts)))
        result (tofu/tofu-with-spec opts specs {:dir dir :env env})
        fallback {:ip "192.168.0.1" :sudoer "root" :name (:profile opts) :user "root"}]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (assoc result :once/compute-params fallback)
      (= :delete (:green/event opts)) result
      :else (assoc result :once/compute-params (merge fallback (or (output-params result) {}))))))
