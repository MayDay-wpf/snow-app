//! 分层增量压缩（context fold）的请求规划。
//!
//! 思路取自 billion-context：压缩不是把整段会话换成一份交接文档，而是只把较早的
//! 消息区间折叠成一段摘要，最近的消息原样保留；折叠摘要累积到一定数量时，下一次
//! 折叠把同层的摘要连同新消息合并成更高一层的摘要（LSM 式分层，最多三层）。
//! 被折叠的原始消息留在库内，模型可以用 context-recall 按需检索、展开。
//!
//! 压缩请求只发送「折叠区间及其之前的上下文」+ 压缩指令：保留的近期消息不发送，
//! 摘要只覆盖指令点名的区间。

use std::path::Path;

use napi::bindgen_prelude::*;

use crate::api::token_counter::count_tokens;
use crate::storage::services::chat_conversations::{
    load_context_view, max_fold_seq, ChatContextMessage, ContextFoldMeta, ContextFoldRecord,
    ContextViewItem, ORIGIN_INTERNAL,
};

/// 原样保留的近期消息约占当前上下文的比例（百分比）。
const TAIL_KEEP_PERCENT: usize = 30;
/// 已有摘要占上下文的比例超过该值时，本次折叠合并全部摘要。
const SUMMARY_SHARE_MERGE_PERCENT: usize = 40;
/// 同层摘要连同本次新折叠达到该数量时合并升层。
const MERGE_FANOUT: usize = 4;
const MAX_TIER: i64 = 3;

/// 折叠压缩后续跑时，若上下文末尾不是 user 消息（压缩发生在工具调用执行前），
/// 追加这条内部消息让模型接着干。
pub(super) const FOLD_RESUME_PROMPT: &str = "[Context compressed] Earlier conversation history was folded into compressed sections to free up the context window. Continue the current task from where you left off. Tool calls that were pending when compression started were NOT executed; issue them again if they are still needed.";

pub(super) struct ContextFoldPlan {
    /// 压缩请求的历史：折叠区间及其之前的上下文（已应用既有折叠）。
    pub history: Vec<ChatContextMessage>,
    /// 追加在历史之后的压缩指令（内部 user 消息）。
    pub instruction: ChatContextMessage,
    pub record: ContextFoldRecord,
}

fn item_tokens(item: &ContextViewItem) -> usize {
    let message = item.to_message();
    count_tokens(&message.content)
        + message.tool_calls_json.as_deref().map(count_tokens).unwrap_or(0)
        + message.tool_results_json.as_deref().map(count_tokens).unwrap_or(0)
        + message.thinking.as_deref().map(count_tokens).unwrap_or(0)
}

fn fold_meta(item: &ContextViewItem) -> Option<&ContextFoldMeta> {
    match item {
        ContextViewItem::Fold { meta, .. } => Some(meta),
        ContextViewItem::Message { .. } => None,
    }
}

fn is_tool_result(item: &ContextViewItem) -> bool {
    matches!(item, ContextViewItem::Message { message, .. } if message.role.trim() == "tool")
}

fn first_covered_id(item: &ContextViewItem) -> &str {
    match item {
        ContextViewItem::Message { id, .. } => id,
        ContextViewItem::Fold { meta, .. } => &meta.start_id,
    }
}

fn last_covered_id(item: &ContextViewItem) -> &str {
    match item {
        ContextViewItem::Message { id, .. } => id,
        ContextViewItem::Fold { meta, .. } => &meta.end_id,
    }
}

/// 决定本次折叠从哪一项开始、产出哪一层：同层摘要连同新折叠凑满 MERGE_FANOUT
/// 就并入并升一层，逐层级联；摘要整体占比过高时直接合并全部摘要。
fn resolve_merge_start(
    folds: &[(usize, i64)],
    raw_start: usize,
    summary_tokens: usize,
    total_tokens: usize,
) -> (usize, i64) {
    if !folds.is_empty() && summary_tokens * 100 > total_tokens * SUMMARY_SHARE_MERGE_PERCENT {
        let top = folds.iter().map(|(_, tier)| *tier).max().unwrap_or(1);
        return (0, (top + 1).min(MAX_TIER));
    }
    let mut start = raw_start;
    let mut tier = 1;
    let mut cursor = folds.len();
    loop {
        let mut begin = cursor;
        while begin > 0 && folds[begin - 1].1 == tier {
            begin -= 1;
        }
        if cursor - begin + 1 < MERGE_FANOUT {
            break;
        }
        start = folds[begin].0;
        cursor = begin;
        if tier >= MAX_TIER {
            break;
        }
        tier += 1;
    }
    (start, tier)
}

fn build_instruction(kept: &[i64], merged: &[i64], tier: i64) -> String {
    let range = match (kept.first(), kept.last()) {
        (Some(first), Some(last)) if first == last => format!(
            "Compressed section #{last} at the beginning is already summarized; keep it out of your summary. Compress everything AFTER section #{last} up to the end of the conversation above into ONE summary."
        ),
        (Some(first), Some(last)) => format!(
            "Compressed sections #{first}-#{last} at the beginning are already summarized; keep them out of your summary. Compress everything AFTER section #{last} up to the end of the conversation above into ONE summary."
        ),
        _ => "Compress the ENTIRE conversation above into ONE summary.".to_string(),
    };
    let merge = match (merged.first(), merged.last()) {
        (Some(first), Some(last)) => format!(
            " That range begins with earlier compressed sections #{first}-#{last}: they are summaries themselves, so merge them with the newer messages into one consolidated summary instead of repeating them."
        ),
        _ => String::new(),
    };
    let detail = if tier <= 1 {
        "Be detailed: keep identifiers, file paths, symbols, commands, numbers and error messages exactly. Stay within roughly 1500 words."
    } else {
        "Consolidate: drop details that no longer matter for future work, but keep every user request, decision, constraint and file path. Stay within roughly 1200 words."
    };
    format!(
        "[Context compression request]\nThe context window is filling up. {range}{merge} Your summary replaces those messages in every future request (the originals stay stored and remain searchable), so it must let you continue the work without re-reading them.\n\nWrite the summary in Markdown with these sections:\n## User Requests\nEvery user message in the range, quoted verbatim in its original language (abbreviate only long pasted content, keeping its purpose).\n## Work Done\nConcrete actions and outcomes with exact file paths, symbols, commands and results. Judge completion from evidence (applied edits, tool output), not from TODO status.\n## Findings & Decisions\nFacts learned, decisions made, constraints, errors and how they were resolved.\n## Open Threads\nWhat was still in progress or pending at the end of the range, with the exact next step.\n\nRules:\n- {detail}\n- Output ONLY the summary. Do not call tools, do not address the user, and do not add a title line."
    )
}

/// 规划一次折叠压缩。没有可折叠的内容时报错（压缩以失败提示结束，上下文不变）。
pub(super) fn plan_context_fold(
    database_path: &Path,
    conversation_id: &str,
) -> Result<ContextFoldPlan> {
    let view = load_context_view(database_path, conversation_id)?;
    let tokens: Vec<usize> = view.iter().map(item_tokens).collect();
    let total_tokens: usize = tokens.iter().sum();
    let len = view.len();
    // 既有折叠总在上下文开头连续排列，之后是尚未折叠的原始消息。
    let raw_start = view
        .iter()
        .rposition(|item| fold_meta(item).is_some())
        .map_or(0, |index| index + 1);

    // 从末尾往前保留近期消息；保留段不能以工具结果开头（必须带上发起调用的助手消息）。
    let keep_budget = total_tokens * TAIL_KEEP_PERCENT / 100;
    let mut split = len;
    let mut kept_tokens = 0usize;
    while split > raw_start && kept_tokens + tokens[split - 1] <= keep_budget {
        kept_tokens += tokens[split - 1];
        split -= 1;
    }
    while split > raw_start && split < len && is_tool_result(&view[split]) {
        split -= 1;
    }
    if split <= raw_start {
        // 近期消息不足以单独保留：把尚未折叠的消息全部折叠。
        split = len;
    }

    let folds: Vec<(usize, i64)> = view[..raw_start]
        .iter()
        .enumerate()
        .filter_map(|(index, item)| fold_meta(item).map(|meta| (index, meta.tier)))
        .collect();
    let summary_tokens: usize = tokens[..raw_start].iter().sum();
    let (start, tier) = resolve_merge_start(&folds, raw_start, summary_tokens, total_tokens);

    let range = &view[start..split];
    let raw_in_range = range.iter().filter(|item| fold_meta(item).is_none()).count();
    let folds_in_range = range.len() - raw_in_range;
    if raw_in_range == 0 && folds_in_range < 2 {
        return Err(Error::from_reason(
            "Nothing to compress yet: the context has no older messages that can be folded",
        ));
    }

    let kept: Vec<i64> = view[..start].iter().filter_map(fold_meta).map(|meta| meta.seq).collect();
    let merged: Vec<i64> = range.iter().filter_map(fold_meta).map(|meta| meta.seq).collect();
    let instruction = build_instruction(&kept, &merged, tier);
    let removed_tokens = tokens[start..split].iter().sum::<usize>() + count_tokens(&instruction);
    let retained_tokens: usize = tokens[split..].iter().sum();

    let meta = ContextFoldMeta {
        seq: max_fold_seq(database_path, conversation_id)? + 1,
        tier,
        start_id: first_covered_id(&range[0]).to_string(),
        end_id: last_covered_id(&range[range.len() - 1]).to_string(),
    };

    Ok(ContextFoldPlan {
        history: view[..split].iter().map(ContextViewItem::to_message).collect(),
        instruction: ChatContextMessage {
            role: "user".to_string(),
            origin: ORIGIN_INTERNAL.to_string(),
            content: instruction,
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        },
        record: ContextFoldRecord {
            meta,
            removed_tokens: removed_tokens as i64,
            retained_tokens: retained_tokens as i64,
        },
    })
}
