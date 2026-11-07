/**
 * 启动首帧字体：在 React 挂载前同步把主题缓存里的字体族与字重写到根元素，
 * 避免加载页先用默认字体渲染一帧。
 *
 * 必须是外部脚本：渲染页 CSP 为 `script-src 'self' blob:`，没有
 * `'unsafe-inline'` / nonce / hash，index.html 里的内联 <script> 会被直接拒绝执行。
 */
import { applyCachedThemeFontToDocument } from "./components/sidebar/themeSettings/themeFontCache";

applyCachedThemeFontToDocument();
