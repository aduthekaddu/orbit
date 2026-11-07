#!/bin/sh
# The server chmods its data directory to 0700, which only the owner can do.
# That directory is ORBIT_DATA_DIR, or /app/data when the variable is unset.
# A fresh bind mount is often owned by root, so fix that here, then drop root
# before the server starts. When the container is already unprivileged, it
# cannot fix ownership, so stop with the repair steps. Otherwise the server
# starts and answers every request with a 500.
set -eu

data_dir=${ORBIT_DATA_DIR:-/app/data}

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$@"
fi

# The server creates a directory that does not exist yet.
if [ -d "$data_dir" ] && ! chmod 700 "$data_dir"; then
  cat >&2 <<EOF
orbit: uid $(id -u) cannot change $data_dir, so the server cannot start. The directory usually belongs to root because an older image ran as root.
To give it to uid 1000, start the container once as root. The entrypoint changes the owner and drops root before the server starts:
  docker run --user 0:0 ...
Or change the owner on the host:
  chown -R $(id -u):$(id -g) <host data directory>
EOF
  exit 1
fi

exec "$@"
