#!/usr/bin/env bash
# Fails when a workflow job does not name a fixed GitHub-hosted runner.
# Usage: fixed-runners.sh [workflow directory]
set -euo pipefail

dir=${1:-.github/workflows}
bad=$(grep -HnE '^[[:space:]]*runs-on:' "$dir"/*.yml | grep -vE 'runs-on: ubuntu-[0-9]+\.[0-9]+$' || true)
if [ -n "$bad" ]; then
  while IFS= read -r line; do
    echo "::error title=Runner::$line Write runs-on as a fixed GitHub-hosted label, such as \"runs-on: ubuntu-24.04\". See docs/adr/0003-ci-on-github-hosted-runners.md."
  done <<< "$bad"
  exit 1
fi
echo "Every job names a fixed GitHub-hosted runner."
