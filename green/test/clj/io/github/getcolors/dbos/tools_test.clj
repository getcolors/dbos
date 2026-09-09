(ns io.github.getcolors.dbos.tools-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.scaffold :as sc]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate-test :refer [fixture keygen]]))

(deftest adapter-builds-production-application
  (let [app (get-in (tools/with-once-shape (fixture)) [:once :applications 0])
        env (str/join "\n" (:env app))]
    (is (= "dbos.example.com" (:host app)))
    (is (= "ghcr.io/getcolors/dbos:4.25.14" (:image app)))
    (is (not (contains? app :github)))
    (is (str/includes? env "DBOS_APPLICATION_VERSION=4.25.14"))
    (is (str/includes? env "DBOS_SYSTEM_DATABASE_POOL_SIZE=10"))
    (is (str/includes? env "COLORS_PAR_DBOS_POSTGRES_PASSWORD"))
    (is (str/includes? env "COLORS_PAR_POSTGRES_BACKUP_R2_ACCESS_KEY_ID"))
    (is (not (str/includes? env "secret-value")))))

(deftest the-stage-names-are-onces-and-the-local-one-is-this-packages
  ;; The compute stage name keys the state; renaming it would orphan every
  ;; live tfstate. The local stage is the package's own.
  (is (= "tofu-compute" tools/compute-tool))
  (is (= "tofu-dns" tools/dns-tool))
  (is (= "dbos-ansible-local" tools/ansible-local-tool)))

(deftest build-bridges-normalized-node
  (let [directory (str (fs/create-temp-dir))]
    (try
      (let [result (tools/tofu-compute-step (assoc (fixture) :workdir directory :green/event :build))]
        (is (= 0 (:green/exit result)))
        (is (= "192.0.2.10" (:ip result)))
        (is (= (:ip result) (get-in result [:once/compute-params :ip])))
        (is (= "0" (get-in result [:once/compute-params :node_id])))
        (is (fs/exists? (str directory "/dbos-fixture/tofu-compute/nodes/0/node-none.tf.json"))))
      (finally (fs/delete-tree directory)))))

(deftest with-compute-params-sets-the-key-onces-stages-read
  (is (= {:ip "203.0.113.9"} (:once/compute-params (tools/with-compute-params {} {:ip "203.0.113.9"})))))

(deftest compute-credentials-reach-tofu-only-when-set
  (is (nil? (tools/compute-credential-env (fixture))))
  (let [env (tools/compute-credential-env (fixture :do-token "t" :r2-access-key-id "a" :r2-secret-access-key "s"))]
    (is (= "t" (get env "DIGITALOCEAN_TOKEN")))
    (is (= "a" (get env "AWS_ACCESS_KEY_ID")))))
