//! 进程内领域事件总线。
//!
//! 只用于反向通知（存储层写入后让工具层失效缓存），事件不带业务载荷，
//! 订阅方自行读取最新状态。handler 必须只做置脏与唤醒，禁止阻塞操作。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainEvent {
    Tools { project_id: Option<String> },
    McpServers { project_id: String },
    Plugins,
    Settings { project_id: Option<String> },
    Workspace,
}

pub type Handler = fn(&DomainEvent);

type Entry = (u64, Handler);

fn subscribers() -> &'static RwLock<Vec<Entry>> {
    static SUBSCRIBERS: OnceLock<RwLock<Vec<Entry>>> = OnceLock::new();
    SUBSCRIBERS.get_or_init(|| RwLock::new(Vec::new()))
}

pub fn subscribe(handler: Handler) -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut list) = subscribers().write() {
        list.push((id, handler));
    }
    id
}

pub fn unsubscribe(id: u64) {
    if let Ok(mut list) = subscribers().write() {
        list.retain(|(entry_id, _)| *entry_id != id);
    }
}

/// 同步分发；单个 handler panic 不影响发布方与其它订阅者。
pub fn publish(event: DomainEvent) {
    let handlers: Vec<Handler> = match subscribers().read() {
        Ok(list) => list.iter().map(|(_, handler)| *handler).collect(),
        Err(_) => return,
    };
    for handler in handlers {
        let _ = catch_unwind(AssertUnwindSafe(|| handler(&event)));
    }
}
