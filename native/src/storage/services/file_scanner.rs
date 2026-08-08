use std::fs;
use std::path::Path;

use super::gitignore::GitignoreMatcher;

/// A scanned file that is eligible for embedding.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    /// Absolute filesystem path.
    pub path: String,
    /// Path relative to the project root (forward slashes).
    pub relative_path: String,
}

/// Extensions that are considered text/source code files and are eligible
/// for embedding. Binary files, images, archives, and other non-text files
/// are excluded.
pub const TEXT_EXTENSIONS: &[&str] = &[
    // Programming languages
    "rs",
    "go",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "py",
    "java",
    "kt",
    "swift",
    "rb",
    "php",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hxx",
    "cs",
    "fs",
    "fsx",
    "scala",
    "clj",
    "cljs",
    "edn",
    "ex",
    "exs",
    "erl",
    "hrl",
    "hs",
    "lhs",
    "ml",
    "mli",
    "nim",
    "cr",
    "d",
    "dart",
    "elm",
    "gleam",
    "groovy",
    "gradle",
    "jl",
    "lua",
    "pl",
    "pm",
    "r",
    "rb",
    "scm",
    "rkt",
    "v",
    "zig",
    "vala",
    "pas",
    "pp",
    "asm",
    "s",
    "S",
    // Web
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "styl",
    "vue",
    "svelte",
    "astro",
    "php",
    "ejs",
    "hbs",
    "handlebars",
    "pug",
    "jade",
    "twig",
    // Config & data
    "json",
    "json5",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "properties",
    "env",
    "xml",
    "svg",
    "plist",
    "editorconfig",
    // Docs & markup
    "md",
    "markdown",
    "mdx",
    "rst",
    "txt",
    "tex",
    "org",
    "adoc",
    "asciidoc",
    // Shell & scripts
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "bat",
    "cmd",
    "vbs",
    "ahk",
    // Build & project files
    "cmake",
    "mk",
    "makefile",
    "dockerfile",
    "containerfile",
    "gemspec",
    "rakefile",
    "brewfile",
    "procfile",
    "nix",
    // SQL
    "sql",
    "psql",
    "mysql",
    // Other
    "gitignore",
    "dockerignore",
    "npmignore",
    "editorconfig",
    "eslintrc",
    "prettierrc",
    "babelrc",
    "stylelintrc",
];

/// Image extensions that should always be excluded.
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tiff", "tif", "raw", "heic", "heif",
    "avif", "jp2",
];

/// Binary / non-text extensions that should always be excluded.
pub const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bin", "o", "obj", "a", "lib", "zip", "tar", "gz", "bz2", "xz",
    "7z", "rar", "zst", "lz4", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4",
    "avi", "mov", "mkv", "flv", "wav", "flac", "ogg", "woff", "woff2", "ttf", "otf", "eot", "fon",
    "class", "jar", "war", "ear", "pyc", "pyo", "pyd", "wasm", "node", "pdb", "ipa", "apk", "aab",
    "dex", "lock", "map",
];

/// Maximum file size to include (1 MB). Files larger than this are skipped
/// to avoid excessive memory usage and embedding cost.
pub const MAX_FILE_SIZE: u64 = 1 * 1024 * 1024;

/// Directories that should always be skipped even without .gitignore.
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".vercel",
    ".idea",
    ".vscode",
    "coverage",
    ".parcel-cache",
    ".svelte-kit",
    ".angular",
];

/// Scan a project directory and return all text files that are not excluded
/// by `.gitignore`, are not binary/image files, and are within the size limit.
///
/// This function is designed to run in a `spawn_blocking` context — it
/// performs synchronous filesystem I/O but does not block the Node.js main
/// thread when called from an async NAPI function.
pub fn scan_project(root: &Path) -> Vec<ScannedFile> {
    let matcher = GitignoreMatcher::from_project_root(root);
    let mut results = Vec::new();
    scan_dir_recursive(root, root, &matcher, &mut results, 0);
    results
}

fn scan_dir_recursive(
    root: &Path,
    current_dir: &Path,
    matcher: &GitignoreMatcher,
    results: &mut Vec<ScannedFile>,
    depth: usize,
) {
    // Prevent infinite recursion / excessively deep nesting
    if depth > 20 {
        return;
    }

    let entries = match fs::read_dir(current_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs starting with '.' (except .gitignore which
        // is handled by the matcher, and we don't embed it anyway)
        if name.starts_with('.') && name != ".gitignore" {
            continue;
        }

        // Skip known binary/build directories
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }

        let full_path = entry.path();
        let relative_path = full_path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| full_path.to_string_lossy().to_string());

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            // Check gitignore for directories
            if matcher.is_ignored(&relative_path, true) {
                continue;
            }
            scan_dir_recursive(root, &full_path, matcher, results, depth + 1);
        } else if metadata.is_file() {
            // Check gitignore for files
            if matcher.is_ignored(&relative_path, false) {
                continue;
            }

            let size = metadata.len();
            if size > MAX_FILE_SIZE {
                continue;
            }

            let ext = get_extension(&full_path);

            // Skip images and binary files
            if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            if BINARY_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }

            // Only include known text extensions
            if !TEXT_EXTENSIONS.contains(&ext.as_str()) {
                // Also check files without extension that might be code
                // (e.g., Makefile, Dockerfile, Rakefile)
                if !is_extensionless_text_file(&name) {
                    continue;
                }
            }

            // Final binary content check: read first few KB and check for
            // null bytes (handles misnamed files)
            if is_likely_binary(&full_path) {
                continue;
            }

            results.push(ScannedFile {
                path: full_path.to_string_lossy().to_string(),
                relative_path,
            });
        }
    }
}

pub fn get_extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// Check if a file without an extension is a known text/code file.
pub fn is_extensionless_text_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.as_str(),
        "makefile"
            | "dockerfile"
            | "containerfile"
            | "rakefile"
            | "gemfile"
            | "guardfile"
            | "procfile"
            | "brewfile"
            | "vagrantfile"
            | "cmakelists.txt"
            | "license"
            | "license.txt"
            | "license.md"
            | "readme"
            | "readme.txt"
            | "readme.md"
            | "changelog"
            | "changelog.md"
            | "contributing"
            | "contributing.md"
            | "authors"
            | "maintainers"
    )
}

/// Heuristic binary detection: read up to 8KB and check for null bytes.
pub fn is_likely_binary(path: &Path) -> bool {
    use std::io::Read;

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true, // Treat unreadable as binary to be safe
    };

    let mut reader = std::io::BufReader::new(file);
    let mut buf = [0u8; 8192];
    let n = match reader.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return true,
    };

    if n == 0 {
        return false; // Empty file is not binary
    }

    buf[..n].iter().any(|&b| b == 0)
}
