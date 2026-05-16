#!/usr/bin/env bash
#
# sign-local.sh — create a stable self-signed codesigning identity for Stash.
#
# Why: ad-hoc / linker-signed bundles get a *new* code-design hash on every
# rebuild, so macOS (TCC, Keychain) treats every release as a fresh app and
# re-prompts for every permission + locks the user out of saved API keys.
# A self-signed cert with a stable Common Name keeps the codesign identity
# constant across builds, so TCC remembers your "yes" to Notifications,
# Accessibility, Reminders, Downloads-folder access, and Keychain entries
# the AI / Telegram modules write through `KeyringStore`.
#
# What this script does (all idempotent):
#   1. Generates an RSA key + X.509 cert with the codeSigning EKU.
#   2. Imports the cert into the login keychain and grants /usr/bin/codesign
#      access without needing to type the keychain password on every build.
#   3. Marks the cert as trusted for codesigning (the only trust dance that
#      makes Gatekeeper accept it locally).
#   4. Patches src-tauri/tauri.conf.json -> bundle.macOS.signingIdentity to
#      the cert's CN, but only if the field is empty (won't clobber a real
#      Developer ID once you upgrade).
#
# It does NOT:
#   * Touch your remote release flow — Apple still won't notarize a
#     self-signed bundle, so this is for local builds only. Set the
#     CI secrets and signingIdentity for distribution separately.
#   * Lower Gatekeeper. The DMG you ship to others still needs Developer ID
#     + notarization. This only fixes the rebuild-on-rebuild prompt storm
#     for *your own* installs of *your own* builds.

set -euo pipefail

CN="${STASH_SIGN_CN:-Stash Self-Signed}"
DAYS="${STASH_SIGN_DAYS:-3650}"
KEYCHAIN="${STASH_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.signing"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!\033[0m %s\n' "$*"; }

# ── 0. Sanity ───────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS only." >&2
  exit 1
fi
for bin in openssl security codesign; do
  command -v "$bin" >/dev/null || { echo "missing dep: $bin" >&2; exit 1; }
done

# ── 1. Skip if identity already exists ──────────────────────────────────────
if security find-identity -v -p codesigning "$KEYCHAIN" | grep -F "\"$CN\"" >/dev/null; then
  ok "Codesign identity \"$CN\" already in $KEYCHAIN"
  EXISTS=1
else
  EXISTS=0
fi

if [[ "$EXISTS" == "0" ]]; then
  # ── 2. Generate key + cert with codeSigning EKU ──────────────────────────
  log "Generating RSA key + self-signed cert (CN=$CN, valid ${DAYS}d)…"
  cat > "$WORK_DIR/openssl.cnf" <<EOF
[req]
distinguished_name = dn
prompt             = no
x509_extensions    = v3_codesign

[dn]
CN = $CN

[v3_codesign]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
EOF

  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$WORK_DIR/key.pem" \
    -out    "$WORK_DIR/cert.pem" \
    -days "$DAYS" \
    -config "$WORK_DIR/openssl.cnf" \
    -extensions v3_codesign \
    2>/dev/null
  ok "Generated cert.pem"

  # Bundle as a .p12 with a throwaway password. Two macOS quirks:
  #   1. `security import` rejects empty-password PKCS12 with "MAC
  #      verification failed" — use a non-empty throwaway password.
  #   2. Homebrew's openssl 3.x writes PKCS12 the system `security` tool
  #      cannot read, even with a password. The system `/usr/bin/openssl`
  #      (LibreSSL) produces a compatible file. Pin the absolute path so
  #      the script works regardless of which openssl is on PATH.
  p12_pass="stash-tmp"
  /usr/bin/openssl pkcs12 -export \
    -inkey "$WORK_DIR/key.pem" \
    -in    "$WORK_DIR/cert.pem" \
    -name  "$CN" \
    -out   "$WORK_DIR/cert.p12" \
    -passout "pass:${p12_pass}"

  # ── 3. Import into login keychain, grant codesign access ─────────────────
  log "Importing into ${KEYCHAIN}…"
  security import "$WORK_DIR/cert.p12" \
    -k "$KEYCHAIN" \
    -P "${p12_pass}" \
    -T /usr/bin/codesign \
    -T /usr/bin/security \
    >/dev/null
  ok "Imported"

  # Best-effort: suppress the "always allow / deny" dialog on first
  # codesign call by extending the key's partition list. Requires the
  # macOS login password, so when this script runs non-interactively
  # (e.g. from an editor agent) the call will fail and we just warn —
  # the next `tauri build` will pop up the keychain dialog once; click
  # "Always Allow" and the key is permanently authorised. Run this
  # script directly in a terminal if you want to skip that dialog.
  log "Trying to grant codesign partition access (skip silently if it"
  log "prompts for your keychain password and you cancel)…"
  if security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -s -k "" "$KEYCHAIN" >/dev/null 2>&1; then
    ok "Partition list updated"
  else
    warn "set-key-partition-list needs your keychain password — first"
    warn "  \`tauri build\` will show a one-time \"Allow\" dialog; pick"
    warn "  \"Always Allow\" and you're set forever."
  fi

  # ── 4. Trust the cert for codesigning ────────────────────────────────────
  # Trust settings are per-cert, and `add-trusted-cert` writes into the
  # admin trust store when `-d` is passed. We stick to the user trust store
  # so the script never needs sudo; that's sufficient for local codesign.
  log "Trusting cert for codesigning (user trust store)…"
  security add-trusted-cert \
    -r trustAsRoot \
    -p codeSign \
    -k "$KEYCHAIN" \
    "$WORK_DIR/cert.pem" >/dev/null 2>&1 || \
    warn "add-trusted-cert returned non-zero — codesign usually still works"
  ok "Trust set"
fi

# ── 5. Write .env.signing (sourced by `npm run tauri:build:signed`) ────────
# Tauri honours `APPLE_SIGNING_IDENTITY` as an override for
# `bundle.macOS.signingIdentity`. We keep the JSON itself untouched so
# CI (no self-signed cert) still produces ad-hoc bundles — only local
# builds opt in by sourcing this gitignored env file.
log "Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Generated by scripts/sign-local.sh — do not commit. Sourced by
# \`npm run tauri:build:signed\`. Holds the local self-signed identity
# so TCC + Keychain see the same signature across rebuilds.
APPLE_SIGNING_IDENTITY="$CN"
EOF
ok "Wrote $ENV_FILE"

# ── 6. Verify ───────────────────────────────────────────────────────────────
log "Available codesign identities:"
security find-identity -v -p codesigning "$KEYCHAIN" | sed 's/^/    /'

cat <<EOF

\033[1;32m✓ Done.\033[0m

Next steps:
  1. Rebuild:    npm run tauri:build:signed
  2. Install the new DMG.
  3. The very first launch will still ask for permissions ONCE — those
     answers now stick across all future rebuilds signed with "$CN".

To wipe TCC state for the app and start clean once:
  tccutil reset All com.opsrv.stash

To remove this self-signed identity later:
  security delete-certificate -c "$CN" "$KEYCHAIN"

EOF
