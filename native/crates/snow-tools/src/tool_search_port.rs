//! 工具检索缓存端口：缓存实现留在桥接层，外部 MCP 客户端只负责触发失效。

use std::sync::OnceLock;

pub type Invalidator = fn(Option<&str>) -> napi::Result<()>;
pub type GenerationReader = fn() -> u64;

static INVALIDATOR: OnceLock<Invalidator> = OnceLock::new();
static GENERATION: OnceLock<GenerationReader> = OnceLock::new();

pub fn register(invalidator: Invalidator, generation: GenerationReader) {
    let _ = INVALIDATOR.set(invalidator);
    let _ = GENERATION.set(generation);
}

pub fn invalidate(project_id: Option<&str>) -> napi::Result<()> {
    match INVALIDATOR.get() {
        Some(invalidator) => invalidator(project_id),
        None => Ok(()),
    }
}

pub fn generation() -> u64 {
    GENERATION.get().map(|read| read()).unwrap_or(0)
}
