//! 有界技术栈/源文件发现。未完成的扫描不可用于证明全项目覆盖或符号唯一。
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct ProjectStackDetection {
    pub path: String,
    pub lang: String,
    pub marker: String,
}

const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "out",
    "build",
    "vendor",
    "venv",
];
const LANGUAGES: &[&str] = &[
    "typescript",
    "rust",
    "go",
    "python",
    "java",
    "c",
    "csharp",
    "lua",
    "php",
    "ruby",
    "kotlin",
    "swift",
];
const MAX_SCANNED_FILES: usize = 3000;
const MAX_SCAN_DEPTH: usize = 6;
const LANG_DETECT_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectLanguageProfile {
    pub langs: Vec<String>,
    pub extensions: HashSet<String>,
    pub incomplete: bool,
}
static LANG_DETECT_CACHE: OnceLock<Mutex<HashMap<String, (ProjectLanguageProfile, Instant)>>> =
    OnceLock::new();

pub(crate) fn markers_for_lang(lang: &str) -> &'static [&'static str] {
    match lang {
        "typescript" => &["tsconfig.json", "jsconfig.json", "package.json"],
        "rust" => &["Cargo.toml"],
        "go" => &["go.mod", "go.work"],
        "python" => &[
            "pyproject.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
            "Pipfile",
        ],
        "java" => &[
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
        "c" => &["compile_commands.json", "CMakeLists.txt", "meson.build"],
        "csharp" => &["*.csproj", "*.sln", "*.fsproj"],
        "lua" => &[".luarc.json", ".luacheckrc"],
        "php" => &["composer.json"],
        "ruby" => &["Gemfile", "*.gemspec"],
        "kotlin" => &["build.gradle.kts", "*.kt"],
        "swift" => &["Package.swift", "*.xcodeproj"],
        _ => &[],
    }
}

fn marker_matches(name: &str, marker: &str) -> bool {
    match marker.strip_prefix('*') {
        Some(suffix) => name
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase()),
        None => name == marker,
    }
}
fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

#[derive(Default)]
pub(crate) struct ProjectInventory {
    pub files: Vec<PathBuf>,
    pub directories: Vec<PathBuf>,
    pub incomplete: bool,
}

pub(crate) fn scan_project_inventory(root: &Path, max_depth: usize) -> ProjectInventory {
    let mut result = ProjectInventory::default();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= MAX_SCANNED_FILES {
            result.incomplete = true;
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                result.incomplete = true;
                continue;
            }
        };
        result.directories.push(dir.clone());
        let mut children = Vec::new();
        for entry in entries {
            if visited >= MAX_SCANNED_FILES {
                result.incomplete = true;
                break;
            }
            visited += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            if kind.is_symlink() {
                result.incomplete = true;
            } else if kind.is_file() {
                result.files.push(entry.path());
            } else if kind.is_dir() && !should_skip_dir(&entry.file_name().to_string_lossy()) {
                if depth < max_depth {
                    children.push(entry.path());
                } else {
                    result.incomplete = true;
                }
            }
        }
        children.sort();
        queue.extend(children.into_iter().map(|path| (path, depth + 1)));
    }
    result.files.sort();
    result.directories.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then(a.cmp(b))
    });
    result
}

fn stacks_from_inventory(root: &Path, inventory: &ProjectInventory) -> Vec<ProjectStackDetection> {
    let mut names: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for path in inventory.files.iter().chain(inventory.directories.iter()) {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            names
                .entry(parent.to_path_buf())
                .or_default()
                .push(name.to_string_lossy().into_owned());
        }
    }
    let mut found = Vec::new();
    for dir in &inventory.directories {
        let entries = names.get(dir).map(Vec::as_slice).unwrap_or(&[]);
        for lang in LANGUAGES {
            let marker = markers_for_lang(lang)
                .iter()
                .find_map(|marker| entries.iter().find(|name| marker_matches(name, marker)));
            if let Some(marker) = marker {
                found.push(ProjectStackDetection {
                    path: dir
                        .strip_prefix(root)
                        .unwrap_or(dir)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    lang: (*lang).to_string(),
                    marker: marker.clone(),
                });
            }
        }
    }
    found
}

pub fn detect_project_stack(project_root: &str) -> Vec<ProjectStackDetection> {
    let root = Path::new(project_root);
    stacks_from_inventory(root, &scan_project_inventory(root, MAX_SCAN_DEPTH))
}

pub(crate) fn detect_project_languages_cached(project_root: &str) -> ProjectLanguageProfile {
    let key = std::fs::canonicalize(project_root)
        .unwrap_or_else(|_| PathBuf::from(project_root))
        .to_string_lossy()
        .into_owned();
    let cache = LANG_DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    if let Ok(guard) = cache.lock() {
        if let Some((profile, at)) = guard.get(&key) {
            if now.duration_since(*at) < LANG_DETECT_TTL {
                return profile.clone();
            }
        }
    }
    let root = Path::new(project_root);
    let inventory = scan_project_inventory(root, MAX_SCAN_DEPTH);
    let mut langs: Vec<String> = stacks_from_inventory(root, &inventory)
        .into_iter()
        .map(|d| d.lang)
        .collect();
    langs.sort();
    langs.dedup();
    let extensions = inventory
        .files
        .iter()
        .filter_map(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
        })
        .collect();
    let profile = ProjectLanguageProfile {
        langs,
        extensions,
        incomplete: inventory.incomplete,
    };
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|_, (_, at)| now.duration_since(*at) < LANG_DETECT_TTL);
        guard.insert(key, (profile.clone(), now));
    }
    profile
}

pub(crate) fn scan_project_file_extensions(project_root: &str) -> HashSet<String> {
    scan_project_inventory(Path::new(project_root), MAX_SCAN_DEPTH)
        .files
        .iter()
        .filter_map(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
        })
        .collect()
}

pub(crate) fn dir_has_lang_marker(dir: &Path, markers: &[&str]) -> bool {
    // 固定标志直接检查；通配目录扫描有界，不能对大型依赖目录无限遍历。
    markers.iter().any(|marker| match marker.strip_prefix('*') {
        Some(_) => std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .take(MAX_SCANNED_FILES)
                    .filter_map(Result::ok)
                    .any(|entry| marker_matches(&entry.file_name().to_string_lossy(), marker))
            })
            .unwrap_or(false),
        None => dir.join(marker).is_file(),
    })
}

#[derive(Default)]
pub(crate) struct LangRootDiscovery {
    pub roots: Vec<PathBuf>,
    pub incomplete: bool,
}

/// 独立子包不凭路径猜测属于父workspace；服务器自行解释成员/排除配置。
/// 因此保留所有真实根，仅合并相同物理根，跨根符号按位置去重。
pub(crate) fn discover_lang_roots(project_root: &Path, lang: &str) -> LangRootDiscovery {
    if markers_for_lang(lang).is_empty() {
        return LangRootDiscovery {
            roots: if project_root.is_dir() {
                vec![project_root.to_path_buf()]
            } else {
                vec![]
            },
            incomplete: !project_root.is_dir(),
        };
    }
    let inventory = scan_project_inventory(project_root, MAX_SCAN_DEPTH);
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for stack in stacks_from_inventory(project_root, &inventory)
        .into_iter()
        .filter(|d| d.lang == lang)
    {
        let root = project_root.join(stack.path);
        let physical = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if seen.insert(physical) {
            roots.push(root);
        }
    }
    LangRootDiscovery {
        roots,
        incomplete: inventory.incomplete,
    }
}

pub(crate) fn find_lang_roots(project_root: &Path, lang: &str) -> Vec<PathBuf> {
    discover_lang_roots(project_root, lang).roots
}

/// 文件级从文件本身所属栈查找，不回落至主仓/兄弟工作树。
pub(crate) fn find_lang_root(
    project_root: &Path,
    start_dir: Option<&Path>,
    lang: &str,
) -> Option<PathBuf> {
    let markers = markers_for_lang(lang);
    if markers.is_empty() {
        return Some(project_root.to_path_buf());
    }
    if let Some(start) = start_dir {
        let canonical_root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        let start = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
        // 若传入的是文件父目录兜底根，仍需向上找到真正技术栈。
        let bounded = start != canonical_root && start.starts_with(&canonical_root);
        for dir in start.ancestors() {
            if dir_has_lang_marker(dir, markers) {
                return Some(dir.to_path_buf());
            }
            if bounded && dir == canonical_root {
                break;
            }
            // worktree根(.git为文件或目录)是语义边界，不能爬到另一个项目。
            if dir.join(".git").exists() {
                break;
            }
        }
        return None;
    }
    find_lang_roots(project_root, lang).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markers_cover_lsp_languages() {
        for lang in LANGUAGES {
            assert!(!markers_for_lang(lang).is_empty());
        }
        assert!(markers_for_lang("brainfuck").is_empty());
        assert!(marker_matches("App.xcodeproj", "*.xcodeproj"));
        assert!(marker_matches("Lib.gemspec", "*.gemspec"));
        assert!(marker_matches("App.fsproj", "*.fsproj"));
    }
    #[test]
    fn find_lang_root_walks_up_to_nearest_ancestor() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let start = manifest.join("src").join("mcp");
        assert_eq!(
            find_lang_root(manifest, Some(&start), "rust"),
            std::fs::canonicalize(manifest).ok()
        );
        assert!(find_lang_roots(manifest, "rust")
            .iter()
            .any(|root| root == manifest));
    }
    #[test]
    fn file_request_does_not_fall_back_to_unrelated_root() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            find_lang_root(manifest, Some(&manifest.join("src")), "go"),
            None
        );
    }
    #[test]
    fn depth_limit_is_reported() {
        let inventory = scan_project_inventory(Path::new(env!("CARGO_MANIFEST_DIR")), 0);
        assert!(inventory.incomplete);
        assert!(inventory
            .files
            .iter()
            .any(|file| file.ends_with("Cargo.toml")));
    }

    #[test]
    fn independent_roots_and_wildcard_markers_are_preserved() {
        let root = Path::new("/workspace");
        let inventory = ProjectInventory {
            files: vec![
                root.join("a/Cargo.toml"),
                root.join("b/Cargo.toml"),
                root.join("c/lib.gemspec"),
                root.join("d/app.fsproj"),
            ],
            directories: vec![
                root.into(),
                root.join("a"),
                root.join("b"),
                root.join("c"),
                root.join("d"),
                root.join("e"),
                root.join("e/App.xcodeproj"),
            ],
            incomplete: false,
        };
        let stacks = stacks_from_inventory(root, &inventory);
        assert_eq!(stacks.iter().filter(|s| s.lang == "rust").count(), 2);
        assert!(stacks.iter().any(|s| s.lang == "ruby"));
        assert!(stacks.iter().any(|s| s.lang == "csharp"));
        assert!(stacks.iter().any(|s| s.lang == "swift"));
    }
}
