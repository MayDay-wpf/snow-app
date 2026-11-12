//! Global admission at the real per-image upstream request, never at the pending receipt.

use std::sync::{Mutex, OnceLock};
use tokio::sync::Notify;

pub(super) const DEFAULT_MAX_CONCURRENT_IMAGES: usize = 4;
const MAX_CONCURRENT_IMAGES: usize = 8;

struct State {
    active: usize,
    limit: usize,
}

struct Limiter {
    state: Mutex<State>,
    changed: Notify,
}

fn limiter() -> &'static Limiter {
    static LIMITER: OnceLock<Limiter> = OnceLock::new();
    LIMITER.get_or_init(|| Limiter {
        state: Mutex::new(State {
            active: 0,
            limit: DEFAULT_MAX_CONCURRENT_IMAGES,
        }),
        changed: Notify::new(),
    })
}

pub(super) fn configure(limit: Option<usize>) -> usize {
    let limit = limit
        .unwrap_or(DEFAULT_MAX_CONCURRENT_IMAGES)
        .clamp(1, MAX_CONCURRENT_IMAGES);
    let limiter = limiter();
    limiter
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .limit = limit;
    limiter.changed.notify_waiters();
    limit
}

pub(super) struct ImageRequestPermit;

pub(super) async fn acquire() -> ImageRequestPermit {
    let limiter = limiter();
    loop {
        // Register before checking the count, including wakeups between check and await.
        let notified = limiter.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let mut state = limiter
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.active < state.limit {
                state.active += 1;
                return ImageRequestPermit;
            }
        }
        notified.await;
    }
}

impl Drop for ImageRequestPermit {
    fn drop(&mut self) {
        let limiter = limiter();
        let mut state = limiter
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active = state.active.saturating_sub(1);
        drop(state);
        limiter.changed.notify_waiters();
    }
}
