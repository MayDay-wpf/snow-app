#!/usr/bin/env python3
"""Snow App 文档体系一致性检查（docs / skills / 已安装副本）。

校验项：
  1. 中英篇目对照：docs/zh-CN 与 docs/en 的 .md 一一对应；
  2. 21 个设置页 id 在 docs + SKILL 中均有覆盖；
  3. SKILL 第 1 节表格引用的文档路径（zh-CN / en 分支）都存在；
  4. docs/README.md 导航表格中的路径都存在；
  5. ~/.snow/docs 与项目 docs/ 同步状态（diff）；
  6. SKILL frontmatter 完整性（enable: true）。

用法：python scripts/check-docs-consistency.py [--repo-root .] [--snow-home ~/.snow]
退出码：0 = 全部通过；1 = 存在失败项。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# 21 个 openSettings 页面 id（与 native/src/mcp/servers/app_control.rs 的
# VALID_SETTINGS_PAGES 对齐；settingsItems.ts 的 UI 设置项现为 25 个，
# 其中 data-management/general/git/pets 未暴露给 app-control-openSettings）
SETTINGS_PAGES = [
    "api-settings", "imagegen-settings", "image-library", "proxy-browser-settings",
    "codebase-settings", "system-prompt-settings", "personalization-settings",
    "custom-headers-settings", "mcp-settings", "import-settings", "skills-settings",
    "sub-agent-settings", "sensitive-command-settings", "hooks-settings",
    "theme-settings", "terminal-settings", "browser-settings",
    "keyboard-shortcuts-settings", "privacy-settings", "usage-settings", "system-logs",
]


# 中文目录 -> 英文目录
DIR_MAP = {
    "2-使用指南": "2-guides",
    "3-参考手册": "3-reference",
    "4-架构与开发": "4-architecture-and-development",
}

# (目录, 编号) -> 英文文件名（不含目录）
NAME_MAP = {
    ("", 1): "1-getting-started.md",
    ("2-使用指南", 1): "1-configure-mcp.md",
    ("2-使用指南", 2): "2-install-and-manage-skills.md",
    ("2-使用指南", 3): "3-configure-api-keys.md",
    ("2-使用指南", 4): "4-configure-proxy.md",
    ("2-使用指南", 5): "5-configure-hooks-and-subagents.md",
    ("2-使用指南", 6): "6-browser-automation.md",
    ("2-使用指南", 7): "7-codebase-index-and-diagnostics.md",
    ("2-使用指南", 8): "8-third-party-configuration-import.md",
    ("2-使用指南", 9): "9-image-generation.md",
    ("2-使用指南", 10): "10-using-chat-and-ai.md",
    ("2-使用指南", 11): "11-terminal-and-ssh.md",
    ("2-使用指南", 12): "12-git-and-code-browsing.md",
    ("2-使用指南", 13): "13-ai-development-collaboration.md",
    ("2-使用指南", 14): "14-ai-development-lessons.md",
    ("2-使用指南", 15): "15-frontend-design-and-beautification-workflow.md",
    ("2-使用指南", 16): "16-security-privacy-and-tool-authorization.md",
    ("2-使用指南", 17): "17-browser-settings-passwords-and-import.md",
    ("2-使用指南", 18): "18-app-updates.md",
    ("2-使用指南", 19): "19-personalization-theme-and-shortcuts.md",
    ("2-使用指南", 20): "20-usage-statistics-and-system-logs.md",
    ("2-使用指南", 21): "21-create-and-author-skills.md",
    ("2-使用指南", 22): "22-data-management-backup-and-webdav-sync.md",
    ("3-参考手册", 1): "1-settings-json-reference.md",
    ("3-参考手册", 2): "2-builtin-tools-reference.md",
    ("3-参考手册", 3): "3-config-file-field-reference.md",
    ("3-参考手册", 4): "4-data-storage-locations.md",
    ("3-参考手册", 5): "5-security-and-trust-boundaries.md",
    ("4-架构与开发", 1): "1-architecture-overview.md",
    ("4-架构与开发", 2): "2-developer-guide.md",
    ("4-架构与开发", 3): "3-packaging-troubleshooting.md",
    ("4-架构与开发", 4): "4-agent-runtime-and-tool-orchestration.md",
    ("4-架构与开发", 5): "5-storage-migration-backup-and-recovery.md",
    ("4-架构与开发", 6): "6-feature-module-architecture-and-data-flow-diagrams.md",
}


def zh_to_en(rel: str) -> str:
    """中文相对路径 -> 英文相对路径（基于目录 + 编号映射）。"""
    parts = rel.split("/")
    directory, fname = ("/".join(parts[:-1]), parts[-1]) if len(parts) > 1 else ("", parts[0])
    m = re.match(r"^(\d+)-", fname)
    if not m:
        return rel
    n = int(m.group(1))
    en_name = NAME_MAP.get((directory, n))
    if en_name is None:
        return rel
    en_dir = DIR_MAP.get(directory, "")
    return f"{en_dir}/{en_name}" if en_dir else en_name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".", help="snow-app 仓库根目录")
    parser.add_argument("--snow-home", default=str(Path.home() / ".snow"),
                        help="已安装副本目录（~/.snow）")
    args = parser.parse_args()

    root = Path(args.repo_root).resolve()
    snow = Path(args.snow_home).expanduser().resolve()
    failures: list[str] = []

    def check(ok: bool, msg: str) -> None:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {msg}")
        if not ok:
            failures.append(msg)

    # ---------- 1. 中英篇目对照 ----------
    print("== 1. 中英篇目对照 ==")
    zh_files = sorted(p.relative_to(root / "docs" / "zh-CN").as_posix()
                      for p in (root / "docs" / "zh-CN").rglob("*.md"))
    en_files = sorted(p.relative_to(root / "docs" / "en").as_posix()
                      for p in (root / "docs" / "en").rglob("*.md"))
    en_by_num = {}
    for f in en_files:
        m = re.match(r"^(\d+)-", Path(f).name)
        if m:
            en_by_num.setdefault(m.group(1), []).append(f)
    en_set = set(en_files)
    for f in zh_files:
        expected_en = zh_to_en(f)
        ok = expected_en in en_set
        check(ok, f"{f} -> {expected_en}" + ("" if ok else "（英文对应缺失）"))

    # ---------- 2. 21 个设置页 id 覆盖 ----------
    print("== 2. 设置页 id 覆盖（docs + SKILL）==")
    doc_files = list((root / "docs").rglob("*.md")) + [
        root / "resources" / "skills" / "snow-app-docs" / "SKILL.md"]
    doc_texts = {f: f.read_text(encoding="utf-8", errors="ignore") for f in doc_files}
    for page in SETTINGS_PAGES:
        n = sum(1 for t in doc_texts.values() if page in t)
        check(n >= 2, f"{page}: {n} 处")

    # ---------- 3. SKILL 表格引用的文档路径存在 ----------
    print("== 3. SKILL 表格路径 ==")
    skill_path = root / "resources" / "skills" / "snow-app-docs" / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8", errors="ignore")
    refs = re.findall(r"`(?:2-使用指南|2-guides|3-参考手册|3-reference|4-架构与开发|4-architecture-and-development|4-architecture)[^`]*\.md(?:#[0-9a-z-]+)?`", skill_text)
    for ref in refs:
        ref_clean = ref.strip("`").split("#")[0]
        for branch in ("zh-CN", "en"):
            candidate = root / "docs" / branch / ref_clean
            if candidate.exists():
                break
        else:
            candidate = root / "docs" / ref_clean
        check(candidate.exists(), f"{ref_clean} 存在")

    # ---------- 4. README 导航表格路径 ----------
    print("== 4. README 导航表格 ==")
    readme = (root / "docs" / "README.md").read_text(encoding="utf-8", errors="ignore")
    readme_refs = re.findall(r"\((?:zh-CN|en)/[^)]+\.md\)", readme)
    for ref in readme_refs:
        rel = ref.strip("()")
        check((root / "docs" / rel).exists(), f"{rel} 存在")

    # ---------- 5. ~/.snow 同步状态 ----------
    print("== 5. ~/.snow 副本同步 ==")
    if not snow.exists():
        print("  [SKIP] ~/.snow 不存在（非本机运行）")
    else:
        for rel in ("README.md", "DOCUMENTATION_GUIDE.md", "FEATURE_COVERAGE.md",
                    "zh-CN", "en"):
            src = root / "docs" / rel
            dst = snow / "docs" / rel
            if src.is_file():
                ok = dst.exists() and src.read_bytes() == dst.read_bytes()
                check(ok, f"docs/{rel} 与 ~/.snow/docs/{rel} 一致")
            elif src.is_dir():
                diffs = 0
                for f in src.rglob("*.md"):
                    relf = f.relative_to(src)
                    df = dst / relf
                    if not df.exists() or f.read_bytes() != df.read_bytes():
                        diffs += 1
                check(diffs == 0, f"docs/{rel}: {diffs} 个文件差异")
        skill_src = root / "resources" / "skills" / "snow-app-docs" / "SKILL.md"
        skill_dst = snow / "skills" / "snow-app-docs" / "SKILL.md"
        ok = skill_dst.exists() and skill_src.read_bytes() == skill_dst.read_bytes()
        check(ok, "SKILL.md 与 ~/.snow/skills 一致")

    # ---------- 6. SKILL frontmatter ----------
    print("== 6. SKILL frontmatter ==")
    check(skill_text.startswith("---\n"), "frontmatter 以 --- 开头")
    check(re.search(r"^enable: true$", skill_text, re.M) is not None,
          "enable: true 存在")
    check(skill_text.count("```") % 2 == 0, "代码块配对")

    print()
    if failures:
        print(f"❌ {len(failures)} 项失败:")
        for f in failures:
            print(f"   - {f}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
