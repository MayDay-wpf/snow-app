const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} = require("node:crypto");

const projectRoot = join(__dirname, "..");
const nativeDir = join(projectRoot, "native");
const resourcesDir = join(projectRoot, "resources");
const agentResourcesDir = join(resourcesDir, "snow-agent");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
const releaseTag = (process.env.SNOW_AGENT_RELEASE_TAG || `v${packageVersion}`).trim();
const releaseKeyId = (process.env.SNOW_AGENT_RELEASE_KEY_ID || "snow-agent-ed25519-2026").trim();
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

// macOS: build a universal (arm64 + x64) binary via lipo, unless
// NATIVE_BUILD_ARCH is set (used by CI to build a single architecture).
const darwinTargets = [
  targetMap["darwin-arm64"],
  targetMap["darwin-x64"],
];
const darwinUniversalOutput = "snow_native.darwin-universal.node";

// When NATIVE_BUILD_ARCH is set (e.g. "arm64" or "x64"), force that arch
// even on macOS instead of building a universal binary.
const forcedArch = process.env.NATIVE_BUILD_ARCH;
const platformKey = forcedArch
  ? `${process.platform}-${forcedArch}`
  : `${process.platform}-${process.arch}`;
const target = targetMap[platformKey];

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
    "--release",
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
  return join(nativeDir, "target", t.triple, "release", t.artifact);
}

function normalizePem(value) {
  return value.replace(/\\n/g, "\n").trim() + "\n";
}

function loadReleaseSigningKey() {
  const configured = process.env.SNOW_AGENT_RELEASE_SIGNING_KEY?.trim();
  if (configured) {
    return createPrivateKey(normalizePem(configured));
  }
  if (process.env.SNOW_AGENT_REQUIRE_RELEASE_SIGNING === "1") {
    throw new Error(
      "SNOW_AGENT_RELEASE_SIGNING_KEY is required when publishing Snow Agent assets"
    );
  }
  console.warn(
    "SNOW_AGENT_RELEASE_SIGNING_KEY is not configured; using an ephemeral development key"
  );
  return generateKeyPairSync("ed25519").privateKey;
}

const releaseSigningKey = loadReleaseSigningKey();
const releasePublicKey = createPublicKey(releaseSigningKey)
  .export({ type: "spki", format: "pem" })
  .toString();

function writeTrustConfig() {
  if (!/^v[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(releaseTag)) {
    throw new Error(`Invalid Snow Agent release tag: ${releaseTag}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(releaseKeyId)) {
    throw new Error(`Invalid Snow Agent release key id: ${releaseKeyId}`);
  }
  if (releaseTag !== `v${packageVersion}`) {
    throw new Error(
      `Snow Agent release tag ${releaseTag} does not match package version v${packageVersion}`
    );
  }
  mkdirSync(agentResourcesDir, { recursive: true });
  writeFileSync(
    join(agentResourcesDir, "trust.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: "MayDay-wpf/snow-app",
        releaseTag,
        publicKey: releasePublicKey,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

writeTrustConfig();

function copyNativeBinding(artifactPath, outputPath, platformName) {
  try {
    copyFileSync(artifactPath, outputPath);
    console.log(`Native binding written to ${outputPath}`);
  } catch (error) {
    if (error?.code !== "EBUSY") {
      throw error;
    }

    // 目标 .node 被运行中的 Electron 锁定，清除旧的带时间戳副本后写入新的
    const staleFiles = readdirSync(nativeDir)
      .filter(
        (file) =>
          file.startsWith(`snow_native.${platformName}.`) &&
          file.endsWith(".node") &&
          file !== `snow_native.${platformName}.node`
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
      `snow_native.${platformName}.${Date.now()}.node`
    );
    copyFileSync(artifactPath, fallbackOutputPath);
    console.warn(
      `Native binding target is busy, wrote fresh binding to ${fallbackOutputPath}`
    );
  }
}

if (process.platform === "darwin" && !forcedArch) {
  // Build both arm64 and x64, then merge with lipo into a universal binary
  for (const t of darwinTargets) {
    console.log(`Building Rust native for ${t.triple}...`);
    runCargoBuild(t.triple);
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
  const lipoResult = spawnSync("lipo", [
    "-create",
    arm64Artifact,
    x64Artifact,
    "-output",
    universalOutputPath,
  ], {
    stdio: "inherit",
  });

  if (lipoResult.status !== 0) {
    throw new Error("lipo failed to create universal binary");
  }

  console.log(`Universal native binding written to ${universalOutputPath}`);
} else {
  // Single-architecture build (non-macOS or macOS with NATIVE_BUILD_ARCH set)
  // Non-macOS: build single architecture as before
  runCargoBuild(target.triple);

  const artifactPath = getArtifactPath(target);
  const outputPath = join(nativeDir, target.output);

  if (!existsSync(artifactPath)) {
    throw new Error(`Cargo build artifact not found: ${artifactPath}`);
  }

  copyNativeBinding(artifactPath, outputPath, target.platformName);
}
