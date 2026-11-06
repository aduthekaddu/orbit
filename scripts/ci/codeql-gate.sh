#!/usr/bin/env bash
# Fails when a CodeQL run reports a finding that is not in the list of known findings.
#
#   scripts/ci/codeql-gate.sh <directory with the .sarif files> [known-findings file]
#
# CodeQL results carry no level in this setup, so every result counts. A finding is a rule id, a
# file, and the line hash that CodeQL puts in the result's fingerprint, so a second finding of the
# same rule in the same file is new, and the line hash survives edits elsewhere in the file. A
# result with no fingerprint uses "-". Needs jq.
set -euo pipefail

directory=${1:?usage: codeql-gate.sh <sarif directory> [known findings file]}
known_file=${2:-.github/codeql/known-findings.txt}

found=$(jq --raw-output '.runs[].results[]? | "\(.ruleId) \(.locations[0].physicalLocation.artifactLocation.uri) \(.partialFingerprints.primaryLocationLineHash // "-")"' "$directory"/*.sarif | sort -u)
known=$( (grep -vE '^[[:space:]]*(#|$)' "$known_file" || true) | awk '{print $1 " " $2 " " $3}' | sort -u)

new=$(comm -23 <(printf '%s\n' "$found" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
stale=$(comm -13 <(printf '%s\n' "$found" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))

if [ -n "$stale" ]; then
  while read -r rule file hash; do
    echo "::warning title=Fixed finding still listed::$rule in $file ($hash) is in $known_file but CodeQL no longer reports it. Delete the line."
  done <<< "$stale"
fi
if [ -n "$new" ]; then
  while read -r rule file hash; do
    echo "::error title=New CodeQL finding::$rule in $file (line hash $hash). If it is expected, add \"$rule $file $hash\" to $known_file."
  done <<< "$new"
  exit 1
fi
echo "CodeQL reported $(printf '%s\n' "$found" | sed '/^$/d' | wc -l | tr -d ' ') findings, all known."
