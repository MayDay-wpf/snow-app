const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = join(__dirname, "..");
const nativeDir = join(projectRoot, "native");
const packageVersion = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
).version;
const targetMap = {
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    artifact: "snow_native.dll",
    output: "snow_native.win32-x64-msvc.node",
    platformName: "win32-x64-msvc",
  },
  "win32-arm64": {
    triple: "aarch64-pc-windows-msvc",
    artifact: "snow_native.dll",
    output: "snow_native.win32-arm64-msvc.node",
    platformName: "win32-arm64-msvc",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    artifact: "libsnow_native.dylib",
    output: "snow_native.darwin-x64.node",
    platformName: "darwin-x64",
  },
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    artifact: "libsnow_native.dylib",
    output: "snow_native.darwin-arm64.node",
    platformName: "darwin-arm64",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    artifact: "libsnow_native.so",
    output: "snow_native.linux-x64-gnu.node",
    platformName: "linux-x64-gnu",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    artifact: "libsnow_native.so",
    output: "snow_native.linux-arm64-gnu.node",
    platformName: "linux-arm64-gnu",
  },
};

// NATIVE_BUILD_UNIVERSAL=1 时 macOS 双编 arm64 + x64 并用 lipo 合并。
const darwinTargets = [targetMap["darwin-arm64"], targetMap["darwin-x64"]];
const darwinUniversalOutput = "snow_native.darwin-universal.node";

// NATIVE_BUILD_ARCH 强制单架构（CI 使用）。
const forcedArch = process.env.NATIVE_BUILD_ARCH;
const buildUniversal =
  process.platform === "darwin" &&
  !forcedArch &&
  process.env.NATIVE_BUILD_UNIVERSAL === "1";
const platformKey = forcedArch
  ? `${process.platform}-${forcedArch}`
  : `${process.platform}-${process.arch}`;
const target = targetMap[platformKey];

// --release 为发布产物（thin LTO）；默认 local 走增量，改动后快速重编。
const buildProfile = process.argv.includes("--release") ? "release" : "local";
console.log(`Rust build profile: ${buildProfile}`);

if (process.platform !== "darwin" && !target) {
  throw new Error(`Unsupported native build platform: ${platformKey}`);
}

const cargoCommand = process.platform === "win32" ? "cargo.exe" : "cargo";

// Detect a usable rustc wrapper (sccache) so compiled crates are cached across
// builds. Only enabled when sccache is actually available, so machines or CI
// runners without it simply build without caching instead of failing.
function detectRustcWrapper() {
  // Respect an explicitly configured wrapper from the environment.
  if (process.env.RUSTC_WRAPPER) return process.env.RUSTC_WRAPPER;
  // Allow opting out explicitly.
  if (process.env.SNOW_DISABLE_SCCACHE) return null;
  const probe = spawnSync("sccache", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? "sccache" : null;
}

const rustcWrapper = detectRustcWrapper();
if (rustcWrapper) {
  console.log(`Using rustc wrapper "${rustcWrapper}" (shared compile cache)`);
} else {
  console.log("sccache not detected, building without a shared compile cache");
}

function runCargoBuild(triple) {
  const cargoArgs = [
    "build",
    "--manifest-path",
    join(nativeDir, "Cargo.toml"),
    "--profile",
    buildProfile,
    "--target",
    triple,
  ];

  const cargoEnv = { ...process.env };
  if (rustcWrapper) cargoEnv.RUSTC_WRAPPER = rustcWrapper;

  const result = spawnSync(cargoCommand, cargoArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    env: cargoEnv,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getArtifactPath(t) {
  return join(nativeDir, "target", t.triple, buildProfile, t.artifact);
}

// 增量产物偶发把 crate 内部符号链接成未定义的 .llvm.<hash>，dylib 允许动态查找故链接不报错，运行时调用即空指针崩溃。
function findDanglingLlvmSymbols(artifactPath) {
  if (process.platform === "win32") return [];
  const result = spawnSync("nm", ["-u", artifactPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(".llvm."));
}

// 检出悬空符号时清掉本 crate 的增量缓存重编一次，仍有则中断构建。
function ensureNoDanglingSymbols(t) {
  const artifactPath = getArtifactPath(t);
  let dangling = findDanglingLlvmSymbols(artifactPath);
  if (dangling.length === 0) return;
  console.warn(
    `Detected ${dangling.length} dangling .llvm symbols in ${artifactPath}, cleaning snow_native and rebuilding...`,
  );
  const cleanResult = spawnSync(
    cargoCommand,
    [
      "clean",
      "--manifest-path",
      join(nativeDir, "Cargo.toml"),
      "--profile",
      buildProfile,
      "--target",
      t.triple,
      "-p",
      "snow_native",
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (cleanResult.status !== 0) {
    process.exit(cleanResult.status ?? 1);
  }
  runCargoBuild(t.triple);
  dangling = findDanglingLlvmSymbols(artifactPath);
  if (dangling.length > 0) {
    throw new Error(
      `Native artifact still has dangling symbols:\n${dangling.slice(0, 10).join("\n")}`,
    );
  }
}

function copyNativeBinding(artifactPath, outputPath, platformName) {
  // 先写临时文件再原子替换：原地覆盖会让 macOS 代码签名缓存命中旧 inode，
  // 新版进程加载该 .node 时会被内核以 SIGKILL(Code Signature Invalid) 终止。
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  try {
    copyFileSync(artifactPath, tempPath);
    renameSync(tempPath, outputPath);
    console.log(`Native binding written to ${outputPath}`);
    return;
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能未创建
    }
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") {
      throw error;
    }

    // 目标 .node 被运行中的 Electron 锁定，清除旧的带时间戳副本后写入新的
    const staleFiles = readdirSync(nativeDir)
      .filter(
        (file) =>
          file.startsWith(`snow_native.${platformName}.`) &&
          file.endsWith(".node") &&
          file !== `snow_native.${platformName}.node`,
      )
      .map((file) => join(nativeDir, file));

    for (const stale of staleFiles) {
      try {
        unlinkSync(stale);
      } catch {
        // 旧文件可能也被锁定，跳过
      }
    }

    const fallbackOutputPath = join(
      nativeDir,
      `snow_native.${platformName}.${Date.now()}.node`,
    );
    copyFileSync(artifactPath, fallbackOutputPath);
    console.warn(
      `Native binding target is busy, wrote fresh binding to ${fallbackOutputPath}`,
    );
  }
}

if (buildUniversal) {
  // Build both arm64 and x64, then merge with lipo into a universal binary
  for (const t of darwinTargets) {
    console.log(`Building Rust native for ${t.triple}...`);
    runCargoBuild(t.triple);
    ensureNoDanglingSymbols(t);
  }

  const arm64Artifact = getArtifactPath(darwinTargets[0]);
  const x64Artifact = getArtifactPath(darwinTargets[1]);

  if (!existsSync(arm64Artifact)) {
    throw new Error(`Cargo build artifact not found: ${arm64Artifact}`);
  }
  if (!existsSync(x64Artifact)) {
    throw new Error(`Cargo build artifact not found: ${x64Artifact}`);
  }

  const universalOutputPath = join(nativeDir, darwinUniversalOutput);

  // Merge into a universal binary using lipo
  const lipoResult = spawnSync(
    "lipo",
    ["-create", arm64Artifact, x64Artifact, "-output", universalOutputPath],
    {
      stdio: "inherit",
    },
  );

  if (lipoResult.status !== 0) {
    throw new Error("lipo failed to create universal binary");
  }

  console.log(`Universal native binding written to ${universalOutputPath}`);

  // 清理历史遗留产物：旧单架构绑定（snow_native.darwin-*.node）与
  // NAPI-RS 旧命名文件（index.*.node / index.js / index.d.ts）。
  // 若不清理，electron-builder 的 files 通配会把旧 .node 一并打进安装包，
  // index.cjs 运行时可能误选旧产物（如缺少新增导出字段），导致渲染层崩溃。
  for (const stale of readdirSync(nativeDir)) {
    const isStale =
      stale === "index.js" ||
      stale === "index.d.ts" ||
      /^index\..*\.node$/.test(stale) ||
      /^snow_native\.darwin-(arm64|x64)\.node$/.test(stale);
    if (!isStale) continue;
    try {
      unlinkSync(join(nativeDir, stale));
      console.log(`Removed stale native artifact: ${stale}`);
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
      console.warn(`Skipped removing locked native artifact: ${stale}`);
    }
  }
} else {
  // 单架构构建；移除旧双编产物，避免被 electron-builder 的 files 通配打包
  runCargoBuild(target.triple);

  const artifactPath = getArtifactPath(target);
  const outputPath = join(nativeDir, target.output);

  if (!existsSync(artifactPath)) {
    throw new Error(`Cargo build artifact not found: ${artifactPath}`);
  }

  ensureNoDanglingSymbols(target);
  copyNativeBinding(artifactPath, outputPath, target.platformName);

  const staleUniversal = join(nativeDir, darwinUniversalOutput);
  if (process.platform === "darwin" && existsSync(staleUniversal)) {
    unlinkSync(staleUniversal);
  }
}
