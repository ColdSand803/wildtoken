use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemePack {
    pub id: String,
    pub label: String,
    pub swatch: [String; 2],
    pub css: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub source: &'static str,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ThemeManifest {
    id: String,
    label: String,
    name: String,
    css: String,
    swatch: Vec<String>,
    version: Option<String>,
    description: Option<String>,
}

pub async fn list_theme_packs(root: impl AsRef<Path>) -> std::io::Result<Vec<ThemePack>> {
    let root = root.as_ref();
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };

    let mut packs = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }

        let dir_name = entry.file_name();
        let Some(dir_name) = dir_name.to_str() else {
            continue;
        };
        let manifest_path = entry.path().join("theme.json");
        match read_theme_manifest(root, dir_name, &manifest_path).await {
            Ok(Some(pack)) => packs.push(pack),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    path = %manifest_path.display(),
                    error = %error,
                    "skipping invalid theme pack"
                );
            }
        }
    }

    packs.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
    Ok(packs)
}

async fn read_theme_manifest(
    root: &Path,
    dir_name: &str,
    manifest_path: &Path,
) -> Result<Option<ThemePack>, String> {
    let text = match tokio::fs::read_to_string(manifest_path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let manifest: ThemeManifest = serde_json::from_str(&text).map_err(|error| error.to_string())?;

    let id = manifest.id.trim();
    if id != dir_name {
        return Err("manifest id must match its directory name".into());
    }
    if !is_valid_theme_id(id) {
        return Err("theme id must use lowercase letters, numbers, and hyphens".into());
    }

    let css_path = normalize_css_path(&manifest.css)
        .ok_or_else(|| "css must be a relative .css path".to_owned())?;
    let css_file = root.join(id).join(&css_path);
    match tokio::fs::metadata(&css_file).await {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("css path is not a file".into()),
        Err(error) => return Err(format!("css file is not readable: {error}")),
    }

    let label_source = if manifest.label.trim().is_empty() {
        &manifest.name
    } else {
        &manifest.label
    };
    let label = clean_text(label_source, id, 64);
    let description = manifest
        .description
        .as_deref()
        .map(|value| clean_text(value, "", 160))
        .filter(|value| !value.is_empty());

    let version = manifest
        .version
        .as_deref()
        .map(|value| clean_text(value, "", 32))
        .filter(|value| !value.is_empty());

    Ok(Some(ThemePack {
        id: id.to_owned(),
        label,
        swatch: normalize_swatch(&manifest.swatch),
        css: format!("/theme-packs/{id}/{css_path}"),
        version,
        description,
        source: "external",
    }))
}

fn clean_text(value: &str, fallback: &str, max_chars: usize) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn normalize_swatch(values: &[String]) -> [String; 2] {
    [
        values
            .first()
            .filter(|value| is_hex_color(value))
            .cloned()
            .unwrap_or_else(|| "#f8fafc".into()),
        values
            .get(1)
            .filter(|value| is_hex_color(value))
            .cloned()
            .unwrap_or_else(|| "#f97316".into()),
    ]
}

fn is_hex_color(value: &str) -> bool {
    let value = value.trim();
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn is_valid_theme_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 48
        && first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn normalize_css_path(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || !value.ends_with(".css") {
        return None;
    }

    let path = Path::new(value);
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return None;
        }
        parts.push(part);
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{is_valid_theme_id, list_theme_packs, normalize_css_path};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "wildtoken-theme-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp theme root");
        root
    }

    fn write_file(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, text).expect("write test file");
    }

    #[test]
    fn validates_theme_ids() {
        assert!(is_valid_theme_id("soul-society"));
        assert!(is_valid_theme_id("theme2"));
        assert!(!is_valid_theme_id(""));
        assert!(!is_valid_theme_id("Soul"));
        assert!(!is_valid_theme_id("theme_2"));
        assert!(!is_valid_theme_id("2theme"));
        assert!(!is_valid_theme_id("a".repeat(49).as_str()));
    }

    #[test]
    fn normalizes_css_paths_without_traversal() {
        assert_eq!(
            normalize_css_path("theme.css").as_deref(),
            Some("theme.css")
        );
        assert_eq!(
            normalize_css_path("css/theme.v1.css").as_deref(),
            Some("css/theme.v1.css")
        );
        assert_eq!(normalize_css_path("../theme.css"), None);
        assert_eq!(normalize_css_path("/theme.css"), None);
        assert_eq!(normalize_css_path("theme.js"), None);
        assert_eq!(normalize_css_path("theme.css?x=1"), None);
    }

    #[tokio::test]
    async fn missing_theme_root_is_empty() {
        let root = temp_root("missing");
        fs::remove_dir_all(&root).expect("remove temp theme root");

        let packs = list_theme_packs(&root).await.expect("list theme packs");

        assert!(packs.is_empty());
    }

    #[tokio::test]
    async fn lists_valid_theme_packs() {
        let root = temp_root("valid");
        write_file(
            &root.join("soul-society/theme.json"),
            r##"{
              "id": "soul-society",
              "label": "Soul Society",
              "css": "css/theme.css",
              "swatch": ["#111827", "#f97316"],
              "version": "1.0.0",
              "description": "External CSS pack"
            }"##,
        );
        write_file(
            &root.join("soul-society/css/theme.css"),
            r#"html[data-theme="soul-society"] { --accent: #f97316; }"#,
        );

        let packs = list_theme_packs(&root).await.expect("list theme packs");

        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].id, "soul-society");
        assert_eq!(packs[0].label, "Soul Society");
        assert_eq!(packs[0].css, "/theme-packs/soul-society/css/theme.css");
        assert_eq!(packs[0].swatch, ["#111827", "#f97316"]);
        assert_eq!(packs[0].version.as_deref(), Some("1.0.0"));
        assert_eq!(packs[0].source, "external");

        fs::remove_dir_all(root).expect("remove temp theme root");
    }

    #[tokio::test]
    async fn skips_invalid_theme_packs() {
        let root = temp_root("invalid");
        write_file(
            &root.join("bad-id/theme.json"),
            r#"{"id":"Bad","label":"Bad","css":"theme.css"}"#,
        );
        write_file(&root.join("bad-id/theme.css"), "");
        write_file(
            &root.join("traversal/theme.json"),
            r#"{"id":"traversal","label":"Traversal","css":"../theme.css"}"#,
        );
        write_file(&root.join("theme.css"), "");
        write_file(
            &root.join("missing-css/theme.json"),
            r#"{"id":"missing-css","label":"Missing","css":"theme.css"}"#,
        );

        let packs = list_theme_packs(&root).await.expect("list theme packs");

        assert!(packs.is_empty());

        fs::remove_dir_all(root).expect("remove temp theme root");
    }
}
