use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::sessions::{self, OAuthLoginSession};

#[derive(Clone)]
struct CallbackState {
    session: OAuthLoginSession,
}

pub async fn serve_callback(
    listener: TcpListener,
    session: OAuthLoginSession,
    shutdown: oneshot::Receiver<()>,
) {
    let callback_path = session.callback_path.clone();
    let app = Router::new()
        .route(&callback_path, get(handle_callback))
        .with_state(CallbackState { session });

    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
        })
        .await;
}

async fn handle_callback(
    State(state): State<CallbackState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let ui_font = tokio::task::spawn_blocking(|| {
        let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
            return snow_storage_core::system_settings::DEFAULT_UI_FONT_STACK.to_string();
        };
        snow_storage_core::system_settings::resolve_ui_font_family(&database_path)
    })
    .await
    .unwrap_or_else(|_| {
        snow_storage_core::system_settings::DEFAULT_UI_FONT_STACK.to_string()
    });

    match sessions::handle_callback_request(&state.session, &params).await {
        Ok(()) => Html(page(success_body(), &ui_font)).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Html(page(&error_body(&escape_html(&message)), &ui_font)),
        )
            .into_response(),
    }
}

fn page(body: &str, ui_font: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snow App</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f1115; color: #e8eaed; font-family: {ui_font}; }}
main {{ max-width: 420px; padding: 40px 32px; text-align: center; }}
h1 {{ font-size: 20px; font-weight: 600; margin: 0 0 12px; }}
p {{ font-size: 13px; line-height: 1.7; color: #9aa0a6; margin: 6px 0; }}
.icon {{ width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); font-size: 26px; }}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>"#
    )
}

fn success_body() -> &'static str {
    r#"<div class="icon">&#10003;</div>
<h1>Sign-in complete</h1>
<p>You can close this window and return to Snow App.</p>
<p>登录已完成，可以关闭此窗口并返回 Snow App。</p>"#
}

fn error_body(message: &str) -> String {
    format!(
        r#"<div class="icon">!</div>
<h1>Sign-in failed</h1>
<p>{message}</p>
<p>登录失败，请返回 Snow App 后重试。</p>"#
    )
}

fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}
