(ns io.github.getcolors.dbos.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.dbos.validate-test :refer [fixture keygen]]
            [io.github.getcolors.dbos.workflow :as workflow]))

;; The compute state is read once per run, through `state-output`, on a real
;; create or delete. Every lifecycle test stubs it: nil is a readable state
;; holding no compute, a map is a recorded `params`, and a throw is a backend
;; that cannot be read.
(defn- start [opts state]
  (with-redefs [workflow/state-output (fn [_] state)]
    (workflow/start-step opts {})))

(defn- start-unreadable
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  ([opts] (start-unreadable opts "tofu output failed: no backend"))
  ([opts message]
   (with-redefs [workflow/state-output (fn [_] (throw (ex-info message {:dir "x"})))]
     (workflow/start-step opts {}))))

(def infrastructure-credentials
  {:do-token "d" :cloudflare-api-token "c"
   :r2-access-key-id "a" :r2-secret-access-key "s"})

(def credentials
  (merge infrastructure-credentials
         {:dbos-postgres-password "p"
          :postgres-backup-r2-access-key-id "k" :postgres-backup-r2-secret-access-key "s"}))

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {}))))
  (is (= 0 (:green/exit (workflow/start-step (assoc (keygen) :green/event :build) {})))))

(deftest build-and-dry-run-never-touch-ssh-or-state
  ;; The standard forbids reading, creating, or requiring anything under ~/.ssh
  ;; on a build or dry-run: they render from desired state alone. Nor do they
  ;; read the backend: a throwing state read proves nothing on these paths
  ;; reaches it.
  (doseq [opts [(assoc (keygen) :green/event :build)
                (assoc (keygen) :green/event :create :green/dry-run true)
                (assoc (keygen) :green/event :delete :green/dry-run true)]]
    (let [result (start-unreadable opts)]
      (is (= 0 (:green/exit result)))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder")
          "a build must not name the operator's home directory"))))

(deftest the-application-shape-and-the-smtp-shim-survive-preflight
  (let [r (workflow/start-step (assoc (fixture) :green/event :build) {})]
    (is (= "dbos.example.com" (get-in r [:once :applications 0 :host])))
    (is (= "127.0.0.1" (:smtp_server r)))
    (is (= [] (get-in r [:once/smtp-params :domains])))))

(deftest real-create-reports-all-missing-credentials
  (let [result (start (assoc (fixture) :green/event :create) nil)]
    (is (= 2 (:green/exit result)))
    (doseq [name ["COLORS_PAR_DO_TOKEN" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_DBOS_POSTGRES_PASSWORD" "COLORS_PAR_R2_ACCESS_KEY_ID"]]
      (is (str/includes? (:green/err result) name)))))

(deftest real-delete-requires-the-infrastructure-credentials-only
  ;; Standard §4 puts the credential check on delete too; this package's
  ;; delete never runs the remote play, so the application secrets Ansible
  ;; would resolve are not demanded of it.
  (let [r (start (assoc (fixture) :green/event :delete :compute-prevent-destroy false) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (not (str/includes? (:green/err r) "COLORS_PAR_DBOS_POSTGRES_PASSWORD")))))

(deftest delete-is-protected
  (let [result (start (assoc (fixture) :green/event :delete) nil)]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COMPUTE_PREVENT_DESTROY")))
  (is (= 0 (:green/exit (start (merge (fixture) infrastructure-credentials
                                      {:green/event :delete :compute-prevent-destroy false})
                               nil)))))

;; --- provider switching is a rebuild, never an apply

(deftest a-provider-switch-is-refused-on-create-and-delete
  (doseq [event [:create :delete]]
    (testing (str "DigitalOcean selected, Vultr recorded, on " (name event))
      (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                     {:provider "vultr" :ip "203.0.113.9"})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a vultr machine; set provider-compute back to vultr and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-is-accepted-on-digitalocean
  ;; A state recorded before this package wrote params.provider — the
  ;; dbos-digitalocean state in R2 may be one — is a DigitalOcean machine's:
  ;; accepted, and the run proceeds to the credentials.
  (doseq [event [:create :delete]]
    (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                   {:ip "203.0.113.9"})]
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (not (str/includes? (:green/err r) "no recorded provider")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc (fixture) :green/event :create) {:provider "digitalocean" :ip "203.0.113.9"})]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc (fixture) :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No state stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. Green's SDK shells out
  ;; to tofu in a directory that does not exist and reports that launch
  ;; failure itself as its `tofu output failed:` step error, which ONCE's
  ;; `read-state` counts as an unreadable state, so the create reports its
  ;; credentials instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "dbos-fresh"}))]
    (try
      (let [r (workflow/start-step (assoc (fixture) :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_DO_TOKEN"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(defn deletable-fixture
  "A fixture that passes real-delete preflight: guard lifted, secrets present."
  [& {:as overrides}]
  (merge (fixture :compute-prevent-destroy false) credentials overrides))

(deftest delete-fails-loudly-when-state-is-unreadable
  ;; Swallowing a failed state read is how a live teardown ended up pointing
  ;; a cleanup at a fallback address. The failure must surface here, before
  ;; any stage runs, with the standard's wording.
  (let [r (start-unreadable (deletable-fixture :green/event :delete) "Unauthorized")]
    (is (= 1 (:green/exit r)))
    (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
    (is (str/includes? (:green/err r) "Unauthorized"))))

(deftest delete-with-empty-state-proceeds-without-an-address
  ;; State readable, no compute recorded: the machine is already gone, no
  ;; address is adopted, and the rest of the teardown still runs.
  (let [r (start (deletable-fixture :green/event :delete) nil)]
    (is (= 0 (:green/exit r)))
    (is (nil? (:ip r)))
    (is (nil? (:once/compute-params r)))))

(deftest a-real-delete-adopts-the-recorded-address-into-onces-params
  ;; The bridge: ONCE's remote and dns stages read :once/compute-params, so
  ;; the adopted params land there as well as at top level. Before the
  ;; standard this package's delete read no state at all.
  (let [r (start (deletable-fixture :green/event :delete)
                 {:provider "digitalocean" :ip "203.0.113.9" :user "root" :sudoer "root" :name "dbos-fixture"})]
    (is (= 0 (:green/exit r)))
    (is (= "203.0.113.9" (:ip r)))
    (is (= "203.0.113.9" (get-in r [:once/compute-params :ip])))
    (is (= "digitalocean" (get-in r [:once/compute-params :provider])))))

;; --- the graph

(deftest graph-creates-and-reverses-only-required-stages
  (is (= [:dbos/compute]
         (vec (rest (workflow/wire-fn :dbos/start {:green/event :create})))))
  (is (= [:dbos/ssh-config]
         (vec (rest (workflow/wire-fn :dbos/compute {:green/event :create})))))
  (is (= [:dbos/dns]
         (vec (rest (workflow/wire-fn :dbos/ssh-config {:green/event :create})))))
  (is (= [:dbos/ansible-remote]
         (vec (rest (workflow/wire-fn :dbos/dns {:green/event :create})))))
  (is (empty? (rest (workflow/wire-fn :dbos/ansible-remote {:green/event :create}))))
  (is (= [:dbos/ansible-cleanup]
         (vec (rest (workflow/wire-fn :dbos/start {:green/event :delete})))))
  (is (= [:dbos/dns]
         (vec (rest (workflow/wire-fn :dbos/ansible-cleanup {:green/event :delete}))))))

(deftest delete-removes-the-config-block-before-the-destroy
  ;; The opposite of the keypair below: a block that outlives its host is
  ;; stale but harmless, so removing it early costs nothing.
  (is (= [:dbos/ssh-config]
         (vec (rest (workflow/wire-fn :dbos/dns {:green/event :delete})))))
  (is (= [:dbos/compute]
         (vec (rest (workflow/wire-fn :dbos/ssh-config {:green/event :delete})))))
  (is (some #{:dbos/ssh-config} workflow/side-effecting-steps) "a dry-run never writes ~/.ssh/config"))

(deftest delete-removes-the-key-after-the-compute-destroy
  ;; The ordering is what makes "key present <=> deployment exists" hold: a
  ;; failed destroy never reaches the cleanup step, and correctly leaves the
  ;; key that is still the only credential to whatever survived.
  (is (= [:dbos/ssh-cleanup]
         (vec (rest (workflow/wire-fn :dbos/compute {:green/event :delete})))))
  (is (empty? (rest (workflow/wire-fn :dbos/ssh-cleanup {:green/event :delete}))))
  (is (some #{:dbos/ssh-cleanup} workflow/side-effecting-steps) "a dry-run delete touches no key"))
