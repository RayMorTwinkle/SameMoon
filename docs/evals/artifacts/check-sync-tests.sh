#!/bin/sh
# Project root; npm ci --prefix client first. Same test files for each target.
set -eu
repo=$(git rev-parse --show-toplevel)
target=$(git rev-parse --verify "${1:?target revision required}^{commit}")
fixtures=$(git rev-parse --verify "${2:?test fixture revision required}^{commit}")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/samemoon-tests.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
git -C "$repo" archive "$target" client | tar -x -C "$scratch"
git -C "$repo" archive "$fixtures" client/test | tar -x -C "$scratch"
ln -s "$repo/client/node_modules" "$scratch/client/node_modules"
echo "controller revision $target"
echo "test fixture revision $fixtures"
node --version
npm --prefix "$scratch/client" test -- --reporter=verbose
