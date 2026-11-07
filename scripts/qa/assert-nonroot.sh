#!/usr/bin/env bash
# The Orbit server process must not be root. Pass an image to start, or
# --running NAME to check a container that is already up.
set -euo pipefail

running=""
if [ "${1:-}" = "--running" ]; then
  running=${2:-}
  if [ -z "$running" ]; then
    echo "usage: assert-nonroot.sh [--running NAME] [IMAGE]" >&2
    exit 2
  fi
  shift 2
fi

image=${1:-orbit:ci}
name=${running:-orbit-nonroot-check}
started=0

cleanup() {
  if [ "$started" -eq 1 ]; then
    docker rm --force "$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -z "$running" ]; then
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "container $name already exists" >&2
    exit 2
  fi
  docker run --detach --name "$name" --publish "127.0.0.1::3210" "$image" >/dev/null
  started=1
fi

uid_of() {
  docker exec "$name" awk '/^Uid:/ { print $2; exit }' "$1"
}

server_uid=""
for _ in $(seq 1 40); do
  if docker exec "$name" sh -c 'test -r /proc/1/status'; then
    server_uid=$(docker exec "$name" sh -c '
      for dir in /proc/[0-9]*; do
        cmd=$(tr "\0" " " < "$dir/cmdline" 2>/dev/null || true)
        case "$cmd" in
          *next-server*)
            awk "/^Uid:/ { print \$2; exit }" "$dir/status"
            exit 0
            ;;
        esac
      done
      exit 1
    ' || true)
    if [ -n "$server_uid" ]; then
      break
    fi
  fi
  sleep 0.5
done

if [ -z "$server_uid" ]; then
  echo "next-server did not start" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

pid1_uid=$(uid_of /proc/1/status)
login=$(docker exec "$name" awk -F: -v uid="$server_uid" '$3 == uid { print $1; exit }' /etc/passwd)
echo "pid1_uid=$pid1_uid next_server_uid=$server_uid next_server_user=${login:-unknown}"
docker exec --user "$server_uid:$server_uid" "$name" id
docker exec --user "$server_uid:$server_uid" "$name" whoami
docker top "$name"

if [ "$pid1_uid" = "0" ] || [ "$server_uid" = "0" ]; then
  echo "runtime user is root" >&2
  exit 1
fi

echo "runtime user is not root"
