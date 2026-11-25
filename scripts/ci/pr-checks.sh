#!/usr/bin/env bash
# Checks a pull request against the rules in CONTRIBUTING.md. It reads the pull request from the
# environment, so a test can feed it any case:
#   TITLE HEAD_REF BODY DRAFT (true or false) LABELS (a JSON array) ACTOR BASE_SHA
# Run it from a checkout where `git diff "$BASE_SHA...HEAD"` shows the pull request's changes.
set -uo pipefail

types='feat|fix|docs|refactor|test|chore|perf|ci'
problems=()
problem() { problems+=("$1"); }

# Bots write their own titles, branches, and descriptions. The author decides, not the branch name.
case "${ACTOR:-}" in
  *"[bot]") echo "A bot's pull request. The checks do not apply."; exit 0 ;;
esac

# The text under "## [Unreleased]" with all whitespace removed.
unreleased() { awk '/^## \[Unreleased\]/ {found = 1; next} /^## \[/ {found = 0} found' | tr -d '[:space:]'; }

title_pattern="^($types)(\\([a-z0-9._/-]+\\))?!?: .+"
if ! [[ $TITLE =~ $title_pattern ]]; then
  problem "The title must start with a type and a colon, such as \"fix: keep stopped runs cancelled\". The types are ${types//|/, }. Squash merge makes the title the commit subject on main."
fi

branch_pattern="^($types)/[a-z0-9]+(-[a-z0-9]+)*$"
if ! [[ $HEAD_REF =~ $branch_pattern ]]; then
  problem "The branch \"$HEAD_REF\" must be named <type>/<kebab-topic>, such as fix/palette-escape. The types are ${types//|/, }."
fi

# A draft is still being written, so the description and changelog checks wait for it to be ready.
if [ "${DRAFT:-false}" != "true" ]; then
  # Windows line endings come from the web editor. Drop the HTML comments from the template, which can span lines and contain ">".
  stripped=$(printf '%s' "${BODY:-}" | tr -d '\r' | awk '
    {
      line = $0
      out = ""
      while (length(line) > 0) {
        if (in_comment) {
          end = index(line, "-->")
          if (end == 0) { line = "" } else { line = substr(line, end + 3); in_comment = 0 }
        } else {
          start = index(line, "<!--")
          if (start == 0) { out = out line; line = "" } else { out = out substr(line, 1, start - 1); line = substr(line, start + 4); in_comment = 1 }
        }
      }
      print out
    }')
  for heading in "## Why" "## What changed" "## Verification"; do
    if ! grep -qxF "$heading" <<< "$stripped"; then
      problem "The description is missing the \"$heading\" section from the pull request template."
    fi
  done
  for heading in "## Why" "## What changed" "## Verification"; do
    section=$(awk -v heading="$heading" '$0 == heading {found = 1; next} /^## / {found = 0} found' <<< "$stripped" | tr -d '[:space:]')
    if grep -qxF "$heading" <<< "$stripped" && [ -z "$section" ]; then
      problem "The \"$heading\" section of the description is empty."
    fi
  done

  type=${TITLE%%[(:!]*}
  case $type in
    feat | fix | perf)
      # GitHub checks out a merge of the pull request into the current base branch, and the first
      # parent of that merge is the base. Comparing with it leaves out what landed on the base after
      # the pull request opened. A checkout that is not a merge compares with BASE_SHA.
      if git rev-parse --verify --quiet "HEAD^2" > /dev/null; then base=$(git rev-parse "HEAD^1"); else base=$BASE_SHA; fi
      changed=$(git diff --name-only "$base" HEAD)
      shipped=$(grep -E '^(src/|drizzle/|searxng/|Dockerfile$|docker-compose.*\.yml$|next\.config\.ts$|package\.json$)' <<< "$changed" || true)
      if [ -n "$shipped" ] && ! jq --exit-status 'index("skip-changelog")' <<< "${LABELS:-[]}" > /dev/null; then
        before=$(git show "$base:CHANGELOG.md" 2> /dev/null | unreleased)
        after=$(git show "HEAD:CHANGELOG.md" 2> /dev/null | unreleased)
        if [ -z "$after" ] || [ "$before" = "$after" ]; then
          problem "A $type pull request that changes shipped code needs a change under \"## [Unreleased]\" in CHANGELOG.md. If nothing changes for a user, add the skip-changelog label."
        fi
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
