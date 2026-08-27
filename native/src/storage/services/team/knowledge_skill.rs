//! 团队知识（TeamNotes）自动沉淀为项目级 Skill。
//!
//! 笔记集合非空时生成 `<repo>/.snow/skills/team-knowledge/SKILL.md`，
//! 清空时删除整个目录；skills 发现机制会在 AI 会话中自动加载该文件。
//! 调用方均持有 team 锁，本模块只做纯文件读写，禁止再获取锁或执行 git。

use std::fs;
use std::path::{Path, PathBuf};

use super::TeamNote;

const SKILL_ID: &str = "team-knowledge";
/// 正文上限：避免笔记过多导致 SKILL.md 无限膨胀
const MAX_BODY_BYTES: usize = 160 * 1024;

fn skill_dir(repo_path: &str) -> PathBuf {
    Path::new(repo_path)
        .join(".snow")
        .join("skills")
        .join(SKILL_ID)
}

/// 由当前笔记集合重建或移除项目级知识 Skill。幂等：内容未变化不写盘。
pub fn sync_knowledge_skill(repo_path: &str, worktree: &Path) {
    let dir = skill_dir(repo_path);
    let notes = load_notes(worktree);
    if notes.is_empty() {
        // 知识清空：移除 skill 目录
        if dir.is_dir() {
            let _ = fs::remove_dir_all(&dir);
        }
        return;
    }
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let doc = render_document(&dir, &notes);
    let path = dir.join("SKILL.md");
    // 内容未变则跳过写盘，减少文件 watcher 干扰
    if fs::read_to_string(&path)
        .map(|old| old == doc)
        .unwrap_or(false)
    {
        return;
    }
    let _ = fs::write(&path, doc);
}

/// 读取 worktree 中的全部笔记，按更新时间倒序。
fn load_notes(worktree: &Path) -> Vec<TeamNote> {
    let dir = worktree.join(super::TEAM_DIR).join("note");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut notes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(note) = serde_json::from_str::<TeamNote>(&content) {
                if note.title.trim().is_empty() && note.content.trim().is_empty() {
                    continue;
                }
                notes.push(note);
            }
        }
    }
    notes.sort_by(|a, b| updated_ms(b).cmp(&updated_ms(a)));
    notes
}

fn updated_ms(note: &TeamNote) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&note.updated_at)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// 组装完整 SKILL.md（frontmatter + 正文）。
fn render_document(skill_dir: &Path, notes: &[TeamNote]) -> String {
    // 保留用户在 Skills 设置中手动切换的 enable 开关
    let old = fs::read_to_string(skill_dir.join("SKILL.md")).unwrap_or_default();
    let enabled = existing_enable(&old).unwrap_or(true);
    let body = render_body(notes);
    format!(
        "---\nname: 团队项目知识\ndescription: 团队协作自动同步的项目知识沉淀。记录本项目的技术决策、踩坑记录与共享经验，处理与本仓库相关的任务前可先读取本技能获取团队既有结论。\nenable: {enabled}\n---\n\n{body}"
    )
}

fn render_body(notes: &[TeamNote]) -> String {
    let mut buf = String::from("# 团队项目知识\n\n");
    buf.push_str(
        "> 本文件由团队协作自动生成，请勿手工编辑；全部团队知识清空后会自动移除。\n\
         > 图片存放在仓库 `.snow/team-worktree/snow-team/media/<note_id>/` 目录，正文以相对路径引用。\n\n",
    );
    let mut truncated = false;
    for note in notes {
        buf.push_str("---\n\n");
        buf.push_str(&format!("## {}\n\n", one_line(&note.title)));
        buf.push_str(&format!("- 作者：{}\n", note.author_email.trim()));
        buf.push_str(&format!("- 更新时间：{}\n", note.updated_at.trim()));
        if !note.tags.is_empty() {
            buf.push_str(&format!("- 标签：{}\n", note.tags.join("、")));
        }
        buf.push('\n');
        buf.push_str(note.content.trim());
        buf.push_str("\n\n");
        if buf.len() > MAX_BODY_BYTES {
            truncated = true;
            break;
        }
    }
    if truncated {
        buf.push_str("> 笔记数量过多，仅保留最近部分知识，完整内容请查看团队协作面板。\n");
    }
    buf
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解析旧文档 frontmatter 中的根级 `enable:` 开关值。
fn existing_enable(doc: &str) -> Option<bool> {
    let rest = doc.strip_prefix("---\n").or_else(|| doc.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.trim() == "enable" {
                return Some(value.trim().eq_ignore_ascii_case("true"));
            }
        }
    }
    None
}
