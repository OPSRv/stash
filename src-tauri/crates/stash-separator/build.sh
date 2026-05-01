#!/usr/bin/env bash
# Local build of the stash-separator PyInstaller bundle.
# Produces `dist/stash-separator/` which can be copied to
# `$APPLOCALDATA/separator/bin/` to test against a running Stash.
#
# CI does the same steps (plus codesign + notarize + tar.gz) inside
# `.github/workflows/release.yml` job `build-stash-separator`.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3.11}"
VENV="${VENV:-.venv}"

if [ ! -d "$VENV" ]; then
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

pip install --upgrade pip >/dev/null
pip install -r requirements.txt
pip install 'pyinstaller>=6.6,<7'

rm -rf build dist
pyinstaller --noconfirm --clean stash-separator.spec

echo
echo "Built: $(pwd)/dist/stash-separator"
echo "Copy to: \$APPLOCALDATA/separator/bin/  (or symlink for fast iteration)"
