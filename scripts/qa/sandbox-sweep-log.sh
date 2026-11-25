#!/usr/bin/env bash
# Exits 1 when a server log records a sandbox sweep removal for ORBIT_SANDBOX_OWNER.
set -euo pipefail

owner=${ORBIT_SANDBOX_OWNER:-}
if [[ ! $owner =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Set ORBIT_SANDBOX_OWNER to a valid sandbox owner before checking sweep removals." >&2
  exit 2
fi

log=${1:-.verify/server.log}
[ -f "$log" ] || exit 0

if awk '
  { sub(/\r$/, "") }
  index($0, "Sandbox sweep removed a stale container ") &&
  index(" " $0 " ", " owner=" ENVIRON["ORBIT_SANDBOX_OWNER"] " ") {
    print
    found = 1
  }
  END { exit !found }
' "$log"; then
  exit 1
fi
