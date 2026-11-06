#!/usr/bin/env bash
# Scans package-lock.json for known vulnerabilities with OSV-Scanner.
#
#   scripts/ci/osv-gate.sh <base-lockfile>   pull requests: fail only for vulnerabilities this change adds, which
#                                            includes another copy and a dev dependency that becomes a production one
#   scripts/ci/osv-gate.sh                   pushes and schedules: fail for any vulnerability in a
#                                            production dependency, and warn about dev dependencies
#
# Needs Docker and jq. The scan reads the OSV database over the network.
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

image=ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0
base_lockfile=${1:-}

# OSV-Scanner exits 1 when it finds vulnerabilities, which is not an error here. A test can set
# OSV_FIXTURE_DIR to a folder holding head.json and base.json, and the scan reads those instead.
scan() {
  if [ -n "${OSV_FIXTURE_DIR:-}" ]; then
    cat "$OSV_FIXTURE_DIR/$2.json"
    return
  fi
  local directory name
  directory=$(cd "$(dirname "$1")" && pwd)
  name=$(basename "$1")
  docker run --rm --volume "$directory:/scan:ro" "$image" scan source --lockfile "/scan/$name" --format json 2> /dev/null || [ $? -eq 1 ]
}

# One object per vulnerable package and advisory: id, name, version, and whether it is dev only.
flatten() {
  jq '[.results[]?.packages[]?
       | {name: .package.name, version: .package.version, dev: ((.dependency_groups // []) | index("dev") != null)} as $package
       | .vulnerabilities[]?
       | {id: .id, name: $package.name, version: $package.version, dev: $package.dev}]'
}

report() {
  jq --raw-output '.[] | "  \(.id)  \(.name)@\(.version)\(if .dev then "  (dev)" else "" end)"'
}

head_vulnerabilities=$(scan package-lock.json head | flatten)

if [ -n "$base_lockfile" ]; then
  base_vulnerabilities=$(scan "$base_lockfile" base | flatten)
  # Count each advisory per package. It is new when it affects more copies than before, or more
  # production copies, which covers a dev dependency that becomes a production one. A bump from one
  # vulnerable version to another keeps the counts, so it passes.
  added=$(jq --null-input --argjson head "$head_vulnerabilities" --argjson base "$base_vulnerabilities" '
    def tally: group_by([.id, .name]) | map({key: [.[0].id, .[0].name], total: length, production: (map(select(.dev | not)) | length)});
    ($base | tally) as $before
    | [($head | tally)[] | . as $entry
        | (($before | map(select(.key == $entry.key)) | .[0]) // {total: 0, production: 0}) as $old
        | select($entry.total > $old.total or $entry.production > $old.production)
        | $entry.key] as $keys
    | [$head[] | . as $found | select($keys | any(. == [$found.id, $found.name]))]')
  if [ "$(jq length <<< "$added")" -gt 0 ]; then
    echo "::error title=New vulnerabilities::this change adds known vulnerabilities to package-lock.json"
    report <<< "$added"
    exit 1
  fi
  echo "This change adds no known vulnerabilities. $(jq length <<< "$head_vulnerabilities") known in the lockfile, all already on the base."
  exit 0
fi

production=$(jq '[.[] | select(.dev | not)]' <<< "$head_vulnerabilities")
development=$(jq '[.[] | select(.dev)]' <<< "$head_vulnerabilities")
if [ "$(jq length <<< "$development")" -gt 0 ]; then
  echo "::warning title=Dev dependency vulnerabilities::$(jq length <<< "$development") known in dev dependencies"
  report <<< "$development"
fi
if [ "$(jq length <<< "$production")" -gt 0 ]; then
  echo "::error title=Production vulnerabilities::known vulnerabilities in production dependencies"
  report <<< "$production"
  exit 1
fi
echo "No known vulnerabilities in production dependencies."
