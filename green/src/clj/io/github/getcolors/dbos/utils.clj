(ns io.github.getcolors.dbos.utils
  (:require [clojure.string :as str]))

(def contract 1)

(defn registrable-domain [host]
  (str/join "." (take-last 2 (str/split (str host) #"\."))))

(defn par-lookup [k]
  (format "{{ lookup('env','COLORS_PAR_%s') }}"
          (-> (name k) (str/replace "-" "_") str/upper-case)))
