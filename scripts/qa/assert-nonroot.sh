#!/usr/bin/env bash
# The Orbit server process must not be root, however the container starts.
# With an image, this starts it each way a user can and checks every start.
# With --running NAME, it checks one container that is already up.
set -euo pipefail

if [ "${1:-}" = "--running" ] && [ -z "${2:-}" ]; then
  echo "usage: assert-nonroot.sh [--running NAME | IMAGE]" >&2
  exit 2
fi

prefix=orbit-nonroot-$$
containers=()
volumes=()

cleanup() {
  if [ ${#containers[@]} -gt 0 ]; then
    docker rm --force "${containers[@]}" >/dev/null 2>&1 || true
  fi
  if [ ${#volumes[@]} -gt 0 ]; then
    docker volume rm --force "${volumes[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

start() {
  local name=$1
  shift
  containers+=("$name")
  docker run --detach --name "$name" --publish "127.0.0.1::3210" "$@" >/dev/null
}

# The title next-server gives itself is the start of its command line. A
# pattern that can match anywhere also matches the sh -c running this search.
server_uid() {
  local name=$1 attempts=$2 uid="" _
  for _ in $(seq 1 "$attempts"); do
    uid=$(docker exec "$name" sh -c '
      for dir in /proc/[0-9]*; do
        cmd=$(tr "\0" " " < "$dir/cmdline" 2>/dev/null || true)
        case "$cmd" in
          next-server*)
            awk "/^Uid:/ { print \$2; exit }" "$dir/status"
            exit 0
            ;;
        esac
      done
      exit 1
    ' 2>/dev/null || true)
    if [[ $uid =~ ^[0-9]+$ ]]; then
      echo "$uid"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

check_container() {
  local name=$1 attempts=$2 uid pid1_uid login
  if ! uid=$(server_uid "$name" "$attempts"); then
    echo "next-server did not start in $name" >&2
    docker logs "$name" >&2 || true
    return 1
  fi
  pid1_uid=$(docker exec "$name" awk '/^Uid:/ { print $2; exit }' /proc/1/status)
  login=$(docker exec "$name" awk -F: -v uid="$uid" '$3 == uid { print $1; exit }' /etc/passwd)
  echo "pid1_uid=$pid1_uid next_server_uid=$uid next_server_user=${login:-unknown}"
  docker top "$name"
  if ! [[ $pid1_uid =~ ^[0-9]+$ ]] || [ "$pid1_uid" = "0" ] || [ "$uid" = "0" ]; then
    echo "runtime user is root" >&2
    return 1
  fi
  echo "runtime user is not root"
}

setup_responds() {
  local port body
  port=$(docker port "$1" 3210/tcp | head -n1 | sed 's/.*://')
  body=$(curl --fail --silent --show-error --retry 30 --retry-delay 1 --retry-all-errors \
    "http://127.0.0.1:$port/api/setup") || return 1
  grep -q '"signupOpen"' <<<"$body"
}

if [ "${1:-}" = "--running" ]; then
  check_container "$2" 40
  exit
fi

image=${1:-orbit:ci}
volume=$prefix-data

echo "== start as the default user"
start "$prefix-node" "$image"
check_container "$prefix-node" 40 || fail "the default user start runs a root server"
setup_responds "$prefix-node" || fail "the default user start does not answer /api/setup"

echo "== start as root, the way Compose does"
start "$prefix-root" --user 0:0 "$image"
check_container "$prefix-root" 40 || fail "the root start did not drop root before the server"
setup_responds "$prefix-root" || fail "the root start does not answer /api/setup"

echo "== the check rejects a container with no server"
start "$prefix-sleep" --entrypoint sleep "$image" 120
if check_container "$prefix-sleep" 3 >/dev/null 2>&1; then
  fail "the check passed a container that runs no server"
fi

echo "== data volume made by an earlier image that ran as root"
docker volume create "$volume" >/dev/null
volumes+=("$volume")
docker run --rm --user 0:0 --entrypoint sh --volume "$volume:/app/data" "$image" -c \
  'chown root:root /app/data && chmod 700 /app/data && touch /app/data/earlier-run && chmod 600 /app/data/earlier-run'

start "$prefix-plain" --volume "$volume:/app/data" "$image"
code=$(timeout 30 docker wait "$prefix-plain") || fail "docker run kept running with a data directory it cannot use"
[ "$code" != "0" ] || fail "docker run exited 0 with a data directory it cannot use"
docker logs "$prefix-plain" 2>&1 | grep -q -- '--user 0:0' || fail "the error does not say how to repair the volume"
echo "docker run stopped with exit code $code and printed the repair steps"

start "$prefix-repair" --user 0:0 --volume "$volume:/app/data" "$image"
check_container "$prefix-repair" 40 || fail "the root start did not repair the volume"
setup_responds "$prefix-repair" || fail "the repaired volume does not answer /api/setup"
owners=$(docker exec "$prefix-repair" stat -c %u /app/data /app/data/earlier-run | sort -u | tr '\n' ' ')
[ "$owners" = "1000 " ] || fail "the volume is owned by uid(s) $owners, not 1000"
docker rm --force "$prefix-repair" >/dev/null

start "$prefix-again" --volume "$volume:/app/data" "$image"
check_container "$prefix-again" 40 || fail "docker run fails on the repaired volume"
setup_responds "$prefix-again" || fail "docker run on the repaired volume does not answer /api/setup"

echo "all start paths run a non-root server"
