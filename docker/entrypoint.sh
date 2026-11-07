#!/bin/sh
# The server chmods the data directory to 0700, which only the owner can do.
# A fresh bind mount is often owned by root, so fix that here, then drop root
# before the server starts. When the container is already unprivileged, start
# the server as that user.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$@"
fi

exec "$@"
