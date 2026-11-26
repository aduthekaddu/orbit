#!/usr/bin/env bash
# Runs one verify-orbit suite the way CI does.
#
#   scripts/qa/ci-e2e.sh core     sign up, sign in, and save settings over HTTP
#   scripts/qa/ci-e2e.sh browse   every mock-provider browser scenario, sandbox off
#   scripts/qa/ci-e2e.sh sandbox  every sandbox scenario, sandbox on, with real Docker
#
# Run it after `npm run build`, with ORBIT_VERIFY_PORT free on 127.0.0.1 (default 3210).
# Set ORBIT_VERIFY_PORT=3230 to use another port. The mock providers pick their own free ports,
# so two runs on one host need only different ORBIT_VERIFY_PORT values, each outside the OS's
# automatic port range. The browse and sandbox suites find their scenarios by name, so a new
# scenario runs in CI without an edit.
# Scenarios that need a real provider (`*-real`) are skipped. Every scenario runs even when an
# earlier one fails, and the script exits 1 if any failed.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

export ORBIT_VERIFY_PORT="${ORBIT_VERIFY_PORT:-3210}"
# Every server and fixture this suite starts labels its sandbox containers with this owner, so the
# leftover check at the end sees only this suite's containers.
export ORBIT_SANDBOX_OWNER="${ORBIT_SANDBOX_OWNER:-ci-e2e-$(node -p 'crypto.randomUUID()')}"

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

# `verify cleanup` deletes the server log, and a launch overwrites it. Copy the logs into the
# evidence folder first, so a failed run still has them.
log_count=0
save_logs() {
  local file
  for file in .verify/server.log .verify/mock.log; do
    [ -f "$file" ] || continue
    log_count=$((log_count + 1))
    mkdir -p .verify/evidence/logs
    cp "$file" ".verify/evidence/logs/$log_count-$(basename "$file")"
  done
}
# The mock binds port 0 and prints `mock-ollama port=<n>` as its first stdout line. The coprocess pipe
# carries that line from this child only, and bash sets MOCK_OLLAMA_PID before any trap can run.
start_mock_ollama() {
  mkdir -p .verify
  coproc MOCK_OLLAMA { exec node scripts/qa/mock-ollama.mjs 2> .verify/mock-ollama.log; }
  local line=""
  if ! read -r -t 10 line <&"${MOCK_OLLAMA[0]:-}" || [[ ! $line =~ ^mock-ollama\ port=([0-9]+)$ ]]; then
    echo "mock ollama did not report a port: ${line:-no line}. Log: .verify/mock-ollama.log" >&2
    return 1
  fi
  export ORBIT_OLLAMA_URL="http://127.0.0.1:${BASH_REMATCH[1]}"
}
stop_mock_ollama() {
  local pid=${MOCK_OLLAMA_PID:-}
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup_server() {
  save_logs
  verify cleanup
  stop_mock_ollama
}

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
  cleanup_server > /dev/null 2>&1 || true
  if ((${#failures[@]} > 0)); then
    echo
    echo "Failed in the $suite suite:"
    printf '  %s\n' "${failures[@]}"
    exit 1
  fi
  echo "The $suite suite passed."
}
trap finish EXIT

# verify refuses a bad ORBIT_VERIFY_PORT here, before any mock takes a port.
save_logs
verify cleanup || die "verify cleanup"

case $suite in
  core)
    verify launch || die "verify launch"
    verify doctor || die "verify doctor"
    check verify drive signup
    check verify drive signin
    check verify drive settings
    check node scripts/qa/response-headers.mjs
    ;;
  browse)
    start_mock_ollama || die "mock ollama"
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
    # The sweep removes a container a run leaked once it is a minute old, before the leftover check
    # below can see it. A removal for this suite's owner in this server's log is that leak;
    # removals of another process's stale containers are ignored.
    if ! scripts/qa/sandbox-sweep-log.sh .verify/server.log; then
      echo "::error title=verify-orbit::the sandbox sweep removed a leftover container during the suite"
      failures+=("the sandbox sweep removed a leftover container")
    fi
    cleanup_server
    ORBIT_SANDBOX=on DOCKER_HOST=tcp://not-the-local-proxy:2375 verify launch --mock || die "launch with an invalid Docker endpoint"
    check verify browse sandbox-failure
    cleanup_server
    check node scripts/qa/sandbox-leftovers.mjs
    ;;
esac
