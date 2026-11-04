//! 远控「未授权」配对引导页（原生服务端渲染）。
//!
//! 未携带有效配对凭据的浏览器直接访问远控地址（地址栏输入、旧书签、凭据已被
//! 更换的旧链接）时，由这里渲染一张自包含 HTML 代替裸 JSON 报错：
//! - 样式与图标全部内联，不依赖 out/mobile 产物；配合 strict CSP
//!   （无脚本、无外部资源）即使远控页构建缺失也能完整显示；
//! - 文案语言与移动页一致：桌面端语言 → 浏览器 Accept-Language → 英文兜底；
//! - 页面绝不包含配对凭据或实际地址，只指引用户回桌面端「设置 → 手机远控」
//!   获取配对链接，避免把 401 变成信息泄漏面。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;

use super::assets::{Locale, DEFAULT_LOCALE};

type Step = (&'static str, &'static str);

struct PageCopy {
    /// 写入 <html lang>。
    lang: &'static str,
    /// 写入 <title>。
    title: &'static str,
    /// 状态胶囊文案。
    badge: &'static str,
    headline: &'static str,
    lead: &'static str,
    /// 配对三步指引。
    steps: [Step; 3],
    /// 重新加载按钮。
    reload: &'static str,
    /// 安全提示。
    security: &'static str,
}

const COPY_ZH_CN: PageCopy = PageCopy {
    lang: "zh-CN",
    title: "需要配对 · Snow Remote",
    badge: "需要配对",
    headline: "此浏览器尚未与 Snow 配对",
    lead: "远程控制页面只对已配对的设备开放。请用 Snow「设置 → 手机远控」中显示的配对链接重新打开本页。",
    steps: [
        (
            "打开 Snow 桌面端",
            "进入「设置 → 手机远控」，确认服务正在运行",
        ),
        (
            "用这台手机扫描二维码",
            "局域网或公网二维码均可，扫码会自动带上配对凭据",
        ),
        (
            "或直接打开配对链接",
            "点设置页的「复制地址」，把链接发送到这台手机打开",
        ),
    ],
    reload: "重新加载",
    security: "请勿将配对链接分享给他人——持有链接即可控制你的 Snow 会话。",
};

const COPY_ZH_TW: PageCopy = PageCopy {
    lang: "zh-TW",
    title: "需要配對 · Snow Remote",
    badge: "需要配對",
    headline: "此瀏覽器尚未與 Snow 配對",
    lead: "遠端控制頁面只開放給已配對的裝置。請用 Snow「設定 → 手機遠控」中顯示的配對連結重新開啟本頁。",
    steps: [
        (
            "開啟電腦版 Snow",
            "進入「設定 → 手機遠控」，確認服務正在執行",
        ),
        (
            "用這支手機掃描二維碼",
            "區域網路或公網二維碼皆可，掃描後會自動帶上配對憑證",
        ),
        (
            "或直接開啟配對連結",
            "點設定頁的「複製位址」，把連結傳到這支手機開啟",
        ),
    ],
    reload: "重新載入",
    security: "請勿將配對連結分享給他人——持有連結即可控制你的 Snow 工作階段。",
};

const COPY_EN: PageCopy = PageCopy {
    lang: "en",
    title: "Pairing required · Snow Remote",
    badge: "Pairing required",
    headline: "This browser isn't paired with Snow",
    lead: "The remote control page is only available to paired devices. Reopen this page with the pairing link shown in Snow under Settings → Mobile remote control.",
    steps: [
        (
            "Open Snow on your computer",
            "Go to Settings → Mobile remote control and make sure the service is running",
        ),
        (
            "Scan the QR code with this phone",
            "LAN and public QR codes both work — they carry the pairing credentials",
        ),
        (
            "Or open the pairing link directly",
            "Use “Copy address” in the settings panel and send the link to this phone",
        ),
    ],
    reload: "Reload",
    security: "Keep the pairing link private — anyone holding it can control your Snow session.",
};

/// 页面语言：桌面端语言 → Accept-Language 首个语言标签 → 英文兜底，
/// 与移动页「桌面优先、浏览器兜底」的次序一致。
pub fn resolve_locale(desktop: Option<Locale>, accept_language: Option<&str>) -> Locale {
    desktop
        .or_else(|| Locale::from_accept_language(accept_language))
        .unwrap_or(DEFAULT_LOCALE)
}

/// lucide `lock`：状态胶囊左侧图标（项目约定图标只用 lucide）。
const LOCK_ICON: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>"#;

/// 应用图标不可读时的品牌兜底：lucide `snowflake`。
const SNOWFLAKE_FALLBACK: &str = r#"<svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/></svg>"#;

const PAGE_STYLE: &str = r#"
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      :root {
        --bg: #08090b;
        --panel: #111317;
        --line: rgba(255, 255, 255, 0.09);
        --text: #f5f7fa;
        --muted: #959ba6;
        --dim: #626974;
        --blue: #78a8ff;
        --pill-bg: rgba(242, 198, 109, 0.1);
        --pill-border: rgba(242, 198, 109, 0.34);
        --pill-fg: #f2c66d;
        color-scheme: dark;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f5f6f8;
          --panel: #ffffff;
          --line: rgba(15, 23, 42, 0.12);
          --text: #17191d;
          --muted: #667085;
          --dim: #98a0ad;
          --blue: #276ee8;
          --pill-bg: rgba(166, 99, 8, 0.08);
          --pill-border: rgba(166, 99, 8, 0.28);
          --pill-fg: #a66308;
          color-scheme: light;
        }
      }
      html,
      body {
        margin: 0;
      }
      body {
        min-height: 100vh;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: calc(28px + env(safe-area-inset-top, 0px))
          calc(20px + env(safe-area-inset-right, 0px))
          calc(28px + env(safe-area-inset-bottom, 0px))
          calc(20px + env(safe-area-inset-left, 0px));
        background: radial-gradient(
            760px 380px at 50% -140px,
            rgba(80, 120, 255, 0.16),
            transparent 72%
          ),
          var(--bg);
        color: var(--text);
        font-family: var(--ui-font, Inter, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 100%;
        max-width: 420px;
        animation: rise 0.3s ease-out;
      }
      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 9px;
        margin-bottom: 20px;
      }
      .logo-wrap {
        position: relative;
        display: grid;
        place-items: center;
        width: 76px;
        height: 76px;
      }
      .logo-wrap::before {
        content: "";
        position: absolute;
        inset: -26px;
        border-radius: 50%;
        background: radial-gradient(
          closest-side,
          rgba(120, 168, 255, 0.28),
          transparent 74%
        );
      }
      .logo {
        position: relative;
        width: 64px;
        height: 64px;
        color: var(--blue);
      }
      .eyebrow {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.24em;
        color: var(--dim);
      }
      .head {
        text-align: center;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 11px;
        margin-bottom: 14px;
        border: 1px solid var(--pill-border);
        border-radius: 999px;
        background: var(--pill-bg);
        color: var(--pill-fg);
        font-size: 11px;
        font-weight: 700;
      }
      .status svg {
        width: 12px;
        height: 12px;
      }
      h1 {
        margin: 0 0 9px;
        font-size: 21px;
        line-height: 1.45;
        letter-spacing: -0.01em;
      }
      .lead {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.8;
      }
      .steps {
        list-style: none;
        margin: 20px 0 0;
        padding: 0;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        overflow: hidden;
      }
      .steps li {
        display: flex;
        gap: 12px;
        padding: 14px 16px;
      }
      .steps li + li {
        border-top: 1px solid var(--line);
      }
      .step-num {
        flex: none;
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        margin-top: 1px;
        border-radius: 8px;
        background: rgba(120, 168, 255, 0.14);
        color: var(--blue);
        font-size: 11px;
        font-weight: 700;
      }
      .step-body b {
        display: block;
        margin-bottom: 2px;
        font-size: 13px;
      }
      .step-body span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.7;
      }
      .actions {
        margin-top: 18px;
      }
      .button {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 46px;
        border-radius: 14px;
        background: var(--text);
        color: var(--bg);
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        transition:
          transform 0.14s,
          opacity 0.14s;
      }
      .button:active {
        transform: scale(0.97);
        opacity: 0.92;
      }
      .button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
      .security {
        margin: 14px 0 0;
        text-align: center;
        color: var(--dim);
        font-size: 11px;
        line-height: 1.7;
      }
      .signature {
        margin-top: 26px;
        text-align: center;
        color: var(--dim);
        font-size: 9px;
        letter-spacing: 0.14em;
        opacity: 0.72;
      }
      @media (prefers-reduced-motion: reduce) {
        .card {
          animation: none;
        }
        .button {
          transition: none;
        }
      }
"#;

fn copy_for(locale: Locale) -> &'static PageCopy {
    match locale {
        Locale::ZhCn => &COPY_ZH_CN,
        Locale::ZhTw => &COPY_ZH_TW,
        Locale::En => &COPY_EN,
    }
}

/// 渲染引导页 HTML；调用方负责写入响应并附加 CSP 等安全响应头。
pub fn render_unauthorized_page(
    locale: Locale,
    icon_png: Option<&[u8]>,
    ui_font_family: &str,
) -> String {
    let copy = copy_for(locale);
    let logo = match icon_png {
        Some(bytes) => format!(
            r#"<img class="logo" src="data:image/png;base64,{}" alt="" width="64" height="64" />"#,
            BASE64_STANDARD.encode(bytes)
        ),
        None => SNOWFLAKE_FALLBACK.to_string(),
    };
    let steps = copy
        .steps
        .iter()
        .enumerate()
        .map(|(index, (title, detail))| {
            format!(
                r#"<li><span class="step-num" aria-hidden="true">{}</span><div class="step-body"><b>{}</b><span>{}</span></div></li>"#,
                index + 1,
                title,
                detail
            )
        })
        .collect::<String>();
    format!(
        r##"<!doctype html>
<html lang="{lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#08090b" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)" />
    <meta name="robots" content="noindex, nofollow" />
    <title>{title}</title>
    <style>{style}</style>
    <style>:root{{--ui-font:{ui_font_family}}}</style>
  </head>
  <body>
    <main class="card">
      <div class="brand">
        <div class="logo-wrap">{logo}</div>
        <span class="eyebrow">SNOW REMOTE</span>
      </div>
      <div class="head">
        <span class="status">{lock}{badge}</span>
        <h1>{headline}</h1>
        <p class="lead">{lead}</p>
      </div>
      <ol class="steps">{steps}</ol>
      <div class="actions"><a class="button" href="">{reload}</a></div>
      <p class="security">{security}</p>
      <div class="signature">SNOW REMOTE</div>
    </main>
  </body>
</html>
"##,
        lang = copy.lang,
        title = copy.title,
        style = PAGE_STYLE,
        logo = logo,
        lock = LOCK_ICON,
        badge = copy.badge,
        headline = copy.headline,
        lead = copy.lead,
        steps = steps,
        reload = copy.reload,
        security = copy.security,
    )
}
