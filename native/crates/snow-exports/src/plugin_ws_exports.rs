//! 插件 WebSocket 长连接的 napi 导出（实现见 `snow_plugin::ws`）。

use napi_derive::napi;

use snow_plugin::ws::{self as plugin_ws, PluginWsEventCallback};

/// 打开插件 WebSocket 长连接；参数为 `{ url, headers }` JSON，立即返回连接 id。
#[napi(js_name = "pluginWsOpen")]
pub fn plugin_ws_open(options_json: String) -> napi::Result<u32> {
    plugin_ws::open(&options_json)
}

/// 向连接发送一条文本消息；连接不存在、已关闭或队列已满时返回 false。
#[napi(js_name = "pluginWsSend")]
pub fn plugin_ws_send(id: f64, text: String) -> bool {
    plugin_ws::send(id, text)
}

/// 向连接发送一条二进制消息（入参为 base64）；连接不存在、已关闭或队列已满时返回 false。
#[napi(js_name = "pluginWsSendBinary")]
pub fn plugin_ws_send_binary(id: f64, base64: String) -> bool {
    plugin_ws::send_binary(id, base64)
}

/// 请求关闭连接；返回 true 表示关闭请求已投递。
#[napi(js_name = "pluginWsClose")]
pub fn plugin_ws_close(id: f64, code: f64, reason: String) -> bool {
    plugin_ws::close(id, code, reason)
}

/// 注册插件 WebSocket 事件回调（事件为 JSON 字符串）。
#[napi(js_name = "setPluginWsHandler")]
pub fn set_plugin_ws_handler(callback: PluginWsEventCallback) {
    plugin_ws::set_event_handler(callback);
}
