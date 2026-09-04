(ns io.github.getcolors.dbos.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.dbos.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def keygen-file "test/fixtures/keygen.yml")
(defn read-fixture [file overrides]
  (merge (green-cli/read-state file (slurp file)) overrides))
(defn fixture
  "Opt-out mode: an explicit account key id and a name equal to the profile —
  the shape of the live dbos-digitalocean deployment."
  [& {:as overrides}] (read-fixture fixture-file overrides))
(defn keygen
  "Keygen mode: no `digitalocean-ssh-keys`, no `digitalocean-name`."
  [& {:as overrides}] (read-fixture keygen-file overrides))

(deftest fixture-is-valid
  (is (= [] (validate/state-errors (fixture)))))

(deftest keygen-fixture-is-valid
  (is (= [] (validate/state-errors (keygen)))))

;; --- the spec handed to ONCE

(deftest the-spec-carries-this-packages-registry-sources-and-default
  ;; The operations are ONCE's; this is the data they run over. A colour
  ;; whose registry, sources or default drifts fails here, in that colour.
  (is (= #{"digitalocean"} (set (keys (:registry validate/spec)))))
  (is (= validate/compute-providers (:registry validate/spec)))
  (is (= {:required [:digitalocean-region :digitalocean-size :digitalocean-image
                     :digitalocean-ssh-sources :digitalocean-http-sources]
          :secrets [:do-token]
          :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}
         (get-in validate/spec [:registry "digitalocean"])))
  (is (= {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]} (:sources validate/spec)))
  ;; DigitalOcean: the default is what a legacy state without params.provider
  ;; is, and the dbos-digitalocean state in R2 may hold one.
  (is (= "digitalocean" (:default validate/spec)))
  (is (= validate/default-compute-provider (:default validate/spec)))
  (is (not (contains? validate/spec :name-rules)) "the name rules are ONCE's"))

;; --- the compute-provider registry

(deftest compute-provider-must-be-one-the-package-has-a-template-for
  (let [errors (validate/state-errors (fixture :provider-compute "vultr"))]
    (is (some #{":provider-compute must be one of digitalocean"} errors))))

(deftest name-and-machine-key-are-never-required
  ;; `digitalocean-name` is an optional override of the profile and
  ;; `digitalocean-ssh-keys` is meaningful by its absence, so neither may be
  ;; in the registry's required list -- a required machine key would make
  ;; keygen mode unreachable.
  (let [required (set (get-in validate/spec [:registry "digitalocean" :required]))]
    (is (not (contains? required :digitalocean-name)))
    (is (not (contains? required :digitalocean-ssh-keys))))
  (is (= [] (validate/state-errors (dissoc (fixture) :digitalocean-name :digitalocean-ssh-keys)))))

(deftest absent-machine-key-selects-keygen
  (is (true? (validate/keygen? (keygen))))
  (is (false? (validate/keygen? (fixture))))
  (is (true? (validate/keygen? (fixture :digitalocean-ssh-keys nil)))))

(deftest compute-name-falls-back-to-the-profile
  (is (= "dbos-keygen-fixture" (validate/compute-name (keygen))))
  (is (= "dbos-fixture" (validate/compute-name (fixture))))
  (is (= "other" (validate/compute-name (fixture :digitalocean-name "other")))))

(deftest ssh-sources-must-not-be-empty-and-no-public-http-is-fine
  (is (some #{":digitalocean-ssh-sources must list at least one CIDR"}
            (validate/state-errors (fixture :digitalocean-ssh-sources []))))
  (is (= [] (validate/state-errors (fixture :digitalocean-http-sources [])))))

(deftest malformed-sources-are-refused-before-any-provider-call
  (is (some #{":digitalocean-ssh-sources entry \"bad\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (fixture :digitalocean-ssh-sources ["bad"]))))
  (is (some #{":digitalocean-http-sources entry \"10.0.0.0/33\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (fixture :digitalocean-http-sources ["10.0.0.0/33"])))))

(deftest vpc-configuration-is-refused-with-onces-wording
  ;; The package's own combined message is gone; ONCE's two refusals, scoped
  ;; to DigitalOcean, replace it.
  (let [errors (validate/state-errors (fixture :digitalocean-vpc-uuid "u" :digitalocean-vpc-cidr "c"))]
    (is (some #{":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"} errors))
    (is (some #{":digitalocean-vpc-cidr must be absent; this package must not create a VPC"} errors))))

(deftest retired-keys-are-accepted-and-ignored
  ;; Desired state written before the adoption keeps validating: the old key
  ;; model, the separate HTTPS list and the one-valued vpc-mode are neither
  ;; required nor refused, whatever they hold.
  (is (= [:digitalocean-ssh-key-name :digitalocean-ssh-private-key
          :digitalocean-ssh-authorized-keys :digitalocean-https-sources
          :digitalocean-vpc-mode]
         validate/retired-keys))
  (is (= [] (validate/state-errors
             (fixture :digitalocean-ssh-key-name "vaultwarden-digitalocean"
                      :digitalocean-ssh-private-key "~/.ssh/id_ed25519"
                      :digitalocean-ssh-authorized-keys "~/.ssh/id_ed25519.pub"
                      :digitalocean-https-sources ["not-a-cidr"]
                      :digitalocean-vpc-mode "created"))))
  (is (= [] (validate/state-errors (apply dissoc (fixture) validate/retired-keys)))))

;; --- the package's own checks

(deftest reports-all-detected-errors
  (let [errs (validate/state-errors
              (assoc (fixture)
                     :dbos-host "bad"
                     :dbos-version "latest"
                     :dbos-durable-delay-seconds 0
                     :dbos-system-database-pool-size 2
                     :digitalocean-vpc-uuid "hard-coded"
                     :digitalocean-ssh-sources ["bad"]))
        text (str/join "\n" errs)]
    (is (<= 7 (count errs)))
    (doseq [fragment ["hostname" "exact semantic" "positive integer" "at least 5"
                      "must be absent" "is not an IPv4 or IPv6 CIDR"]]
      (is (str/includes? text fragment)))))

(deftest exact-official-image-is-required
  (is (some #(str/includes? % "explicit tag")
            (validate/state-errors (assoc (fixture) :dbos-image "ghcr.io/getcolors/dbos"))))
  (is (some #(str/includes? % "must match")
            (validate/state-errors (assoc (fixture) :dbos-image "ghcr.io/getcolors/dbos:4.24.0"))))
  (is (= [] (validate/state-errors
             (assoc (fixture) :dbos-image
                    "ghcr.io/getcolors/dbos@sha256:e4824320dc6f4f7b542fb364d977b39341ac8dd892e1a30d09ce6a89af3130a6")))))

(deftest profile-overlay-is-refused
  (is (= "COLORS_PAR_PROFILE" validate/profile-par))
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))

(deftest credentials-are-aggregated
  (let [text (str/join "\n" (validate/secret-errors (fixture)))]
    (doseq [name ["DO_TOKEN" "CLOUDFLARE_API_TOKEN" "DBOS_POSTGRES_PASSWORD"
                  "POSTGRES_BACKUP_R2_ACCESS_KEY_ID" "R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? text name)))))

(deftest credentials-follow-the-event
  ;; A delete renders the remote stage and never runs its play, so the
  ;; application secrets Ansible would look up are not demanded of it; the
  ;; infrastructure credentials are, on both events.
  (testing "create"
    (let [text (str/join "\n" (validate/secret-errors (fixture) :create))]
      (is (str/includes? text "COLORS_PAR_DBOS_POSTGRES_PASSWORD"))
      (is (str/includes? text "COLORS_PAR_DO_TOKEN"))))
  (testing "delete"
    (let [text (str/join "\n" (validate/secret-errors (fixture) :delete))]
      (is (not (str/includes? text "COLORS_PAR_DBOS_POSTGRES_PASSWORD")))
      (is (not (str/includes? text "POSTGRES_BACKUP_R2")))
      (doseq [name ["COLORS_PAR_DO_TOKEN" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                    "COLORS_PAR_R2_ACCESS_KEY_ID" "COLORS_PAR_R2_SECRET_ACCESS_KEY"]]
        (is (str/includes? text name))))))

(deftest compute-credentials-and-environment-follow-the-registry
  (is (= {:do-token "DIGITALOCEAN_TOKEN"} (validate/tofu-env (fixture) :provider-compute)))
  (is (= {} (validate/tofu-env (fixture :provider-compute "vultr") :provider-compute))))
