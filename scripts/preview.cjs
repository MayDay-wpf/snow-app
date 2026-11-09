const { spawn } = require("node:child_process");
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PREVIEW_ROOT = path.join(PROJECT_ROOT, ".preview");
const SHARED_DIRS = ["native", "resources", "docs", "deploy", "node_modules"];

const removeDir = (target) => {
  try {
    rmSync(target, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });
  } catch (error) {
    console.warn(`[preview] failed to remove ${target}: ${error.message}`);
  }
};

const createSnapshot = () => {
  const outDir = path.join(PROJECT_ROOT, "out");
  if (!existsSync(path.join(outDir, "main", "index.js"))) {
    console.error("[preview] out/main/index.js not found, run the build first");
    process.exit(1);
  }

  // Forced development update checks resolve this file from app.getAppPath(),
  // which is the snapshot, not cwd. Validate before creating a partial snapshot.
  const updateConfig = path.join(PROJECT_ROOT, "dev-app-update.yml");
  if (!existsSync(updateConfig)) {
    console.error(
      "[preview] PREVIEW_UPDATE_CONFIG_MISSING: dev-app-update.yml is required for forced update checks",
    );
    process.exit(1);
  }

  const snapshotDir = path.join(PREVIEW_ROOT, `run-${Date.now()}`);
  mkdirSync(snapshotDir, { recursive: true });
  cpSync(outDir, path.join(snapshotDir, "out"), { recursive: true });
  copyFileSync(
    path.join(PROJECT_ROOT, "package.json"),
    path.join(snapshotDir, "package.json"),
  );
  copyFileSync(updateConfig, path.join(snapshotDir, "dev-app-update.yml"));
  console.log(
    "[preview] development update configuration copied into snapshot",
  );

  for (const name of SHARED_DIRS) {
    const target = path.join(PROJECT_ROOT, name);
    if (existsSync(target)) {
      symlinkSync(target, path.join(snapshotDir, name), "junction");
    }
  }
  return snapshotDir;
};

const pruneSnapshots = (currentDir) => {
  if (!existsSync(PREVIEW_ROOT)) {
    return;
  }
  const current = path.resolve(currentDir);
  const stale = readdirSync(PREVIEW_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PREVIEW_ROOT, entry.name))
    .filter((dir) => path.resolve(dir) !== current)
    .sort((a, b) => b.localeCompare(a));
  for (const dir of stale.slice(1)) {
    removeDir(dir);
  }
};

const snapshotDir = createSnapshot();
pruneSnapshots(snapshotDir);

console.log(
  `[preview] snapshot ${path.relative(PROJECT_ROOT, snapshotDir)} is frozen for this session`,
);
console.log("[preview] source changes take effect after restarting preview");

const child = spawn(require("electron"), [snapshotDir], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    NODE_ENV_ELECTRON_VITE: "production",
    // 预览必须加载冻结快照：is.dev 等价于 !app.isPackaged，未打包恒为 true，
    // 若继承到开发服务器的渲染地址，主窗口会去连并不存在的 Vite 服务而白屏。
    ELECTRON_RENDERER_URL: "",
    // 未打包也执行真实更新检查与下载（安装仍被拦截）
    SNOW_UPDATE_FORCE_CHECK: "1",
    // 资源管理器右键菜单：快照目录随会话删除，菜单命令改指向稳定的项目根目录。
    SNOW_PREVIEW_APP_ROOT: PROJECT_ROOT,
  },
});

let finalized = false;
const finalize = (code) => {
  if (finalized) {
    return;
  }
  finalized = true;
  removeDir(snapshotDir);
  process.exit(code);
};

child.on("error", (error) => {
  console.error(`[preview] failed to launch electron: ${error.message}`);
  finalize(1);
});

child.on("close", (code) => {
  finalize(code ?? 1);
});
