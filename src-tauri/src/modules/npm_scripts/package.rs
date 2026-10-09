//! Pure `package.json` parsing — no I/O beyond the single file read in
//! `read_project`, so the ordering logic is unit-testable.

use std::fmt;
use std::path::Path;

use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

/// What the tray / Settings need to know about one project folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    /// Script names in `package.json` declaration order.
    pub scripts: Vec<String>,
}

/// Keys of a JSON object in document order. `serde_json` is built without
/// `preserve_order` here (its `Map` is a `BTreeMap`), so instead of flipping
/// that crate-wide feature we walk the object with a visitor and keep the
/// keys as they stream by.
struct OrderedKeys(Vec<String>);

impl<'de> Deserialize<'de> for OrderedKeys {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderedKeys;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedKeys, A::Error> {
                let mut keys = Vec::new();
                while let Some((k, _)) = map.next_entry::<String, IgnoredAny>()? {
                    if !keys.contains(&k) {
                        keys.push(k);
                    }
                }
                Ok(OrderedKeys(keys))
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Deserialize)]
struct PackageJson {
    #[serde(default)]
    name: Option<String>,
    scripts: Option<OrderedKeys>,
}

/// Parse `package.json` text. `folder_name` is the fallback display name
/// when the manifest has no (or an empty) `name`.
pub fn parse_package_json(text: &str, path: &str, folder_name: &str) -> Result<ProjectInfo, String> {
    let pkg: PackageJson =
        serde_json::from_str(text).map_err(|e| format!("package.json is not valid: {e}"))?;
    let scripts = pkg
        .scripts
        .ok_or_else(|| "package.json has no \"scripts\" object".to_string())?
        .0;
    let name = pkg
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder_name.to_string());
    Ok(ProjectInfo {
        path: path.to_string(),
        name,
        scripts,
    })
}

/// Read and parse `<path>/package.json`.
pub fn read_project(path: &str) -> Result<ProjectInfo, String> {
    let dir = Path::new(path.trim());
    if !dir.is_absolute() {
        return Err("path must be absolute".into());
    }
    if !dir.is_dir() {
        return Err("folder not found".into());
    }
    let manifest = dir.join("package.json");
    let text = std::fs::read_to_string(&manifest).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "package.json not found".to_string()
        } else {
            format!("cannot read package.json: {e}")
        }
    })?;
    let folder_name = dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    parse_package_json(&text, &dir.to_string_lossy(), &folder_name)
}

/// POSIX single-quote a word: `it's` → `'it'\''s'`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The command line written into the new terminal tab.
pub fn npm_run_command(script: &str) -> String {
    format!("npm run {}", shell_quote(script))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_script_declaration_order() {
        let text = r#"{"name":"app","scripts":{"zeta":"z","dev":"vite","build":"tsc","alpha":"a"}}"#;
        let p = parse_package_json(text, "/x/app", "app").unwrap();
        assert_eq!(p.scripts, vec!["zeta", "dev", "build", "alpha"]);
        assert_eq!(p.name, "app");
    }

    #[test]
    fn falls_back_to_folder_name() {
        let p = parse_package_json(r#"{"scripts":{}}"#, "/x/proj", "proj").unwrap();
        assert_eq!(p.name, "proj");
        assert!(p.scripts.is_empty());
        let p = parse_package_json(r#"{"name":"  ","scripts":{"a":"b"}}"#, "/x/proj", "proj").unwrap();
        assert_eq!(p.name, "proj");
    }

    #[test]
    fn rejects_missing_or_bad_scripts() {
        assert!(parse_package_json(r#"{"name":"a"}"#, "/a", "a").is_err());
        assert!(parse_package_json(r#"{"scripts":["a"]}"#, "/a", "a").is_err());
        assert!(parse_package_json("not json", "/a", "a").is_err());
    }

    #[test]
    fn quotes_script_names() {
        assert_eq!(npm_run_command("dev"), "npm run 'dev'");
        assert_eq!(npm_run_command("it's"), r"npm run 'it'\''s'");
        assert_eq!(npm_run_command("a; rm -rf ~"), "npm run 'a; rm -rf ~'");
    }
}
