(require '[cheshire.core :as json] '[io.github.getcolors.dbos.machine :as machine])
(println (json/generate-string (mapv #(machine/params (:opts %) (:result %)) (json/parse-string (slurp (first *command-line-args*)) true))))
