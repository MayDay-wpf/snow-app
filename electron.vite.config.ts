import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "import-discovery-worker": resolve(
            __dirname,
            "src/main/importConfig/import-discovery-worker.mjs",
          ),
          "plugin-runtime-worker": resolve(
            __dirname,
            "src/main/plugins/plugin-runtime-worker.ts",
          ),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          // 内置浏览器 webview 的密码助手（guest 页面 preload，独立入口
          // 以输出单独的 webview-browser.mjs 供 <webview preload> 引用）。
          "webview-browser": resolve(
            __dirname,
            "src/preload/webviewBrowserPreload.ts",
          ),
          // 桌面宠物窗口的轻量 preload（输出 pet.mjs）。
          pet: resolve(__dirname, "src/preload/petPreload.ts"),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [react()],
    worker: {
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name].js",
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          // 桌面宠物窗口页面（独立入口，输出 pet.html）。
          pet: resolve(__dirname, "src/renderer/pet.html"),
          // 独立浏览器窗口页面（「在新窗口中打开」的浏览器 tab，输出 browserWindow.html）。
          browserWindow: resolve(__dirname, "src/renderer/browserWindow.html"),
        },
        output: {
          chunkFileNames: "assets/[name].js",
          manualChunks: {
            // React 核心 — 首屏必需，独立 chunk 利于缓存
            "vendor-react": ["react", "react-dom"],
            // 图标库 — 体积较大但首屏需要少量图标
            "vendor-lucide": ["lucide-react"],
            // 代码高亮 — 仅 chat 消息渲染时需要
            "vendor-highlightjs": ["highlight.js"],
            // 终端模拟 — 仅打开终端 tab 时需要
            "vendor-xterm": [
              "@xterm/xterm",
              "@xterm/addon-fit",
              "@xterm/addon-webgl",
            ],
          },
        },
      },
    },
  },
});
