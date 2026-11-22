#!/usr/bin/env bash
# The image must not copy nested databases, secrets, env files, build output or agent worktrees.
# This plants marker files at those paths in the checkout, builds a throwaway image from the
# repository root with the repository's .dockerignore, and fails if `COPY . ...` copied any of them.
# It checks right after the copy, because the real Dockerfile deletes /app/data in a later layer
# and an earlier layer still holds what it copied. Run it from the repository root. It needs Docker.
set -euo pipefail

name=context-check
roots=(".claude/worktrees/$name" ".worktrees/$name" "$name" "docs/$name")
markers=(
  ".claude/worktrees/$name/package.json"
  ".claude/worktrees/$name/data/orbit.db"
  ".worktrees/$name/package.json"
  "$name/data/orbit.db"
  "$name/data/auth-secret"
  "$name/.env"
  "$name/.env.local"
  "$name/.verify/sandbox/data/orbit.db"
  "$name/node_modules/pkg/index.js"
  "$name/.next/BUILD_ID"
  "$name/.git"
  "$name/npm-debug.log"
  "docs/$name/data/orbit.db"
  "docs/$name/.env"
)

# Remove only what this script made: the highest folder above each root that did not exist yet.
created=()
for root in "${roots[@]}"; do
  if [ -e "$root" ]; then
    echo "$root already exists. Move it away and run this again." >&2
    exit 1
  fi
  top=$root
  while [ "$(dirname "$top")" != . ] && [ ! -e "$(dirname "$top")" ]; do top=$(dirname "$top"); done
  created+=("$top")
done

tag="orbit-context-check-$$"
work=$(mktemp -d)
cleanup() {
  docker image rm "$tag" > /dev/null 2>&1 || true
  rm -rf -- "${created[@]}" "$work"
}
trap cleanup EXIT

for marker in "${markers[@]}"; do
  mkdir -p "$(dirname "$marker")"
  : > "$marker"
done

# The Dockerfile sits outside the context with no <name>.dockerignore beside it, so Docker reads
# the repository's .dockerignore. It uses the real image's base, so the pull is shared.
base=$(awk 'toupper($1) == "FROM" { print $2; exit }' Dockerfile)
cat > "$work/Dockerfile" << DOCKERFILE
FROM $base
COPY . /context
RUN cd /context \\
  && copied=0 \\
  && for marker in ${markers[*]}; do \\
       if [ -e "\$marker" ]; then echo "copied into the image: \$marker"; copied=1; fi; \\
     done \\
  && if [ ! -f .env.example ]; then echo "left out of the image: .env.example"; copied=1; fi \\
  && test "\$copied" = 0
DOCKERFILE

if ! docker build --no-cache --progress=plain --file "$work/Dockerfile" --tag "$tag" . > "$work/build.log" 2>&1; then
  found=$(sed -nE 's/^#[0-9]+ [0-9.]+ ((copied into|left out of) the image: .*)$/\1/p' "$work/build.log")
  if [ -n "$found" ]; then
    echo "$found" >&2
    echo "FAIL: .dockerignore lets the files above into the image, or leaves .env.example out." >&2
  else
    echo "FAIL: the throwaway build failed. Last lines of its log:" >&2
    tail -n 15 "$work/build.log" >&2
  fi
  exit 1
fi
echo "The build context leaves out all ${#markers[@]} planted files and keeps .env.example."
