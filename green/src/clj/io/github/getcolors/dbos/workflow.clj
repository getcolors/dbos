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
            [io.github.getcolors.dbos.ssh :as ssh]
            [io.github.getcolors.dbos.ssh-config :as ssh-config]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-smtp "no-infra"
   :provider-backend "local"
   :workdir ".colors"})

(defn state-output
  "Compute params recorded in the compute state; nil when the state holds
  none. An unreadable backend throws the SDK's step error, which
  `compute/read-state` turns into `{:error message}` — create and delete
  treat the two differently. Kept local so tests can redefine it."
  [opts]
  (some-> (tofu/outputs (tools/tool-dir opts tools/compute-tool)
                        (tools/backend-credential-env opts))
          :params walk/keywordize-keys))

(defn adopt-state
  "A real delete renders ONCE's remote stage and runs the local one before the
  compute destroy, so the machine's address must come out of the existing
  state here. The adoption is ONCE's (`compute/adopt-state`): a readable state
  without compute params leaves :ip unset, an unreadable backend fails loudly
  — swallowing it is how a live teardown once ended up rendering its cleanup
  against a fallback address. No address override. What this package adds is
  the bridge: the adopted params become `:once/compute-params`, which is how
  ONCE's composed stages read the host."
  [opts state]
  (let [adopted (compute/adopt-state opts :delete state)]
    (if (or (wf/failed? adopted) (nil? (:params state)))
      adopted
      (tools/with-compute-params adopted (:params state)))))

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
   ;; The state is read once, up front, on the same defaulted and overlaid
   ;; opts the validators see — the overlay is what carries the backend
   ;; credentials — and only for the two events that touch a provider. The
   ;; validator and the after-validate share the one read.
   (let [overlaid (green-cli/read-pars (merge defaults opts) env)
         context {:event (:green/event overlaid) :real? (lifecycle/real-run? overlaid)}
         state (when (compute/lifecycle-event? context)
                 (compute/read-state overlaid state-output))
         checked
         (lifecycle/preflight
          opts {:defaults defaults :overlay green-cli/read-pars
                :validators
                [(fn [_ env _] (validate/env-errors env))
                 (fn [opts _ _] (validate/state-errors opts))
                 ;; Standard §4 before the credentials: a recorded provider that
                 ;; differs from the selected one reports the actionable error,
                 ;; not a missing token for the provider that was just
                 ;; selected. The thunk carries the event: a delete needs the
                 ;; infrastructure credentials, a create the application's too.
                 (fn [opts _ {:keys [event] :as ctx}]
                   (when (compute/lifecycle-event? ctx)
                     (compute/provider-validator validate/spec opts (:params state)
                                                 #(validate/secret-errors opts event))))
                 (fn [opts _ {:keys [event real?]}]
                   (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                     ["delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]))]
                :after-validate
                ;; The machine key's create matrix and the provider preflight
                ;; run before any template is rendered: an unowned key on disk
                ;; or at the provider stops the run while stopping is still
                ;; free. Delete fills the same template values — a destroy
                ;; renders before it destroys — and adopts the recorded
                ;; address, but checks no key, because its key cleanup runs
                ;; after the compute destroy.
                (fn [opts _ {:keys [event real?]}]
                  (cond
                    (and real? (= :delete event))
                    (adopt-state opts state)

                    (and real? (= :create event))
                    (let [opts (ssh/ensure-key! opts (fn [_] (:params state)))]
                      (if (wf/failed? opts)
                        opts
                        (let [opts (ssh/preflight! (ssh/with-machine-key opts))
                              opts (if (wf/failed? opts) opts (ssh-config/preflight! opts))]
                          (if (wf/failed? opts) opts (assoc opts :green/exit 0)))))

                    :else
                    (assoc (ssh/with-machine-key opts) :green/exit 0)))}
          env)]
     (if (wf/failed? checked)
       checked
       (with-application-shape checked)))))

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
      :dbos/compute [tools/tofu-compute-step :dbos/ssh-cleanup]
      :dbos/ssh-cleanup [ssh/cleanup-step])
    (case step
      :dbos/start [start-step :dbos/compute]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine.
      :dbos/compute [tools/tofu-compute-step :dbos/ssh-config]
      :dbos/ssh-config [tools/ansible-local-step :dbos/dns]
      :dbos/dns [once-tools/tofu-dns-step :dbos/ansible-remote]
      :dbos/ansible-remote [once-tools/ansible-remote-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (or (:profile %) "dbos") "/" tool ".tfstate")}))

(def side-effecting-steps
  [:dbos/compute :dbos/ssh-config :dbos/dns
   :dbos/ansible-remote :dbos/ansible-cleanup :dbos/ssh-cleanup])

(def workflow
  (-> (wf/workflow {:start :dbos/start :wire-fn wire-fn})
      (wf/advice-add :dbos/compute :before ::backend (backend-advice tools/compute-tool))
      (wf/advice-add :dbos/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
