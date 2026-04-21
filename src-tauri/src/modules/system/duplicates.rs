use super::cancel;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateGroup {
    pub size_bytes: u64,
    pub hash: String,
    pub paths: Vec<String>,
}

/// Two-pass dedup detection: (1) group by size, (2) hash only groups with
/// ≥2 entries. Hashing dominates the cost — skipping singletons makes the
/// scan roughly N·log(N) IO instead of N·log(N)·hash.
pub fn find(root: &Path, min_bytes: u64) -> Vec<DuplicateGroup> {
    cancel::reset("duplicates");
    // Pass 1: collect (path, size) for every regular file above threshold.
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for ent in WalkDir::new(root).follow_links(false).into_iter().flatten() {
        if cancel::is_cancelled("duplicates") {
            return Vec::new();
        }
        if !ent.file_type().is_file() {
            continue;
        }
        let size = match ent.metadata() {
            Ok(m) => m.len(),
            Err(_) => continue,
        };
        if size < min_bytes {
            continue;
        }
        by_size
            .entry(size)
            .or_default()
            .push(ent.path().to_string_lossy().into_owned());
    }

    // Pass 2: hash only within same-size groups.
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (size, paths) in by_size {
        if paths.len() < 2 {
            continue;
        }
        if cancel::is_cancelled("duplicates") {
            break;
        }
        let mut by_hash: HashMap<String, Vec<String>> = HashMap::new();
        for p in paths {
            if cancel::is_cancelled("duplicates") {
                break;
            }
            if let Some(h) = hash_file(&p) {
                by_hash.entry(h).or_default().push(p);
            }
        }
        for (h, ps) in by_hash {
            if ps.len() >= 2 {
                groups.push(DuplicateGroup {
                    size_bytes: size,
                    hash: h,
                    paths: ps,
                });
            }
        }
    }
    groups.sort_by(|a, b| {
        (b.size_bytes * b.paths.len() as u64).cmp(&(a.size_bytes * a.paths.len() as u64))
    });
    groups
}

fn hash_file(path: &str) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn find_detects_identical_files_across_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a")).unwrap();
        fs::create_dir_all(tmp.path().join("b")).unwrap();
        let body = vec![42u8; 4096];
        fs::write(tmp.path().join("a/x.bin"), &body).unwrap();
        fs::write(tmp.path().join("b/y.bin"), &body).unwrap();
        fs::write(tmp.path().join("unique.bin"), vec![7u8; 4096]).unwrap();

        let groups = find(tmp.path(), 1024);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].paths.len(), 2);
        assert_eq!(groups[0].size_bytes, 4096);
    }
}
