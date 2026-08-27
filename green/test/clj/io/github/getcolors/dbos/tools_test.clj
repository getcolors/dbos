(ns io.github.getcolors.dbos.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate-test :refer [fixture]]))

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

(deftest default-vpc-is-rendered-as-runtime-data-source
  (let [source (slurp "src/resources/io/github/getcolors/dbos/tofu-compute/main.tf")]
    (is (str/includes? source "data \"digitalocean_vpc\" \"default\""))
    (is (str/includes? source "region = \"<{ digitalocean-region }>\""))
    (is (str/includes? source "vpc_uuid = data.digitalocean_vpc.default.id"))
    (is (not (str/includes? source "resource \"digitalocean_vpc\"")))))
