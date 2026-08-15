(ns io.github.getcolors.dbos.workflow-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.dbos.validate-test :refer [fixture]]
            [io.github.getcolors.dbos.workflow :as workflow]))

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))

(deftest real-create-reports-all-missing-credentials
  (let [result (workflow/start-step (assoc (fixture) :green/event :create) {})]
    (is (= 2 (:green/exit result)))
    (doseq [name ["COLORS_PAR_DO_TOKEN" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_DBOS_POSTGRES_PASSWORD" "COLORS_PAR_R2_ACCESS_KEY_ID"]]
      (is (str/includes? (:green/err result) name)))))

(deftest delete-is-protected
  (let [result (workflow/start-step (assoc (fixture) :green/event :delete) {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COMPUTE_PREVENT_DESTROY")))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :delete :compute-prevent-destroy false) {})))))

(deftest graph-creates-and-reverses-only-required-stages
  (is (= [:dbos/compute :dbos/backup]
         (vec (rest (workflow/wire-fn :dbos/start {:green/event :create})))))
  (is (= [:dbos/dns]
         (vec (rest (workflow/wire-fn :dbos/compute {:green/event :create})))))
  (is (= [:dbos/dns]
         (vec (rest (workflow/wire-fn :dbos/backup {:green/event :create})))))
  (is (= [:dbos/ansible-local :dbos/ansible-remote]
         (vec (rest (workflow/wire-fn :dbos/dns {:green/event :create})))))
  (is (= [:dbos/ansible-cleanup]
         (vec (rest (workflow/wire-fn :dbos/start {:green/event :delete})))))
  (is (= [:dbos/compute]
         (vec (rest (workflow/wire-fn :dbos/dns {:green/event :delete}))))))
