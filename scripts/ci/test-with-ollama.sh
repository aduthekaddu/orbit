#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

image=alpine/ollama:0.40.15@sha256:1792cb2cc1b468826119b176a9679cbaab685ee9bd8296633cdcd203ee6d5528
digest=0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f
container=""
trap 'if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi' EXIT
container=$(docker run --detach --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --cpus 2 --env OLLAMA_NO_CLOUD=1 --publish 127.0.0.1::11434 "$image")
address=$(docker port "$container" 11434/tcp)
[[ "$address" =~ ^127\.0\.0\.1:[0-9]+$ ]]
export ORBIT_OLLAMA_URL="http://$address"
if ! timeout 10s bash -c 'until curl --fail --silent --max-time 1 "$1/api/version" >/dev/null; do sleep 0.1; done' _ "$ORBIT_OLLAMA_URL"; then
  echo "The Ollama test service did not start." >&2
  exit 1
fi

docker exec "$container" ollama pull nomic-embed-text:latest
curl --fail --silent --show-error "$ORBIT_OLLAMA_URL/api/tags" |
  jq --exit-status --arg digest "$digest" 'any(.models[]; .name == "nomic-embed-text:latest" and .digest == $digest)'
timeout 60s npm test -- --require-all
