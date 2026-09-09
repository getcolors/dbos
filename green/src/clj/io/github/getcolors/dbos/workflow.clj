(ns io.github.getcolors.dbos.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.tools :as once-tools]
            [io.github.getcolors.dbos.machine :as machine]
            [io.github.getcolors.dbos.ssh-config :as ssh-config]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-smtp "no-infra"
   :provider-backend "r2"
   :workdir ".colors"})

(defn- with-application-shape
  "The ONCE application this package deploys, and the SMTP shim: the relay is
  the loopback placeholder and no password is set, so ONCE's `no-infra` SMTP
  provider has nothing to look up."
  [opts]
  (-> (tools/with-once-shape opts)
      (assoc :smtp_server "127.0.0.1"
             :smtp_port 25
             :smtp_username "unused"
             :once/smtp-params {:smtp_server "127.0.0.1"
                                :smtp_port 25
                                :smtp_username "unused"
                                :domains []})))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (let [checked (lifecycle/preflight opts
                   {:defaults defaults :overlay green-cli/read-pars
                    :validators [(fn [_ e _] (validate/env-errors e))
                                 (fn [o _ _] (validate/state-errors o))
                                 (fn [o _ {:keys [event real?]}] (when (and real? (#{:create :delete} event)) (validate/secret-errors o event)))
                                 (fn [o _ {:keys [event real?]}] (when (and real? (= :delete event) (:compute-prevent-destroy o))
                                   ["delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]))]
                    :after-validate (fn [o e {:keys [event real?]}]
                                      (cond (and real? (= :delete event)) (machine/load-inventory o e)
                                            (and real? (= :create event)) (ssh-config/preflight! o)
                                            :else (assoc o :green/exit 0)))} env)]
     (if (wf/failed? checked) checked (with-application-shape checked)))))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :dbos/start [start-step :dbos/ansible-cleanup]
      ;; ONCE's remote stage only renders on delete; it reads the adopted
      ;; address through :once/compute-params.
      :dbos/ansible-cleanup [once-tools/ansible-remote-step :dbos/dns]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its host is stale but harmless; a
      ;; key that predeceases its host locks the operator out of a machine that
      ;; still exists. Both orders are deliberate; see standards/ssh-config.md.
      :dbos/dns [once-tools/tofu-dns-step :dbos/ssh-config]
      :dbos/ssh-config [tools/ansible-local-step :dbos/compute]
      ;; The keypair goes strictly after the compute destroy: a key that
      ;; predeceases its host locks the operator out of a machine that still
      ;; exists (SSH Keypair Standard §3.3).
      :dbos/compute [tools/tofu-compute-step]
      )
    (case step
      :dbos/start [start-step :dbos/compute]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine.
      :dbos/compute [tools/tofu-compute-step :dbos/ssh-config]
      :dbos/ssh-config [tools/ansible-local-step :dbos/dns]
      :dbos/dns [once-tools/tofu-dns-step :dbos/bootstrap]
      :dbos/bootstrap [tools/bootstrap-step :dbos/ansible-remote]
      :dbos/ansible-remote [once-tools/ansible-remote-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (or (:profile %) "dbos") "/" tool ".tfstate")}))

(def side-effecting-steps
  [:dbos/compute :dbos/ssh-config :dbos/dns
   :dbos/ansible-remote :dbos/ansible-cleanup :dbos/bootstrap])

(defn next-fn [_ successors opts]
  (if (or (wf/failed? opts) (true? (:colors-compute/already-destroyed opts)))
    [] (mapv #(vector % opts) successors)))

(def workflow
  (-> (wf/workflow {:start :dbos/start :wire-fn wire-fn :next-fn next-fn})
      (wf/advice-add :dbos/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
