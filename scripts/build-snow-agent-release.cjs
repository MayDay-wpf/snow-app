const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createHash, createPrivateKey, createPublicKey, sign } = require("node:crypto");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const nativeDir = join(projectRoot, "native");
const releaseDir = join(projectRoot, "release");
const packageVersion = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8")
).version;
const releaseTag = (process.env.SNOW_AGENT_RELEASE_TAG || `v${packageVersion}`).trim();
const keyId = (process.env.SNOW_AGENT_RELEASE_KEY_ID || "snow-agent-ed25519-2026").trim();
const target = process.argv[2];

const targets = {
  "linux-x64-musl": "x86_64-unknown-linux-musl",
  "linux-arm64-musl": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

if (!targets[target]) {
  throw new Error(
    "Expected Snow Agent target linux-x64-musl, linux-arm64-musl, darwin-x64, or darwin-arm64"
  );
}
if (releaseTag !== `v${packageVersion}`) {
  throw new Error(`Snow Agent release tag ${releaseTag} does not match v${packageVersion}`);
}
if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
  throw new Error("Snow Agent release key ID is invalid");
}
const configuredKey = process.env.SNOW_AGENT_RELEASE_SIGNING_KEY?.trim();
if (!configuredKey) {
  throw new Error("SNOW_AGENT_RELEASE_SIGNING_KEY is required for Snow Agent release assets");
}

const cargoSubcommand = process.env.SNOW_AGENT_CARGO_SUBCOMMAND || "zigbuild";
const cargo = spawnSync(
  "cargo",
  [
    cargoSubcommand,
    "--manifest-path",
    join(nativeDir, "Cargo.toml"),
    "--release",
    "--bin",
    "snow-agent",
    "--target",
    targets[target],
  ],
  { cwd: projectRoot, stdio: "inherit" }
);
if (cargo.status !== 0) {
  process.exit(cargo.status ?? 1);
}

const source = join(nativeDir, "target", targets[target], "release", "snow-agent");
if (!existsSync(source)) {
  throw new Error(`Snow Agent binary was not produced: ${source}`);
}
const artifactFileName = `snow-agent-${target}`;
const artifactSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
const capabilities = {
  transactionalQueue: true,
  processGroups: true,
  resourceLimits: true,
  outputFrames: true,
  fileCas: true,
  interactiveAttach: true,
  interactiveAttachProtocolVersion: 1,
};
const payload = JSON.stringify({
  protocolVersion: 1,
  version: packageVersion,
  target,
  artifactFileName,
  artifactSha256,
  capabilities,
});
const signingKey = createPrivateKey(
  configuredKey.replace(/\\n/g, "\n").trim() + "\n"
);
const trustDirectory = join(projectRoot, "resources", "snow-agent");
mkdirSync(trustDirectory, { recursive: true });
writeFileSync(
  join(trustDirectory, "trust.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      repository: "MayDay-wpf/snow-app",
      releaseTag,
      publicKey: createPublicKey(signingKey)
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);
const manifest = {
  protocolVersion: 1,
  version: packageVersion,
  target,
  artifactFileName,
  artifactSha256,
  release: {
    keyId,
    payload,
    signature: sign(null, Buffer.from(payload, "utf8"), signingKey).toString("base64"),
  },
  capabilities,
};

mkdirSync(releaseDir, { recursive: true });
copyFileSync(source, join(releaseDir, artifactFileName));
chmodSync(join(releaseDir, artifactFileName), 0o755);
writeFileSync(
  join(releaseDir, `${artifactFileName}.json`),
  `${JSON.stringify(manifest)}\n`,
  { mode: 0o644 }
);
console.log(`Signed static Snow Agent release asset written for ${target}`);
