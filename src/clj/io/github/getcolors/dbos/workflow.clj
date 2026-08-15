(ns io.github.getcolors.dbos.workflow
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.tools :as once-tools]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute "digitalocean"
   :provider-dns "cloudflare"
   :provider-smtp "no-infra"
   :provider-backend "local"
   :workdir ".colors"})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (let [checked
         (lifecycle/preflight
          opts {:defaults defaults
                :overlay green-cli/read-pars
                :validators
                [(fn [_ env _] (validate/env-errors env))
                 (fn [opts _ _] (validate/state-errors opts))
                 (fn [opts _ {:keys [event real?]}]
                   (when (and real? (= :create event))
                     (validate/secret-errors opts)))
                 (fn [opts _ {:keys [event real?]}]
                   (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                     ["delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]))]}
          env)]
     (if (wf/failed? checked)
       checked
       (-> (tools/with-once-shape checked)
           (assoc :smtp_server "127.0.0.1"
                  :smtp_port 25
                  :smtp_username "unused"
                  :once/smtp-params {:smtp_server "127.0.0.1"
                                     :smtp_port 25
                                     :smtp_username "unused"
                                     :domains []}))))))

(defn ansible-cleanup-step [opts]
  (-> opts once-tools/ansible-local-step once-tools/ansible-remote-step))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :dbos/start [start-step :dbos/ansible-cleanup]
      :dbos/ansible-cleanup [ansible-cleanup-step :dbos/dns]
      :dbos/dns [once-tools/tofu-dns-step :dbos/compute]
      :dbos/compute [tools/tofu-compute-step])
    (case step
      :dbos/start [start-step :dbos/compute :dbos/backup]
      :dbos/compute [tools/tofu-compute-step :dbos/dns]
      :dbos/backup [tools/tofu-backup-step :dbos/dns]
      :dbos/dns [once-tools/tofu-dns-step :dbos/ansible-local :dbos/ansible-remote]
      :dbos/ansible-local [once-tools/ansible-local-step]
      :dbos/ansible-remote [once-tools/ansible-remote-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (or (:profile %) "dbos") "/" tool ".tfstate")}))

(def side-effecting-steps
  [:dbos/compute :dbos/backup :dbos/dns :dbos/ansible-local
   :dbos/ansible-remote :dbos/ansible-cleanup])

(def workflow
  (-> (wf/workflow {:start :dbos/start :wire-fn wire-fn})
      (wf/advice-add :dbos/compute :before ::backend (backend-advice tools/compute-tool))
      (wf/advice-add :dbos/backup :before ::backend (backend-advice tools/backup-tool))
      (wf/advice-add :dbos/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
