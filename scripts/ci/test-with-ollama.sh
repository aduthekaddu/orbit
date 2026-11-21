#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

image=alpine/ollama:0.40.15@sha256:1792cb2cc1b468826119b176a9679cbaab685ee9bd8296633cdcd203ee6d5528
model=nomic-embed-text:latest
digest=0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f
base_model=nomic-embed-text:ci-base
threads=2
container=""
trap 'if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi' EXIT
container=$(docker run --detach --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --cpus "$threads" --env OLLAMA_NO_CLOUD=1 --publish 127.0.0.1::11434 "$image")
address=$(docker port "$container" 11434/tcp)
[[ "$address" =~ ^127\.0\.0\.1:[0-9]+$ ]]
export ORBIT_OLLAMA_URL="http://$address"
if ! timeout 10s bash -c 'until curl --fail --silent --max-time 1 "$1/api/version" >/dev/null; do sleep 0.1; done' _ "$ORBIT_OLLAMA_URL"; then
  echo "The Ollama test service did not start." >&2
  exit 1
fi

docker exec "$container" ollama pull "$model"
curl --fail --silent --show-error "$ORBIT_OLLAMA_URL/api/tags" |
  jq --exit-status --arg model "$model" --arg digest "$digest" 'any(.models[]; .name == $model and .digest == $digest)'
weights=$(docker exec "$container" ollama show --modelfile "$model" | awk '/^FROM / { print $2 }')
docker exec "$container" ollama cp "$model" "$base_model"
printf 'FROM %s\nPARAMETER num_thread %s\n' "$base_model" "$threads" |
  docker exec -i "$container" ollama create "$model" --file /dev/stdin
modelfile=$(docker exec "$container" ollama show --modelfile "$model")
actual_weights=$(awk '/^FROM / { print $2 }' <<< "$modelfile")
actual_threads=$(awk '$1 == "PARAMETER" && $2 == "num_thread" { print $3 }' <<< "$modelfile")
if [[ "$weights" != */blobs/sha256-* || "$weights" != "$actual_weights" ]]; then
  echo "The Ollama fixture must use the pinned model weights." >&2
  exit 1
fi
if [[ "$actual_threads" != "$threads" ]]; then
  echo "The Ollama fixture must set num_thread to $threads (got '${actual_threads:-unset}')." >&2
  exit 1
fi
printf 'Ollama fixture uses the pinned weights with %s inference threads.\n' "$actual_threads"
timeout 90s npm test -- --require-all --shuffle
