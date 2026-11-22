#!/usr/bin/env bash
# Model-checks every TLC config in docs/architecture.
# NAME.cfg and NAME.anything.cfg check NAME.tla. A config with the line
#   \* Expect: <Invariant> fails after <Action>, <Action>, ...
# is a mutant: it passes only when TLC breaks that invariant on exactly that trace.
set -euo pipefail
cd "$(dirname "$0")/../.."

version=1.7.4
jar_sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jre=eclipse-temurin:21.0.12.1_1-jre-noble@sha256:cd35bb33859641c5374415826a5951845104093eaa401cbe9d3d9023444f1c13
models=docs/architecture
cache=${XDG_CACHE_HOME:-$HOME/.cache}/orbit-tlc-$version
jar=$cache/tla2tools.jar

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

failed=0
for cfg in "$work"/*.cfg; do
  name=$(basename "$cfg")
  module=${name%%.*}
  out="$work/$name.out"
  start=${EPOCHREALTIME/./}
  status=0
  tlc "$name" "$module.tla" > "$out" 2>&1 || status=$?
  tenths=$(( (${EPOCHREALTIME/./} - start) / 100000 ))
  took="$((tenths / 10)).$((tenths % 10))s"
  states=$(awk '{ for (i = 2; i <= NF; i++) if ($i == "distinct") n = $(i - 1) } END { print n }' "$out")
  expect=$(sed -nE 's/^\\\* Expect: ([A-Za-z0-9_]+) fails after (.+)$/\1|\2/p' "$cfg")
  if [[ -z "$expect" ]]; then
    if [[ $status -eq 0 ]] && grep -q "No error has been found" "$out"; then
      echo "$name: pass, ${states:-?} states, $took"
      continue
    fi
    echo "$name: FAIL, TLC exit $status, $took"
  else
    invariant=${expect%%|*}
    want=$(tr -d ' ' <<< "${expect#*|}")
    got=$(awk -F'[<( ]' '/^State [0-9]+: </ && $4 != "Initial" { printf "%s%s", sep, $4; sep = "," }' "$out")
    if grep -q "Invariant $invariant is violated" "$out" && [[ "$got" == "$want" ]]; then
      echo "$name: fails as expected, $invariant after $got, $took"
      continue
    fi
    echo "$name: FAIL, expected $invariant to break after $want; TLC exit $status, trace ${got:-none}, $took"
  fi
  sed 's/^/  /' "$out"
  failed=1
done

for spec in "$models"/*.tla; do
  module=$(basename "$spec" .tla)
  if ! compgen -G "$models/$module.cfg" > /dev/null && ! compgen -G "$models/$module.*.cfg" > /dev/null; then
    echo "$module.tla: FAIL, no $module.cfg checks it"
    failed=1
  fi
done
exit "$failed"
