#!/usr/bin/env bash
# Checks a pull request against the rules in CONTRIBUTING.md. It reads the pull request from the
# environment, so a test can feed it any case:
#   TITLE HEAD_REF BODY DRAFT (true or false) LABELS (a JSON array) ACTOR BASE_SHA
# Run it from a checkout where `git diff "$BASE_SHA...HEAD"` shows the pull request's changes.
set -uo pipefail

types='feat|fix|docs|refactor|test|chore|perf|ci'
problems=()
problem() { problems+=("$1"); }

# Bots write their own titles, branches, and descriptions.
case "$HEAD_REF" in
  dependabot/* | imgbot) echo "A bot's pull request. The checks do not apply."; exit 0 ;;
esac
case "${ACTOR:-}" in
  *"[bot]") echo "A bot's pull request. The checks do not apply."; exit 0 ;;
esac

title_pattern="^($types)(\\([a-z0-9._/-]+\\))?!?: .+"
if ! [[ $TITLE =~ $title_pattern ]]; then
  problem "The title must start with a type and a colon, such as \"fix: keep stopped runs cancelled\". The types are ${types//|/, }. Squash merge makes the title the commit subject on main."
fi

branch_pattern="^($types)/[a-z0-9][a-z0-9._-]*$"
if ! [[ $HEAD_REF =~ $branch_pattern ]]; then
  problem "The branch \"$HEAD_REF\" must be named <type>/<kebab-topic>, such as fix/palette-escape. The types are ${types//|/, }."
fi

# A draft is still being written, so the description and changelog checks wait for it to be ready.
if [ "${DRAFT:-false}" != "true" ]; then
  stripped=$(printf '%s' "${BODY:-}" | sed -e ':a' -e 's/<!--[^>]*-->//g;/<!--/{N;ba' -e '}')
  for heading in "## Why" "## What changed" "## How I checked it"; do
    if ! grep -qxF "$heading" <<< "$stripped"; then
      problem "The description is missing the \"$heading\" section from the pull request template."
    fi
  done
  for heading in "## Why" "## What changed"; do
    section=$(awk -v heading="$heading" '$0 == heading {found = 1; next} /^## / {found = 0} found' <<< "$stripped" | tr -d '[:space:]')
    if grep -qxF "$heading" <<< "$stripped" && [ -z "$section" ]; then
      problem "The \"$heading\" section of the description is empty."
    fi
  done

  type=${TITLE%%[(:!]*}
  case $type in
    feat | fix | perf)
      changed=$(git diff --name-only "$BASE_SHA...HEAD")
      shipped=$(grep -E '^(src/|drizzle/|Dockerfile$|docker-compose.*\.yml$|next\.config\.ts$|package\.json$)' <<< "$changed" || true)
      if [ -n "$shipped" ] && ! grep -qxF CHANGELOG.md <<< "$changed" && ! jq --exit-status 'index("skip-changelog")' <<< "${LABELS:-[]}" > /dev/null; then
        problem "A $type pull request that changes shipped code needs a line under \"## [Unreleased]\" in CHANGELOG.md. If nothing changes for a user, add the skip-changelog label."
      fi
      ;;
  esac
fi

if ((${#problems[@]} > 0)); then
  for message in "${problems[@]}"; do
    echo "::error title=Pull request::$message"
  done
  exit 1
fi
echo "The pull request follows CONTRIBUTING.md."
