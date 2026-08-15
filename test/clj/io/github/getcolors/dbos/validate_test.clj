(ns io.github.getcolors.dbos.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.cli :as green-cli]
            [io.github.getcolors.dbos.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(defn fixture [& {:as overrides}]
  (merge (green-cli/read-state fixture-file (slurp fixture-file)) overrides))

(deftest fixture-is-valid
  (is (= [] (validate/state-errors (fixture)))))

(deftest reports-all-detected-errors
  (let [errs (validate/state-errors
              (assoc (fixture)
                     :dbos-host "bad"
                     :dbos-version "latest"
                     :dbos-durable-delay-seconds 0
                     :dbos-system-database-pool-size 2
                     :digitalocean-vpc-mode "created"
                     :digitalocean-vpc-uuid "hard-coded"
                     :digitalocean-ssh-sources ["bad"] ))
        text (str/join "\n" errs)]
    (is (<= 7 (count errs)))
    (doseq [fragment ["hostname" "exact semantic" "positive integer" "at least 5"
                      "must be default" "must not be configured" "invalid CIDR"]]
      (is (str/includes? text fragment)))))

(deftest exact-official-image-is-required
  (is (some #(str/includes? % "explicit tag")
            (validate/state-errors (assoc (fixture) :dbos-image "ghcr.io/getcolors/dbos"))))
  (is (some #(str/includes? % "must match")
            (validate/state-errors (assoc (fixture) :dbos-image "ghcr.io/getcolors/dbos:4.24.0")))))

(deftest profile-overlay-is-refused
  (is (= "COLORS_PAR_PROFILE" validate/profile-par))
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))

(deftest credentials-are-aggregated
  (let [text (str/join "\n" (validate/secret-errors (fixture)))]
    (doseq [name ["DO_TOKEN" "CLOUDFLARE_API_TOKEN" "DBOS_POSTGRES_PASSWORD"
                  "POSTGRES_BACKUP_R2_ACCESS_KEY_ID" "R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? text name)))))
