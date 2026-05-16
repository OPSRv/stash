#!/usr/bin/env bash
#
# setup-updater.sh — one-time generator for the Tauri updater signing keypair.
#
# Why: Tauri's in-app updater plugin verifies every downloaded bundle against
# a public key baked into `tauri.conf.json`. Without a keypair, the plugin
# refuses to install anything (and `tauri build` won't even produce the .sig
# sidecar files release.yml needs to upload). This script generates the pair
# once, patches the config with the public key, and prints exact secret-paste
# instructions for the GitHub repo so CI can sign each release.
#
# Idempotent: re-running with the keys already present just re-prints the
# next-steps block. Add `--force` to regenerate (will OVERWRITE the key —
# any release signed with the old key becomes uninstallable as an update,
# so only force if you know what you're doing).

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_ROOT/src-tauri/tauri.conf.json"
KEY_DIR="$HOME/.tauri"
KEY_PATH="$KEY_DIR/stash.key"
PUB_PATH="$KEY_PATH.pub"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

log()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS only." >&2
  exit 1
fi

# ── 1. Generate keypair (only if missing or --force) ────────────────────────
mkdir -p "$KEY_DIR"
if [[ -f "$KEY_PATH" && "$FORCE" != "1" ]]; then
  ok "Keypair already exists at $KEY_PATH"
else
  if [[ -f "$KEY_PATH" && "$FORCE" == "1" ]]; then
    warn "Overwriting existing keypair (--force)"
  fi
  log "Generating Tauri updater keypair…"
  # `tauri signer generate` is interactive about the password — we pass
  # `--password ''` so this runs unattended. A passwordless key is fine
  # for a single-maintainer project; if you ever want one, regenerate
  # without the flag and add the matching password to GitHub secrets.
  npx --yes @tauri-apps/cli@latest signer generate \
    --write-keys "$KEY_PATH" \
    --password '' \
    --force
  ok "Wrote $KEY_PATH (+ .pub)"
fi

if [[ ! -f "$PUB_PATH" ]]; then
  echo "missing pubkey at $PUB_PATH — re-run with --force" >&2
  exit 1
fi
PUBKEY="$(tr -d '\n' < "$PUB_PATH")"

# ── 2. Patch tauri.conf.json → plugins.updater.pubkey ───────────────────────
if [[ ! -f "$CONF" ]]; then
  warn "$CONF not found — skipping config patch"
else
  CURRENT="$(/usr/bin/python3 -c "
import json, sys
with open('$CONF') as f: cfg = json.load(f)
print((cfg.get('plugins', {}).get('updater', {}) or {}).get('pubkey') or '')
")"

  if [[ "$CURRENT" == "$PUBKEY" ]]; then
    ok "tauri.conf.json already has the matching pubkey"
  else
    log "Patching plugins.updater.pubkey in $CONF"
    /usr/bin/python3 - <<PY
import json, pathlib
p = pathlib.Path("$CONF")
cfg = json.loads(p.read_text())
cfg.setdefault("plugins", {}).setdefault("updater", {})["pubkey"] = "$PUBKEY"
p.write_text(json.dumps(cfg, indent=2) + "\n")
PY
    ok "Patched"
  fi
fi

# ── 3. Print next-steps for CI ──────────────────────────────────────────────
cat <<EOF

\033[1;32m✓ Done.\033[0m

Add these secrets to the GitHub repo (Settings → Secrets and variables →
Actions → New repository secret):

  Name:  TAURI_SIGNING_PRIVATE_KEY
  Value: (paste the verbatim contents of $KEY_PATH —
          tauri-bundler expects the rsign-format text, NOT a re-base64ed copy)

  Name:  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  Value: (leave empty — keypair was generated without a password)

Or with the gh CLI (note the redirection — \`-b\` would base64 it again):

  gh secret set TAURI_SIGNING_PRIVATE_KEY -R OPSRv/stash < $KEY_PATH
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R OPSRv/stash -b ""

Then cut a new tag — release.yml will sign the .app.tar.gz and publish
latest.json alongside it. Existing installs will see the update via
Settings → About → "Check for updates".

\033[1;33mIMPORTANT:\033[0m back up $KEY_PATH somewhere safe (1Password, an
encrypted dotfiles repo, …). If you lose it, every existing install loses
the ability to auto-update — they'll have to re-download the DMG manually,
and any future release signed with a freshly-generated key will be rejected.

EOF