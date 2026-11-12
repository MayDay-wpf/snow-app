use std::io::Write;
use std::sync::Once;

const PANIC_LOG_DIRECTORY: &str = "logs";
const PANIC_LOG_FILE: &str = "panic.log";

static INSTALL_PANIC_HOOK: Once = Once::new();

pub fn install_panic_hook() {
    INSTALL_PANIC_HOOK.call_once(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_else(|| "unknown".to_string());
            let thread_name = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let backtrace = std::backtrace::Backtrace::force_capture();
            let record = format!(
                "[{}] panic thread={} location={} message={}\nbacktrace:\n{}\n\n",
                timestamp(),
                thread_name,
                location,
                panic_message(info.payload()),
                backtrace
            );
            append_panic_record(&record);
            default_hook(info);
        }));
    });
}

#[ctor::ctor(unsafe)]
fn init_panic_hook() {
    install_panic_hook();
}

pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

fn timestamp() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

fn append_panic_record(record: &str) {
    let Ok(storage_dir) = crate::app_paths::app_storage_dir() else {
        return;
    };
    let log_dir = storage_dir.join(PANIC_LOG_DIRECTORY);
    if std::fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(PANIC_LOG_FILE))
    else {
        return;
    };
    let _ = file.write_all(record.as_bytes());
    let _ = file.flush();
}
