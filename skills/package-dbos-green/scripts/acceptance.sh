#!/usr/bin/env bash
set -euo pipefail
host=${DBOS_ACCEPTANCE_HOST:-bigconfig.space}
base="https://$host"
command -v jq >/dev/null
curl --fail --silent --show-error "$base/health" | jq -e '.status == "ok"' >/dev/null

wait_for_result() {
  local id=$1 deadline=$((SECONDS + 300)) body status
  while (( SECONDS < deadline )); do
    body=$(curl --fail --silent --show-error "$base/workflows/$id")
    status=$(jq -r .status <<<"$body")
    if [[ $status == SUCCESS ]]; then printf '%s\n' "$body"; return 0; fi
    [[ $status != ERROR && $status != RETRIES_EXCEEDED ]] || { printf '%s\n' "$body" >&2; return 1; }
    sleep 2
  done
  echo "workflow $id timed out" >&2; return 1
}

id="acceptance-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
input="deterministic-acceptance"
first=$(curl --fail --silent --show-error -X POST "$base/workflows" -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$id" --arg input "$input" '{workflowID:$id,input:$input,delaySeconds:2}')")
jq -e '.duplicate == false' <<<"$first" >/dev/null
duplicate=$(curl --fail --silent --show-error -X POST "$base/workflows" -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$id" --arg input "$input" '{workflowID:$id,input:$input,delaySeconds:2}')")
jq -e '.duplicate == true' <<<"$duplicate" >/dev/null
completed=$(wait_for_result "$id")
jq -e '.activityAttempts == 2 and .result.activityAttempts == 2' <<<"$completed" >/dev/null
expected=$(printf '%s' "$id:$input" | sha256sum | cut -d' ' -f1)
jq -e --arg expected "$expected" '.result.result == $expected' <<<"$completed" >/dev/null

# Prove recovery across an entire Droplet reboot while DBOS.sleep is pending.
: "${COLORS_PAR_DO_TOKEN:?COLORS_PAR_DO_TOKEN is required for restart acceptance}"
export DIGITALOCEAN_ACCESS_TOKEN=$COLORS_PAR_DO_TOKEN
restart_id="restart-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
curl --fail --silent --show-error -X POST "$base/workflows" -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$restart_id" '{workflowID:$id,input:"restart-recovery",delaySeconds:90}')" >/dev/null
sleep 5
droplet_id=$(doctl compute droplet list --format ID,Name --no-header | awk '$2=="dbos-digitalocean" {print $1}')
[[ -n $droplet_id ]]
doctl compute droplet-action reboot "$droplet_id" --wait >/dev/null
for _ in {1..90}; do curl --fail --silent "$base/health" >/dev/null && break; sleep 5; done
recovered=$(wait_for_result "$restart_id")
jq -e '.status == "SUCCESS" and .activityAttempts == 2 and .result.activityAttempts == 2' <<<"$recovered" >/dev/null
printf 'acceptance: HTTPS, completion, retry, duplicate ID, deterministic result, and reboot recovery passed\n'
