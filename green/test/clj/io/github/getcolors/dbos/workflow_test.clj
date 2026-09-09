(ns io.github.getcolors.dbos.workflow-test
  (:require [green.workflow :as wf] [io.github.getcolors.dbos.validate :as validate] [clojure.test :refer [deftest is]]
            [clojure.string :as str]
            [io.github.getcolors.dbos.validate-test :refer [fixture keygen]]
            [io.github.getcolors.dbos.workflow :as workflow]
            [io.github.getcolors.dbos.machine :as machine]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.compute-inspection :as inspection]))

(deftest planning-keeps-app-shape-without-inspection
  (with-redefs [inspection/read-deployment (fn [& _] (throw (ex-info "live read during planning" {})))]
    (doseq [[event dry] [[:build false] [:create true] [:delete true]]]
      (let [result (workflow/start-step (keygen :green/event event :green/dry-run dry) {})]
        (is (= 0 (:green/exit result)))
        (is (= "dbos.example.com" (get-in result [:once :applications 0 :host])))
        (is (= "127.0.0.1" (get-in result [:once/smtp-params :smtp_server])))))))

(deftest credentials-follow-the-event-and-delete-stays-guarded
  (let [create (workflow/start-step (fixture :green/event :create) {})
        delete (workflow/start-step (fixture :green/event :delete) {})]
    (is (= 2 (:green/exit create)))
    (is (str/includes? (:green/err create) "COLORS_PAR_DBOS_POSTGRES_PASSWORD"))
    (is (= 2 (:green/exit delete)))
    (is (str/includes? (:green/err delete) "COMPUTE_PREVENT_DESTROY"))
    (is (not (str/includes? (:green/err delete) "DBOS_POSTGRES_PASSWORD")))))

(deftest recorded-inventory-is-required
  (with-redefs [inspection/read-deployment (fn [_ env] (is (= {"AWS_PROFILE" "fixture"} env)) {:status "absent"})]
    (is (= 1 (:green/exit (machine/load-inventory (fixture :ip "203.0.113.99") {"AWS_PROFILE" "fixture"}))))))

(deftest lifecycle-keeps-bootstrap-and-teardown-order
  (is (= [tools/tofu-compute-step :dbos/ssh-config] (workflow/wire-fn :dbos/compute {:green/event :create})))
  (is (= [:dbos/bootstrap] (vec (rest (workflow/wire-fn :dbos/dns {:green/event :create})))))
  (is (= [tools/bootstrap-step :dbos/ansible-remote] (workflow/wire-fn :dbos/bootstrap {:green/event :create})))
  (is (= [:dbos/compute] (vec (rest (workflow/wire-fn :dbos/ssh-config {:green/event :delete})))))
  (is (= [tools/tofu-compute-step] (workflow/wire-fn :dbos/compute {:green/event :delete})))
  (is (= ["dbos-fixture/tofu-compute.tfstate"] (:legacy_state_keys (machine/requirements (fixture))))))

(deftest retired-keys-do-not-change-key-ownership
  (let [opts (keygen :digitalocean-ssh-authorized-keys "/tmp/retired.pub" :digitalocean-vpc-mode "retired")]
    (is (not (contains? (machine/clean opts) :digitalocean-ssh-authorized-keys)))
    (is (= [] (machine/errors opts)))
    (is (thrown-with-msg? Exception #"inventory unavailable" (machine/fallback-params opts)))))

(deftest repeated-delete-stops-after-validated-inspection
  (let [reads (atom 0) credentials (atom 0)
        dir (str (java.nio.file.Files/createTempDirectory "dbos-repeat-" (make-array java.nio.file.attribute.FileAttribute 0)))
        original (:wire-fn workflow/workflow)]
    (with-redefs [inspection/read-deployment (fn [& _] (swap! reads inc) {:status "destroyed"})
                  validate/state-errors (constantly [])
                  validate/secret-errors (fn [& _] (swap! credentials inc) [])]
      (let [graph (assoc workflow/workflow :wire-fn (fn [step opts] (is (= :dbos/start step)) (original step opts)))
            result (wf/run graph {:green/event :delete :profile "absent-keys" :workdir dir :compute-prevent-destroy false})]
        (is (= 0 (:green/exit result)))
        (is (true? (:colors-compute/already-destroyed result)))
        (is (= 1 @reads)) (is (pos? @credentials))
        (is (empty? (seq (.listFiles (java.io.File. dir)))))
        (is (= 1 (:green/exit (machine/load-inventory {:green/event :create} {}))))))))

(deftest credentials-and-failure-routing-remain
  (with-redefs [inspection/read-deployment (fn [& _] (is false "must not inspect before credentials"))
                validate/state-errors (constantly [])
                validate/secret-errors (constantly ["required credential absent"])]
    (is (not= 0 (:green/exit (workflow/start-step {:green/event :delete :compute-prevent-destroy false} {})))))
  (is (= [] (workflow/next-fn :x [:y] {:green/exit 1})))
  (is (= [[:y {:green/exit 0}]] (workflow/next-fn :x [:y] {:green/exit 0}))))
