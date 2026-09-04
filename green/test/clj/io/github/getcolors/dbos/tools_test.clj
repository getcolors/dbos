(ns io.github.getcolors.dbos.tools-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.scaffold :as sc]
            [io.github.getcolors.dbos.tools :as tools]
            [io.github.getcolors.dbos.validate-test :refer [fixture keygen]]))

(def template-source "src/resources/io/github/getcolors/dbos/tools/infrastructure/digitalocean/main.tf")

(defn- render [opts]
  (sc/render-template (tools/compute-template opts) (tools/compute-data opts) tools/template-opts))

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
  (let [source (slurp template-source)]
    (is (str/includes? source "data \"digitalocean_vpc\" \"default\""))
    (is (str/includes? source "region = \"<{ digitalocean-region }>\""))
    (is (str/includes? source "vpc_uuid = data.digitalocean_vpc.default.id"))
    (is (not (str/includes? source "resource \"digitalocean_vpc\"")))))

(deftest the-template-lives-under-the-provider-directory-and-never-branches-on-it
  ;; Compute Provider Standard §3: selection by directory. The only
  ;; conditional the template carries is the keygen branch.
  (is (= :io.github.getcolors.dbos.tools.infrastructure.digitalocean/main.tf
         (tools/compute-template (fixture))))
  (let [source (slurp template-source)]
    (is (not (str/includes? source "provider-compute")))
    (is (str/includes? source "<% if ssh-keygen %>"))))

(deftest the-stage-names-are-onces-and-the-local-one-is-this-packages
  ;; The compute stage name keys the state; renaming it would orphan every
  ;; live tfstate. The local stage is the package's own.
  (is (= "tofu-compute" tools/compute-tool))
  (is (= "tofu-dns" tools/dns-tool))
  (is (= "dbos-ansible-local" tools/ansible-local-tool)))

(deftest keygen-mode-declares-the-key-resource-and-references-it-by-attribute
  (let [main (render (assoc (keygen) :green/event :build))]
    (is (str/includes? main "resource \"digitalocean_ssh_key\" \"machine\""))
    (is (str/includes? main "name       = \"dbos-keygen-fixture\""))
    (is (str/includes? main "ssh_keys = [digitalocean_ssh_key.machine.id]"))
    (is (str/includes? main "ssh_key_id = digitalocean_ssh_key.machine.id"))
    (testing "the remote-exec connection names the generated key"
      (is (str/includes? main "private_key = file(\"")))))

(deftest opt-out-mode-keeps-the-literal-id-and-relies-on-the-agent
  (let [main (render (assoc (fixture) :green/event :build))]
    (is (not (str/includes? main "digitalocean_ssh_key")))
    (is (str/includes? main "ssh_keys = [\"00000000\"]"))
    (is (not (str/includes? main "ssh_key_id")))
    (testing "no private_key: the operator's agent supplies the key"
      (is (not (str/includes? main "private_key"))))
    (testing "the retired key model is gone"
      (is (not (str/includes? main "digitalocean_ssh_key\" \"operator\"")))
      (is (not (str/includes? main "pathexpand"))))))

(deftest the-machine-and-firewall-keep-their-addresses-and-are-named-from-one-value
  (let [main (render (fixture :digitalocean-name "custom"))]
    (is (str/includes? main "resource \"digitalocean_droplet\" \"node1\""))
    (is (str/includes? main "resource \"digitalocean_firewall\" \"node1\""))
    (is (= 3 (count (re-seq #"name\s+= \"custom\"" main))) "droplet, firewall and params.name")
    (is (str/includes? main "name     = \"custom\"\n    user") "params.name is the resolved name")
    (is (str/includes? main "postcondition"))
    (is (str/includes? main "vpc_uuid = data.digitalocean_vpc.default.id"))))

(deftest the-firewall-admits-22-and-http-from-the-two-source-lists
  (let [main (render (fixture))]
    (is (str/includes? main "port_range       = \"22\"\n    source_addresses = [\"129.159.242.163/32\"]"))
    (testing "80 and 443 as one dynamic block guarded on a non-empty list, TCP only"
      (is (str/includes? main "for_each = length([\"0.0.0.0/0\", \"::/0\"]) > 0 ? ["))
      (is (str/includes? main "{ protocol = \"tcp\", port_range = \"80\" }"))
      (is (str/includes? main "{ protocol = \"tcp\", port_range = \"443\" }"))
      (is (not (str/includes? main "udp\", port_range")))
      (is (not (str/includes? main "https-sources"))))
    (testing "an empty list renders no public HTTP rather than an API error"
      (is (str/includes? (render (fixture :digitalocean-http-sources [])) "for_each = length([]) > 0 ? [")))))

(deftest params-carry-the-provider
  (let [main (render (fixture))]
    (is (str/includes? main "provider = \"digitalocean\""))
    (is (str/includes? main "ip       = digitalocean_droplet.node1.ipv4_address"))))

;; --- the bridge to ONCE's stages

(deftest build-bridges-the-documentation-address-to-onces-stages
  ;; A build renders against the fallback params and hands the same map to
  ;; ONCE's dns and remote stages as :once/compute-params -- never the
  ;; pre-standard 192.168.0.1.
  (let [work (str (fs/create-temp-dir {:prefix "dbos-build"}))]
    (try
      (let [r (tools/tofu-compute-step (assoc (fixture) :workdir work :green/event :build))]
        (is (= 0 (:green/exit r)))
        (is (= "192.0.2.10" (:ip r)))
        (is (= {:provider "digitalocean" :ip "192.0.2.10" :user "root" :sudoer "root"
                :name "dbos-fixture"}
               (:once/compute-params r)))
        (is (fs/exists? (fs/path work "dbos-fixture" "tofu-compute" "main.tf"))))
      (finally (fs/delete-tree work)))))

(deftest a-real-converge-refuses-a-missing-ip
  (let [fallback (tools/fallback-params (fixture))]
    (is (= 1 (:green/exit (tools/resolved-compute {} fallback nil))))
    (is (str/includes? (:green/err (tools/resolved-compute {} fallback {:provider "digitalocean"}))
                       "compute produced no ip output; refusing to converge against the documentation address"))
    (let [r (tools/resolved-compute {} fallback {:ip "203.0.113.9" :provider "digitalocean"})]
      (is (= "203.0.113.9" (:ip r)))
      (is (= "root" (:user r))))))

(deftest with-compute-params-sets-the-key-onces-stages-read
  (is (= {:ip "203.0.113.9"} (:once/compute-params (tools/with-compute-params {} {:ip "203.0.113.9"})))))

(deftest compute-credentials-reach-tofu-only-when-set
  (is (nil? (tools/compute-credential-env (fixture))))
  (let [env (tools/compute-credential-env (fixture :do-token "t" :r2-access-key-id "a" :r2-secret-access-key "s"))]
    (is (= "t" (get env "DIGITALOCEAN_TOKEN")))
    (is (= "a" (get env "AWS_ACCESS_KEY_ID")))))
