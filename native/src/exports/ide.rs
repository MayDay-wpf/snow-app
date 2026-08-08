use napi_derive::napi;
use std::path::{Path, PathBuf};

/// 单个已安装 IDE 的信息，经 napi 自动转为 camelCase 暴露给 JS。
#[napi(object)]
pub struct IdeInfo {
    pub id: String,
    pub name: String,
    pub executable: String,
}

/// 已知 IDE 识别表：(id, 显示名, 匹配关键字列表)。
/// 匹配规则：先做精确匹配（例如 "Visual Studio Code Insiders" 精确命中
/// vscode-insiders 而不会被 vscode 抢先包含匹配），再做包含匹配。
const KNOWN_IDES: &[(&str, &str, &[&str])] = &[
    ("vscode", "Visual Studio Code", &["visual studio code"]),
    (
        "vscode-insiders",
        "VS Code Insiders",
        &["visual studio code insiders"],
    ),
    ("cursor", "Cursor", &["cursor"]),
    ("windsurf", "Windsurf", &["windsurf"]),
    ("trae", "Trae", &["trae"]),
    ("zed", "Zed", &["zed"]),
    ("sublime", "Sublime Text", &["sublime text"]),
    ("intellij", "IntelliJ IDEA", &["intellij idea", "idea"]),
    ("webstorm", "WebStorm", &["webstorm"]),
    ("pycharm", "PyCharm", &["pycharm"]),
    ("goland", "GoLand", &["goland"]),
    ("clion", "CLion", &["clion"]),
    ("phpstorm", "PhpStorm", &["phpstorm"]),
    ("rubymine", "RubyMine", &["rubymine"]),
    ("rider", "Rider", &["rider"]),
    ("datagrip", "DataGrip", &["datagrip"]),
    ("android-studio", "Android Studio", &["android studio"]),
    ("xcode", "Xcode", &["xcode"]),
    ("fleet", "Fleet", &["fleet"]),
];

/// 根据小写名称匹配已知 IDE，精确匹配优先，其次按列表顺序做包含匹配。
fn match_known_ide(
    lower_name: &str,
) -> Option<&'static (&'static str, &'static str, &'static [&'static str])> {
    if let Some(matched) = KNOWN_IDES
        .iter()
        .find(|(_, _, keys)| keys.iter().any(|key| lower_name == *key))
    {
        return Some(matched);
    }
    KNOWN_IDES
        .iter()
        .find(|(_, _, keys)| keys.iter().any(|key| lower_name.contains(key)))
}

fn to_ide_info(matched: &(&str, &str, &[&str]), executable: &Path) -> IdeInfo {
    IdeInfo {
        id: matched.0.to_string(),
        name: matched.1.to_string(),
        executable: executable.to_string_lossy().to_string(),
    }
}

/// 在若干根目录下递归查找 "bin/" 子目录中的候选可执行文件，
/// 用于定位 JetBrains 系（/opt/idea/bin/idea.sh、Toolbox 的
/// apps/<app>/ch-0/<ver>/bin/idea64.exe 等带动态版本号的安装）。
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn find_in_bin_dirs(roots: &[PathBuf], candidates: &[&str], max_depth: usize) -> Option<PathBuf> {
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        if let Some(found) = find_bin_recursive(root, candidates, max_depth, 0) {
            return Some(found);
        }
    }
    None
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn find_bin_recursive(
    dir: &Path,
    candidates: &[&str],
    max_depth: usize,
    depth: usize,
) -> Option<PathBuf> {
    let bin_dir = dir.join("bin");
    for candidate in candidates {
        let path = bin_dir.join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    if depth >= max_depth {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_bin_recursive(&path, candidates, max_depth, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

// ============================================================================
// macOS：扫描 /Applications 与 ~/Applications 下的 .app 应用包
// ============================================================================
#[cfg(target_os = "macos")]
fn detect_ides() -> Vec<IdeInfo> {
    let mut found: Vec<IdeInfo> = Vec::new();

    let mut app_dirs: Vec<PathBuf> = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        app_dirs.push(PathBuf::from(home).join("Applications"));
    }

    for dir in app_dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_app = path
                .extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("app"))
                .unwrap_or(false);
            if !is_app {
                continue;
            }
            let Some(app_name) = path.file_stem().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            let Some(matched) = match_known_ide(&app_name.to_lowercase()) else {
                continue;
            };
            // 已在列表中则跳过（避免 ~/Applications 与 /Applications 重复）
            if found.iter().any(|item| item.id == matched.0) {
                continue;
            }
            if let Some(executable) = macos_app_executable(&path, &app_name) {
                found.push(to_ide_info(matched, &executable));
            }
        }
    }

    found
}

/// 解析 .app 包内的可执行文件：优先 Contents/MacOS/<AppName>，
/// 否则取 Contents/MacOS 下的第一个文件。
#[cfg(target_os = "macos")]
fn macos_app_executable(app_path: &Path, app_name: &str) -> Option<PathBuf> {
    let macos_dir = app_path.join("Contents").join("MacOS");
    let direct = macos_dir.join(app_name);
    if direct.is_file() {
        return Some(direct);
    }
    let Ok(entries) = std::fs::read_dir(&macos_dir) else {
        return None;
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_file())
}

// ============================================================================
// Windows：静态路径 + App Paths 注册表 + Toolbox 目录 + Uninstall 注册表
// ============================================================================
#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    /// (id, 显示名, 静态候选路径列表)。路径中的 %VAR% 会被展开。
    const STATIC_CANDIDATES: &[(&str, &str, &[&str])] = &[
        (
            "vscode",
            "Visual Studio Code",
            &[
                r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
                r"%PROGRAMFILES%\Microsoft VS Code\Code.exe",
            ],
        ),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &[
                r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe",
                r"%PROGRAMFILES%\Microsoft VS Code Insiders\Code - Insiders.exe",
            ],
        ),
        (
            "cursor",
            "Cursor",
            &[r"%LOCALAPPDATA%\Programs\Cursor\Cursor.exe"],
        ),
        (
            "windsurf",
            "Windsurf",
            &[r"%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe"],
        ),
        ("trae", "Trae", &[r"%LOCALAPPDATA%\Programs\Trae\Trae.exe"]),
        (
            "sublime",
            "Sublime Text",
            &[r"%PROGRAMFILES%\Sublime Text\sublime_text.exe"],
        ),
        ("zed", "Zed", &[r"%LOCALAPPDATA%\Programs\Zed\zed.exe"]),
        (
            "intellij",
            "IntelliJ IDEA",
            &[
                r"%PROGRAMFILES%\JetBrains\IntelliJ IDEA\bin\idea64.exe",
                r"%PROGRAMFILES%\JetBrains\IntelliJ IDEA Community Edition\bin\idea64.exe",
            ],
        ),
        (
            "webstorm",
            "WebStorm",
            &[r"%PROGRAMFILES%\JetBrains\WebStorm\bin\webstorm64.exe"],
        ),
        (
            "pycharm",
            "PyCharm",
            &[
                r"%PROGRAMFILES%\JetBrains\PyCharm\bin\pycharm64.exe",
                r"%PROGRAMFILES%\JetBrains\PyCharm Community Edition\bin\pycharm64.exe",
            ],
        ),
        (
            "goland",
            "GoLand",
            &[r"%PROGRAMFILES%\JetBrains\GoLand\bin\goland64.exe"],
        ),
        (
            "clion",
            "CLion",
            &[r"%PROGRAMFILES%\JetBrains\CLion\bin\clion64.exe"],
        ),
        (
            "phpstorm",
            "PhpStorm",
            &[r"%PROGRAMFILES%\JetBrains\PhpStorm\bin\phpstorm64.exe"],
        ),
        (
            "rubymine",
            "RubyMine",
            &[r"%PROGRAMFILES%\JetBrains\RubyMine\bin\rubymine64.exe"],
        ),
        (
            "rider",
            "Rider",
            &[r"%PROGRAMFILES%\JetBrains\Rider\bin\rider64.exe"],
        ),
        (
            "datagrip",
            "DataGrip",
            &[r"%PROGRAMFILES%\JetBrains\DataGrip\bin\datagrip64.exe"],
        ),
        (
            "android-studio",
            "Android Studio",
            &[r"%PROGRAMFILES%\Android\Android Studio\bin\studio64.exe"],
        ),
    ];

    /// 各 IDE 在注册表 App Paths / Uninstall 中对应的可执行文件名。
    /// App Paths 键名即文件名；Uninstall 的 DisplayIcon 常指向这些文件。
    const APP_PATH_KEYS: &[(&str, &str, &[&str])] = &[
        ("vscode", "Visual Studio Code", &["Code.exe", "Code"]),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &["Code - Insiders.exe", "Code - Insiders"],
        ),
        ("cursor", "Cursor", &["Cursor.exe", "Cursor"]),
        ("windsurf", "Windsurf", &["Windsurf.exe", "Windsurf"]),
        ("trae", "Trae", &["Trae.exe", "Trae"]),
        ("zed", "Zed", &["zed.exe", "zed"]),
        (
            "sublime",
            "Sublime Text",
            &["sublime_text.exe", "sublime_text"],
        ),
        ("intellij", "IntelliJ IDEA", &["idea64.exe", "idea.exe"]),
        ("webstorm", "WebStorm", &["webstorm64.exe", "webstorm.exe"]),
        ("pycharm", "PyCharm", &["pycharm64.exe", "pycharm.exe"]),
        ("goland", "GoLand", &["goland64.exe", "goland.exe"]),
        ("clion", "CLion", &["clion64.exe", "clion.exe"]),
        ("phpstorm", "PhpStorm", &["phpstorm64.exe", "phpstorm.exe"]),
        ("rubymine", "RubyMine", &["rubymine64.exe", "rubymine.exe"]),
        ("rider", "Rider", &["rider64.exe", "rider.exe"]),
        ("datagrip", "DataGrip", &["datagrip64.exe", "datagrip.exe"]),
        (
            "android-studio",
            "Android Studio",
            &["studio64.exe", "studio.exe"],
        ),
    ];

    /// 展开 %VAR% 形式的占位符。注意先替换带括号的变量，
    /// 否则 "%PROGRAMFILES(X86)%" 会被 "%PROGRAMFILES%" 提前破坏。
    fn expand_env(candidate: &str) -> PathBuf {
        let mut expanded = candidate.to_string();
        if let Some(value) = std::env::var("PROGRAMFILES(X86)").ok() {
            expanded = expanded.replace("%PROGRAMFILES(X86)%", &value);
        }
        if let Some(value) = std::env::var("PROGRAMFILES").ok() {
            expanded = expanded.replace("%PROGRAMFILES%", &value);
        }
        if let Some(value) = std::env::var("LOCALAPPDATA").ok() {
            expanded = expanded.replace("%LOCALAPPDATA%", &value);
        }
        if let Some(value) = std::env::var("USERPROFILE").ok() {
            expanded = expanded.replace("%USERPROFILE%", &value);
        }
        PathBuf::from(expanded)
    }

    /// 静态已知路径检测。
    fn detect_static_paths() -> Vec<IdeInfo> {
        let mut found: Vec<IdeInfo> = Vec::new();
        for (id, name, candidates) in STATIC_CANDIDATES {
            for candidate in *candidates {
                let path = expand_env(candidate);
                if path.is_file() {
                    found.push(IdeInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                        executable: path.to_string_lossy().to_string(),
                    });
                    break;
                }
            }
        }
        found
    }

    /// 注册表 App Paths 检测（HKLM + HKCU）：
    /// HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>
    /// 的默认值即可执行文件完整路径。JetBrains Toolbox 安装的 IDE 也会注册。
    fn detect_app_paths() -> Vec<IdeInfo> {
        let mut found: Vec<IdeInfo> = Vec::new();
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
                KEY_READ,
            ) else {
                continue;
            };
            for (id, name, keys) in APP_PATH_KEYS {
                if found.iter().any(|item: &IdeInfo| item.id == *id) {
                    continue;
                }
                for key in *keys {
                    if let Ok(subkey) = root.open_subkey_with_flags(key, KEY_READ) {
                        if let Ok(value) = subkey.get_value::<String, _>("") {
                            let raw = value.trim().trim_matches('"');
                            if !raw.is_empty() && Path::new(raw).is_file() {
                                found.push(IdeInfo {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    executable: raw.to_string(),
                                });
                                break;
                            }
                        }
                    }
                }
            }
        }
        found
    }

    /// JetBrains Toolbox 目录检测：apps/<app>/ch-0/<版本>/bin/<exe>，
    /// 版本目录名是动态的，需要递归查找。
    fn detect_toolbox() -> Vec<IdeInfo> {
        let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
            return Vec::new();
        };
        let apps_root = PathBuf::from(local_app_data)
            .join("JetBrains")
            .join("Toolbox")
            .join("apps");
        if !apps_root.is_dir() {
            return Vec::new();
        }

        let mut found: Vec<IdeInfo> = Vec::new();
        for (id, name, candidates) in APP_PATH_KEYS {
            if let Some(executable) = find_in_bin_dirs(&[apps_root.clone()], candidates, 3) {
                found.push(IdeInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    executable: executable.to_string_lossy().to_string(),
                });
            }
        }
        found
    }

    /// 在目录内（含 bin/ 子目录）查找可执行文件，用于 Uninstall 的 InstallLocation。
    fn find_executable_in_dir(dir: &Path) -> Option<PathBuf> {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path
                        .extension()
                        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("exe"))
                        .unwrap_or(false)
                {
                    return Some(path);
                }
            }
        }
        let bin_dir = dir.join("bin");
        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path
                        .extension()
                        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("exe"))
                        .unwrap_or(false)
                {
                    return Some(path);
                }
            }
        }
        None
    }

    /// Uninstall 注册表检测：遍历卸载项，按 DisplayName 匹配已知 IDE，
    /// 从 DisplayIcon / InstallLocation 解析可执行文件路径。
    fn detect_uninstall() -> Vec<IdeInfo> {
        let mut found: Vec<IdeInfo> = Vec::new();
        let uninstall_paths = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ];

        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            for uninstall_path in uninstall_paths {
                let Ok(root) =
                    RegKey::predef(hive).open_subkey_with_flags(uninstall_path, KEY_READ)
                else {
                    continue;
                };
                for subkey_name in root.enum_keys().flatten() {
                    let Ok(subkey) = root.open_subkey_with_flags(&subkey_name, KEY_READ) else {
                        continue;
                    };
                    let Ok(display_name) = subkey.get_value::<String, _>("DisplayName") else {
                        continue;
                    };
                    let Some(matched) = match_known_ide(&display_name.to_lowercase()) else {
                        continue;
                    };
                    if found.iter().any(|item: &IdeInfo| item.id == matched.0) {
                        continue;
                    }

                    // 优先 DisplayIcon（通常形如 "C:\path\app.exe",0）
                    if let Ok(icon) = subkey.get_value::<String, _>("DisplayIcon") {
                        let icon_path = icon
                            .split(',')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .trim_matches('"');
                        if !icon_path.is_empty() && Path::new(icon_path).is_file() {
                            found.push(to_ide_info(matched, Path::new(icon_path)));
                            continue;
                        }
                    }
                    // 其次 InstallLocation 目录
                    if let Ok(location) = subkey.get_value::<String, _>("InstallLocation") {
                        let location_dir = Path::new(location.trim());
                        if location_dir.is_dir() {
                            if let Some(executable) = find_executable_in_dir(location_dir) {
                                found.push(to_ide_info(matched, &executable));
                            }
                        }
                    }
                }
            }
        }
        found
    }

    pub fn detect() -> Vec<IdeInfo> {
        let mut found = detect_static_paths();
        // 多来源合并去重：App Paths 能覆盖 Toolbox 等动态路径安装
        for source in [detect_app_paths(), detect_toolbox(), detect_uninstall()] {
            for ide in source {
                if !found.iter().any(|item: &IdeInfo| item.id == ide.id) {
                    found.push(ide);
                }
            }
        }
        found
    }
}

// ============================================================================
// Linux：PATH 命令 + Flatpak exports + JetBrains bin/ 目录 + Toolbox
// ============================================================================
#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    /// (id, 显示名, 可执行文件名候选，按顺序尝试)
    const LINUX_CMDS: &[(&str, &str, &[&str])] = &[
        ("vscode", "Visual Studio Code", &["code"]),
        ("cursor", "Cursor", &["cursor"]),
        ("windsurf", "Windsurf", &["windsurf"]),
        ("trae", "Trae", &["trae"]),
        ("zed", "Zed", &["zed"]),
        ("sublime", "Sublime Text", &["sublime_text", "subl"]),
        ("intellij", "IntelliJ IDEA", &["idea"]),
        ("webstorm", "WebStorm", &["webstorm"]),
        ("pycharm", "PyCharm", &["pycharm"]),
        ("goland", "GoLand", &["goland"]),
        ("clion", "CLion", &["clion"]),
        ("phpstorm", "PhpStorm", &["phpstorm"]),
        ("rubymine", "RubyMine", &["rubymine"]),
        ("rider", "Rider", &["rider"]),
        ("datagrip", "DataGrip", &["datagrip"]),
        (
            "android-studio",
            "Android Studio",
            &["android-studio", "studio"],
        ),
    ];

    /// JetBrains 系的启动脚本名（Linux 上为 bin/ 下的 .sh）。
    const JETBRAINS_SCRIPTS: &[(&str, &str, &[&str])] = &[
        ("intellij", "IntelliJ IDEA", &["idea.sh"]),
        ("webstorm", "WebStorm", &["webstorm.sh"]),
        ("pycharm", "PyCharm", &["pycharm.sh"]),
        ("goland", "GoLand", &["goland.sh"]),
        ("clion", "CLion", &["clion.sh"]),
        ("phpstorm", "PhpStorm", &["phpstorm.sh"]),
        ("rubymine", "RubyMine", &["rubymine.sh"]),
        ("rider", "Rider", &["rider.sh"]),
        ("datagrip", "DataGrip", &["datagrip.sh"]),
        ("android-studio", "Android Studio", &["studio.sh"]),
    ];

    /// Flatpak 安装的 IDE：exports/bin 下的可执行文件名。
    const FLATPAK_CMDS: &[(&str, &str, &[&str])] = &[
        ("vscode", "Visual Studio Code", &["com.visualstudio.code"]),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &["com.visualstudio.code.insiders"],
        ),
        ("cursor", "Cursor", &["com.todesktop.230113m5300dxn61"]),
        ("sublime", "Sublime Text", &["com.sublimetext.sublime"]),
        (
            "intellij",
            "IntelliJ IDEA",
            &[
                "com.jetbrains.IntelliJ-IDEA-Community",
                "com.jetbrains.IntelliJ-IDEA-Ultimate",
            ],
        ),
        (
            "pycharm",
            "PyCharm",
            &[
                "com.jetbrains.PyCharm-Community",
                "com.jetbrains.PyCharm-Professional",
            ],
        ),
        ("webstorm", "WebStorm", &["com.jetbrains.WebStorm"]),
        ("goland", "GoLand", &["com.jetbrains.GoLand"]),
        ("clion", "CLion", &["com.jetbrains.CLion"]),
        ("phpstorm", "PhpStorm", &["com.jetbrains.PhpStorm"]),
        ("rubymine", "RubyMine", &["com.jetbrains.RubyMine"]),
        ("rider", "Rider", &["com.jetbrains.Rider"]),
        ("datagrip", "DataGrip", &["com.jetbrains.DataGrip"]),
    ];

    /// 在目录列表中查找直接可执行文件。
    fn find_direct(dirs: &[PathBuf], commands: &[&str]) -> Option<PathBuf> {
        for command in commands {
            for dir in dirs {
                let candidate = dir.join(command);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    pub fn detect() -> Vec<IdeInfo> {
        let mut found: Vec<IdeInfo> = Vec::new();

        // 1. PATH + /opt + /snap/bin + flatpak exports 中的直接命令
        let mut search_dirs: Vec<PathBuf> = Vec::new();
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in path_var.split(':') {
                if !dir.is_empty() {
                    search_dirs.push(PathBuf::from(dir));
                }
            }
        }
        search_dirs.push(PathBuf::from("/opt"));
        search_dirs.push(PathBuf::from("/snap/bin"));
        search_dirs.push(PathBuf::from("/var/lib/flatpak/exports/bin"));
        if let Some(home) = std::env::var_os("HOME") {
            search_dirs.push(PathBuf::from(home).join(".local/share/flatpak/exports/bin"));
        }

        for (id, name, commands) in LINUX_CMDS {
            if let Some(executable) = find_direct(&search_dirs, commands) {
                found.push(IdeInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    executable: executable.to_string_lossy().to_string(),
                });
            }
        }

        // 2. Flatpak 专用命令（id 与 Linux 命令不同，单独补漏）
        for (id, name, commands) in FLATPAK_CMDS {
            if found.iter().any(|item: &IdeInfo| item.id == *id) {
                continue;
            }
            if let Some(executable) = find_direct(&search_dirs, commands) {
                found.push(IdeInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    executable: executable.to_string_lossy().to_string(),
                });
            }
        }

        // 3. JetBrains 系 bin/ 目录：/opt/<name>/bin/*.sh、
        //    ~/ 下解压目录的 bin/*.sh、Toolbox apps 动态版本目录
        let mut jetbrains_roots: Vec<PathBuf> = vec![PathBuf::from("/opt")];
        if let Some(home) = std::env::var_os("HOME") {
            let home_dir = PathBuf::from(home);
            jetbrains_roots.push(home_dir.join(".local/share/JetBrains/Toolbox/apps"));
            jetbrains_roots.push(home_dir);
        }

        for (id, name, scripts) in JETBRAINS_SCRIPTS {
            if found.iter().any(|item: &IdeInfo| item.id == *id) {
                continue;
            }
            // /opt 与 home 一级目录：max_depth=1；Toolbox apps：max_depth=3
            let mut executable = find_in_bin_dirs(&jetbrains_roots[0..1], scripts, 1);
            if executable.is_none() && jetbrains_roots.len() > 1 {
                executable = find_in_bin_dirs(&jetbrains_roots[1..2], scripts, 3);
            }
            if executable.is_none() && jetbrains_roots.len() > 2 {
                executable = find_in_bin_dirs(&jetbrains_roots[2..3], scripts, 1);
            }
            if let Some(path) = executable {
                found.push(IdeInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    executable: path.to_string_lossy().to_string(),
                });
            }
        }

        found
    }
}

// ============================================================================
// Windows / Linux：委托给平台模块的 detect()
// ============================================================================
#[cfg(target_os = "windows")]
fn detect_ides() -> Vec<IdeInfo> {
    windows::detect()
}

#[cfg(target_os = "linux")]
fn detect_ides() -> Vec<IdeInfo> {
    linux::detect()
}

// ============================================================================
// 其它平台：空列表
// ============================================================================
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn detect_ides() -> Vec<IdeInfo> {
    Vec::new()
}

/// 检测系统已安装的 IDE。异步执行并在阻塞线程池中做文件系统扫描，
/// 避免阻塞 Node.js 主线程。
#[napi]
pub async fn list_installed_ides() -> napi::Result<Vec<IdeInfo>> {
    tokio::task::spawn_blocking(detect_ides)
        .await
        .map_err(|error| napi::Error::from_reason(format!("Failed to detect IDEs: {error}")))
}

/// 按 id 重新检测并解析出可执行文件路径。
fn resolve_ide_executable(ide_id: &str) -> Option<String> {
    detect_ides()
        .into_iter()
        .find(|item| item.id == ide_id)
        .map(|item| item.executable)
}

/// 在指定 IDE 中打开项目目录。异步执行：进程以分离方式启动并立即返回，
/// 不阻塞 Node.js 主线程。
#[napi]
pub async fn open_in_ide(ide_id: String, project_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let trimmed_id = ide_id.trim();
        let trimmed_path = project_path.trim();

        if trimmed_id.is_empty() {
            return Err(napi::Error::from_reason("IDE id is required"));
        }
        if trimmed_path.is_empty() {
            return Err(napi::Error::from_reason("Project path is required"));
        }
        if !Path::new(trimmed_path).is_dir() {
            return Err(napi::Error::from_reason(
                "Project path does not exist or is not a directory",
            ));
        }

        let executable = resolve_ide_executable(trimmed_id).ok_or_else(|| {
            napi::Error::from_reason(format!("IDE \"{trimmed_id}\" is not installed"))
        })?;

        let mut command = std::process::Command::new(&executable);
        command.arg(trimmed_path);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
        }

        command.spawn().map(|_| ()).map_err(|error| {
            napi::Error::from_reason(format!("Failed to launch {executable}: {error}"))
        })
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to open IDE: {error}")))?
}
