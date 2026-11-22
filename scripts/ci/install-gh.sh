#!/usr/bin/env bash
# Install a pinned GitHub CLI release into /usr/local/bin.
# The romper guest image does not ship gh (see docs/ci-runners.md).
set -euo pipefail

VERSION=2.105.0
# From https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_checksums.txt
SHA256=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
ARCHIVE="gh_${VERSION}_linux_amd64.tar.gz"
URL="https://github.com/cli/cli/releases/download/v${VERSION}/${ARCHIVE}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSLo "$tmp/$ARCHIVE" "$URL"
echo "${SHA256}  $tmp/$ARCHIVE" | sha256sum -c -
tar -xzf "$tmp/$ARCHIVE" -C "$tmp"
sudo install -m 0755 "$tmp/gh_${VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh
gh --version
