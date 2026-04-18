use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rusqlite::Connection;
use sha1::Sha1;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

type Aes128CbcDec = cbc::Decryptor<Aes128>;

/// Read Arc's cookie encryption password from macOS Keychain.
fn arc_safe_storage_password() -> Result<String, String> {
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Arc Safe Storage",
            "-a",
            "Arc",
            "-w",
        ])
        .output()
        .map_err(|e| format!("spawn security: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "security exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn derive_key(password: &str) -> Result<[u8; 16], String> {
    let mut key = [0u8; 16];
    pbkdf2::<Hmac<Sha1>>(password.as_bytes(), b"saltysalt", 1003, &mut key)
        .map_err(|e| format!("pbkdf2: {e}"))?;
    Ok(key)
}

fn decrypt_v10(encrypted: &[u8], key: &[u8; 16]) -> Option<Vec<u8>> {
    if encrypted.len() < 3 || !encrypted.starts_with(b"v10") {
        return None;
    }
    let iv = [b' '; 16];
    let mut buf = encrypted[3..].to_vec();
    let plaintext = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    Some(plaintext.to_vec())
}

/// Export Arc's cookies into a Netscape cookies.txt at `out_path`.
/// yt-dlp can then be called with `--cookies <out_path>`.
pub fn export_to_netscape(profile_dir: &Path, out_path: &Path) -> Result<(), String> {
    let password = arc_safe_storage_password()?;
    let key = derive_key(&password)?;
    let cookies_db = profile_dir.join("Cookies");
    if !cookies_db.exists() {
        return Err(format!("Arc cookies db not found at {cookies_db:?}"));
    }

    // Copy the DB to a temp file so we don't lock Arc's live DB while it's
    // running; SQLite still opens the original shared-mode though. Plain
    // copy is safer than opening with immutable=1.
    let tmp_db = std::env::temp_dir().join(format!(
        "stash-arc-cookies-{}.sqlite",
        std::process::id()
    ));
    std::fs::copy(&cookies_db, &tmp_db).map_err(|e| format!("copy db: {e}"))?;

    let conn = Connection::open(&tmp_db).map_err(|e| format!("open db: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT host_key, name, path, expires_utc, is_secure, encrypted_value, value
             FROM cookies",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let host: String = row.get(0)?;
            let name: String = row.get(1)?;
            let path: String = row.get(2)?;
            let expires: i64 = row.get(3)?;
            let secure: i64 = row.get(4)?;
            let encrypted: Vec<u8> = row.get(5)?;
            let plain: String = row.get(6).unwrap_or_default();
            Ok((host, name, path, expires, secure, encrypted, plain))
        })
        .map_err(|e| format!("query: {e}"))?;

    let mut file = std::fs::File::create(out_path).map_err(|e| format!("create out: {e}"))?;
    writeln!(file, "# Netscape HTTP Cookie File").ok();
    writeln!(file, "# Exported by Stash for yt-dlp (Arc profile)").ok();

    let mut exported = 0usize;
    let mut total = 0usize;
    for row in rows.flatten() {
        total += 1;
        let (host, name, path, expires_utc_us, secure, encrypted, plain) = row;
        let value = if !encrypted.is_empty() {
            match decrypt_v10(&encrypted, &key) {
                Some(v) => {
                    // Modern Chromium prefixes the plaintext with a 32-byte
                    // SHA-256 hash of the cookie's host. Strip it before
                    // interpreting the remainder as UTF-8. Fall back to raw
                    // plaintext for rows that predate the hash prefix.
                    let slice: &[u8] = if v.len() > 32 { &v[32..] } else { &v };
                    match std::str::from_utf8(slice) {
                        Ok(s) => s.to_string(),
                        Err(_) => match std::str::from_utf8(&v) {
                            Ok(s) => s.to_string(),
                            Err(_) => continue,
                        },
                    }
                }
                None => {
                    if !plain.is_empty() {
                        plain
                    } else {
                        continue;
                    }
                }
            }
        } else {
            plain
        };

        // Convert WebKit epoch (microseconds since 1601-01-01) to unix seconds.
        let expires = if expires_utc_us > 0 {
            (expires_utc_us / 1_000_000).saturating_sub(11_644_473_600)
        } else {
            0
        };
        let include_subdomains = if host.starts_with('.') { "TRUE" } else { "FALSE" };
        let secure_flag = if secure != 0 { "TRUE" } else { "FALSE" };

        writeln!(
            file,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            host, include_subdomains, path, secure_flag, expires, name, value
        )
        .ok();
        exported += 1;
    }

    let _ = std::fs::remove_file(&tmp_db);
    if exported == 0 {
        return Err(format!("no cookies decrypted from Arc profile (0/{total})"));
    }
    eprintln!("[arc_cookies] exported {exported}/{total} cookies");
    Ok(())
}

/// Convenience: export Arc cookies from the default profile to a stable path
/// inside the app's downloads_dir/bin/arc-cookies.txt.
pub fn export_default(app_data_dir: &Path) -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let profile = home.join("Library/Application Support/Arc/User Data/Default");
    std::fs::create_dir_all(app_data_dir).ok();
    let out = app_data_dir.join("arc-cookies.txt");
    export_to_netscape(&profile, &out)?;
    Ok(out)
}
