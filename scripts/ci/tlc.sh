#!/usr/bin/env bash
# Model-checks every TLC config in docs/architecture. NAME.cfg and NAME.<label>.cfg check NAME.tla.
# Every config carries exactly one line that says what TLC must find:
#   \* Expect: pass    TLC exits 0, and the config lists every invariant its module defines below
#                      the definition of the config's NEXT operator.
#   \* Expect: fails   a mutant. TLC exits 12, its invariant-violation status, and prints the
#                      counterexample in NAME.<label>.trace, state by state.
# With --update-traces, each mutant's counterexample is written to its .trace file instead.
set -euo pipefail
cd "$(dirname "$0")/../.."

update=false
if [[ $# -gt 0 ]]; then
  [[ $1 == --update-traces && $# -eq 1 ]] || { echo "usage: $0 [--update-traces]" >&2; exit 2; }
  update=true
fi

version=1.7.4
jar_sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jre=eclipse-temurin:21.0.12.1_1-jre-noble@sha256:cd35bb33859641c5374415826a5951845104093eaa401cbe9d3d9023444f1c13
models=docs/architecture
cache=${XDG_CACHE_HOME:-$HOME/.cache}/orbit-tlc-$version
jar=$cache/tla2tools.jar
# tlc2.output.EC.ExitStatus.VIOLATION_SAFETY in this tla2tools.jar: an invariant is violated.
violation_status=12

if ! sha256sum --check --status <<< "$jar_sha256  $jar" 2>/dev/null; then
  mkdir -p "$cache"
  curl --fail --silent --show-error --location --retry 3 --output "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
  sha256sum --check --quiet <<< "$jar_sha256  $jar.part"
  mv "$jar.part" "$jar"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$models"/*.tla "$models"/*.cfg "$work/"

tlc() {
  local args=(-XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -metadir meta -config "$1" "$2")
  if command -v java >/dev/null; then
    (cd "$work" && cp "$jar" tla2tools.jar && java "${args[@]}")
  else
    cp "$jar" "$work/tla2tools.jar"
    docker run --rm --network none --user "$(id -u):$(id -g)" --volume "$work:/models" --workdir /models "$jre" java "${args[@]}"
  fi
}

# The violated invariant and every state of the counterexample, without source locations, so
# the trace stays the same when a line of the model moves.
counterexample() {
  awk '
    /^Error: Invariant .* is violated\.$/ { print; on = 1; next }
    !on || /^Error: The behavior up to this point is:$/ { next }
    /^State [0-9]+: </ {
      sub(/ line [0-9]+, col [0-9]+ to line [0-9]+, col [0-9]+ of module [A-Za-z0-9_]+>$/, "")
      sub(/<Initial predicate>$/, "Initial predicate")
      sub(/: </, ": ")
      print
      next
    }
    /^\/\\ / || /^ / || /^$/ { print; next }
    { exit }
  ' "$1" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
}

# The definitions without parameters below the definition of the NEXT operator.
module_invariants() {
  awk -v next_op="$2" '
    $0 ~ "^" next_op " ==" { below = 1; next }
    below && /^[A-Za-z_][A-Za-z0-9_]* ==/ { print $1 }
  ' "$1"
}

failed=0
fail() {
  echo "$1: FAIL, $2"
  failed=1
}

for cfg in "$work"/*.cfg; do
  name=$(basename "$cfg")
  module=${name%%.*}
  label=${name%.cfg}
  out="$work/$name.out"
  expects=$(grep -c '^\\\* Expect:' "$cfg" || true)
  if [[ $expects -ne 1 ]]; then
    fail "$name" "it has $expects '\\* Expect:' lines and needs exactly one, pass or fails"
    continue
  fi
  expect=$(sed -n 's/^\\\* Expect: //p' "$cfg")
  if [[ $expect != pass && $expect != fails ]]; then
    fail "$name" "its '\\* Expect:' line says '$expect', not pass or fails"
    continue
  fi
  start=${EPOCHREALTIME/./}
  status=0
  tlc "$name" "$module.tla" > "$out" 2>&1 || status=$?
  tenths=$(( (${EPOCHREALTIME/./} - start) / 100000 ))
  took="$((tenths / 10)).$((tenths % 10))s"
  states=$(awk '{ for (i = 2; i <= NF; i++) if ($i == "distinct") n = $(i - 1) } END { print n }' "$out")

  if [[ $expect == pass ]]; then
    if [[ $status -ne 0 ]] || ! grep -q "No error has been found" "$out"; then
      fail "$name" "TLC exit $status, $took"
      sed 's/^/  /' "$out"
      continue
    fi
    next_op=$(sed -nE 's/^NEXT +([A-Za-z0-9_]+) *$/\1/p' "$cfg")
    listed=$(sed -nE 's/^INVARIANT +([A-Za-z0-9_]+) *$/\1/p' "$cfg")
    missing=$(comm -23 <(module_invariants "$work/$module.tla" "$next_op" | sort -u) <(sort -u <<< "$listed") | paste -sd ' ' -)
    if [[ -z $next_op || -n $missing ]]; then
      fail "$name" "it must list every invariant $module.tla defines below NEXT ${next_op:-(no NEXT line)}; missing: ${missing:-none}"
      continue
    fi
    echo "$name: pass, ${states:-?} states, $(wc -w <<< "$listed") invariants, $took"
    continue
  fi

  trace="$models/$label.trace"
  got="$work/$label.trace"
  counterexample "$out" > "$got"
  if [[ $status -ne $violation_status || ! -s $got ]]; then
    fail "$name" "expected TLC exit $violation_status with an invariant violation, got exit $status, $took"
    sed 's/^/  /' "$out"
    continue
  fi
  if $update; then
    cp "$got" "$trace"
    echo "$name: wrote $trace"
    continue
  fi
  if [[ ! -f $trace ]]; then
    fail "$name" "$trace is missing. Run $0 --update-traces and read the trace before you commit it"
    continue
  fi
  if ! diff -u --label "$trace" --label "TLC now" "$trace" "$got" > "$work/$label.diff"; then
    fail "$name" "TLC found a different counterexample, $took"
    sed 's/^/  /' "$work/$label.diff"
    continue
  fi
  echo "$name: fails as expected, $(sed -nE '1s/^Error: Invariant ([A-Za-z0-9_]+) .*/\1/p' "$got") after $(grep -c '^State ' "$got") states, $took"
done

for trace in "$models"/*.trace; do
  [[ -e $trace ]] || continue
  if ! grep -qx '\\\* Expect: fails' "${trace%.trace}.cfg" 2>/dev/null; then
    fail "$(basename "$trace")" "no config with '\\* Expect: fails' uses it"
  fi
done

for spec in "$models"/*.tla; do
  module=$(basename "$spec" .tla)
  if ! compgen -G "$models/$module.cfg" > /dev/null && ! compgen -G "$models/$module.*.cfg" > /dev/null; then
    fail "$module.tla" "no $module.cfg checks it"
  fi
done
exit "$failed"
