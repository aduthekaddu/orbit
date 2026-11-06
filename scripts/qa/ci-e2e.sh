#!/usr/bin/env bash
# Runs one verify-orbit suite the way CI does.
#
#   scripts/qa/ci-e2e.sh core     sign up, sign in, and save settings over HTTP
#   scripts/qa/ci-e2e.sh browse   every mock-provider browser scenario, sandbox off
#   scripts/qa/ci-e2e.sh sandbox  every sandbox scenario, sandbox on, with real Docker
#
# Run it after `npm run build`, with nothing listening on 127.0.0.1:3210. The browse and
# sandbox suites find their scenarios by name, so a new scenario runs in CI without an edit.
# Scenarios that need a real provider (`*-real`) are skipped. Every scenario runs even when an
# earlier one fails, and the script exits 1 if any failed.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

suite=${1:-}
scenarios_dir=.agents/skills/verify-orbit/scenarios
failures=()

case $suite in
  core | browse | sandbox) ;;
  *)
    echo "usage: $0 core|browse|sandbox" >&2
    exit 2
    ;;
esac

verify() { node .agents/skills/verify-orbit/verify.mjs "$@"; }

die() {
  failures+=("$*")
  exit 1
}

check() {
  echo "::group::$*"
  if "$@"; then
    echo "::endgroup::"
  else
    echo "::endgroup::"
    echo "::error title=verify-orbit::failed: $*"
    failures+=("$*")
  fi
}

scenario_names() {
  local file
  for file in "$scenarios_dir"/*.mjs; do
    basename "$file" .mjs
  done
}

# Real-provider scenarios, the invalid Docker endpoint (needs its own launch), and the launch
# mode check (needs a sandbox-off server) are run by hand below, not by the generic loops.
is_special() {
  case $1 in
    *-real | sandbox-failure | launch-mode) return 0 ;;
    *) return 1 ;;
  esac
}

is_sandbox() {
  case $1 in
    sandbox | sandbox-* | settings-sandbox) return 0 ;;
    *) return 1 ;;
  esac
}

finish() {
  verify cleanup > /dev/null 2>&1 || true
  if ((${#failures[@]} > 0)); then
    echo
    echo "Failed in the $suite suite:"
    printf '  %s\n' "${failures[@]}"
    exit 1
  fi
  echo "The $suite suite passed."
}
trap finish EXIT

verify cleanup

case $suite in
  core)
    verify launch || die "verify launch"
    verify doctor || die "verify doctor"
    check verify drive signup
    check verify drive signin
    check verify drive settings
    ;;
  browse)
    verify launch --mock || die "verify launch --mock"
    verify doctor || die "verify doctor"
    for name in $(scenario_names); do
      is_special "$name" && continue
      is_sandbox "$name" && [ "$name" != settings-sandbox ] && continue
      check verify browse "$name"
    done
    check verify browse launch-mode
    ;;
  sandbox)
    ORBIT_SANDBOX=on verify launch --mock || die "launch with the sandbox on"
    verify doctor || die "verify doctor"
    for name in $(scenario_names); do
      is_special "$name" && continue
      is_sandbox "$name" || continue
      check verify browse "$name"
    done
    check node scripts/qa/sandbox-fixture-isolation.mjs
    verify cleanup
    ORBIT_SANDBOX=on DOCKER_HOST=tcp://not-the-local-proxy:2375 verify launch --mock || die "launch with an invalid Docker endpoint"
    check verify browse sandbox-failure
    verify cleanup
    if [ -n "$(docker ps -aq --filter label=orbit.sandbox)" ]; then
      echo "::error title=verify-orbit::sandbox containers remain after the suite"
      failures+=("sandbox containers remain")
    fi
    ;;
esac
