//! File-backed `SecretStore` used as a fallback when the OS keyring is
//! unavailable. In practice this happens on unsigned `tauri dev` builds on
//! macOS: `set_password` silently succeeds but nothing is persisted, so
//! every subsequent `get` returns `NoEntry`. Production (signed) builds get
//! the real Keychain.
//!
//! Secrets are stored as AES-128-CBC-encrypted JSON in
//! `<app_data>/telegram/.secrets.bin` with file mode `0o600`. The encryption
//! key is derived from the machine's hostname — not cryptographically
//! meaningful protection, just enough that the file is not trivially
//! readable if it ends up in a Time Machine backup or a misconfigured
//! cloud-sync folder. Do not use this store for secrets that need to resist
//! a motivated local attacker; it is a *dev-only* fallback.
//!
//! The on-disk format is a fixed 16-byte random IV followed by the
//! ciphertext. The plaintext is a JSON object `{ "accounts": {...} }`.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use super::keyring::SecretStore;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;
type Aes128CbcDec = cbc::Decryptor<Aes128>;

#[derive(Default, Serialize, Deserialize)]
struct Envelope {
    accounts: HashMap<String, String>,
}

pub struct FileSecretStore {
    path: PathBuf,
    key: [u8; 16],
    cache: Mutex<Envelope>,
}

impl FileSecretStore {
    /// `path` must be a full file path (including filename). The parent
    /// directory must already exist or `set` will fail.
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let key = derive_key()?;
        let cache = load_from_disk(&path, &key).unwrap_or_default();
        Ok(Self {
            path,
            key,
            cache: Mutex::new(cache),
        })
    }

    fn persist(&self, env: &Envelope) -> Result<(), String> {
        let json = serde_json::to_vec(env).map_err(|e| format!("envelope serialize: {e}"))?;
        let mut iv = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut iv);
        let cipher = Aes128CbcEnc::new(&self.key.into(), &iv.into());
        let msg_len = json.len();
        let padded_len = ((msg_len / 16) + 1) * 16;
        let mut buf = vec![0u8; padded_len];
        buf[..msg_len].copy_from_slice(&json);
        let ct_slice = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
            .map_err(|e| format!("encrypt: {e}"))?;
        let ciphertext = ct_slice.to_vec();

        let mut out = Vec::with_capacity(iv.len() + ciphertext.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(&ciphertext);

        // Write atomically with 0600 perms: write to .tmp then rename.
        let tmp = self.path.with_extension("bin.tmp");
        {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| format!("open tmp: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
            }
            f.write_all(&out).map_err(|e| format!("write: {e}"))?;
            f.sync_all().map_err(|e| format!("sync: {e}"))?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}

impl SecretStore for FileSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().unwrap();
        cache.accounts.insert(account.to_string(), secret.to_string());
        self.persist(&cache)
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.cache.lock().unwrap().accounts.get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().unwrap();
        if cache.accounts.remove(account).is_some() {
            self.persist(&cache)?;
        }
        Ok(())
    }
}

fn load_from_disk(path: &std::path::Path, key: &[u8; 16]) -> Option<Envelope> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() <= 16 {
        return None;
    }
    let (iv_bytes, cipher) = bytes.split_at(16);
    let mut iv = [0u8; 16];
    iv.copy_from_slice(iv_bytes);
    let mut buf = cipher.to_vec();
    let plain = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    serde_json::from_slice(plain).ok()
}

fn derive_key() -> Result<[u8; 16], String> {
    // Tie the key to this machine so copying the file off the box doesn't
    // yield a decryptable secret on another host.
    let host = hostname();
    let mut key = [0u8; 16];
    pbkdf2::<Hmac<Sha1>>(host.as_bytes(), b"stash-telegram", 1000, &mut key)
        .map_err(|e| format!("pbkdf2: {e}"))?;
    Ok(key)
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-host".to_string())
}

/// Probe whether the OS keyring can round-trip a secret. Used at app setup
/// to decide between `KeyringStore` and `FileSecretStore`. Writes a canary
/// value, reads it back, and cleans up — no leftover entries on success.
pub fn keyring_roundtrip_ok(service: &str) -> bool {
    const CANARY_ACCOUNT: &str = "_stash_probe";
    const CANARY_VALUE: &str = "ok";
    let Ok(entry) = keyring::Entry::new(service, CANARY_ACCOUNT) else {
        return false;
    };
    if entry.set_password(CANARY_VALUE).is_err() {
        return false;
    }
    let ok = matches!(entry.get_password(), Ok(v) if v == CANARY_VALUE);
    // Best-effort cleanup — don't care if delete fails.
    let _ = entry.delete_credential();
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_via_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".secrets.bin");

        let store = FileSecretStore::new(path.clone()).unwrap();
        assert_eq!(store.get("bot_token").unwrap(), None);
        store.set("bot_token", "123:abc").unwrap();
        assert_eq!(store.get("bot_token").unwrap().as_deref(), Some("123:abc"));

        // Fresh store from disk must decrypt and see the value.
        let store2 = FileSecretStore::new(path).unwrap();
        assert_eq!(
            store2.get("bot_token").unwrap().as_deref(),
            Some("123:abc")
        );
    }

    #[test]
    fn delete_is_noop_for_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".secrets.bin");
        let store = FileSecretStore::new(path).unwrap();
        assert!(store.delete("nope").is_ok());
    }

    #[test]
    fn delete_removes_then_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".secrets.bin");

        let store = FileSecretStore::new(path.clone()).unwrap();
        store.set("bot_token", "x").unwrap();
        store.delete("bot_token").unwrap();
        assert_eq!(store.get("bot_token").unwrap(), None);

        let store2 = FileSecretStore::new(path).unwrap();
        assert_eq!(store2.get("bot_token").unwrap(), None);
    }

    #[test]
    fn file_permissions_are_owner_only() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".secrets.bin");
        let store = FileSecretStore::new(path.clone()).unwrap();
        store.set("bot_token", "x").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&path).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "secrets file must be 0600, got {:o}", mode);
        }
    }
}
