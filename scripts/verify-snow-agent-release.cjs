const { createHash, verify } = require("node:crypto");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const releaseDir = join(projectRoot, "release");
const trustPath = join(projectRoot, "resources", "snow-agent", "trust.json");
const requiredCapabilities = [
  "transactionalQueue",
  "processGroups",
  "resourceLimits",
  "outputFrames",
  "fileCas",
  "interactiveAttach",
];

if (!existsSync(trustPath)) {
  throw new Error("Snow Agent trust configuration is missing");
}
const trust = JSON.parse(readFileSync(trustPath, "utf8"));
if (
  trust.schemaVersion !== 1 ||
  trust.repository !== "MayDay-wpf/snow-app" ||
  !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trust.releaseTag) ||
  typeof trust.publicKey !== "string"
) {
  throw new Error("Snow Agent trust configuration is invalid");
}

const manifestNames = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((name) => /^snow-agent-[a-z0-9-]+\.json$/.test(name))
  : [];
const requiredTargets = (process.env.SNOW_AGENT_REQUIRED_TARGETS || "")
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);

if (manifestNames.length === 0) {
  throw new Error("No Snow Agent release manifest was found to verify");
}

const verifiedTargets = new Set();
for (const manifestName of manifestNames) {
  const manifestPath = join(releaseDir, manifestName);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const payload = JSON.parse(manifest.release?.payload || "");
  if (
    manifest.protocolVersion !== 1 ||
    manifest.version !== trust.releaseTag.slice(1) ||
    ![
      "linux-x64-musl",
      "linux-arm64-musl",
      "darwin-x64",
      "darwin-arm64",
    ].includes(manifest.target) ||
    manifest.target !== payload.target ||
    manifest.artifactFileName !== `snow-agent-${manifest.target}` ||
    manifest.artifactFileName !== payload.artifactFileName ||
    manifest.artifactSha256 !== payload.artifactSha256 ||
    !/^[0-9a-f]{64}$/i.test(manifest.artifactSha256) ||
    !requiredCapabilities.every((name) => manifest.capabilities?.[name] === true) ||
    manifest.capabilities?.interactiveAttachProtocolVersion !== 1 ||
    JSON.stringify(manifest.capabilities) !== JSON.stringify(payload.capabilities)
  ) {
    throw new Error(`Snow Agent manifest is invalid: ${manifestName}`);
  }
  const signature = Buffer.from(manifest.release.signature || "", "base64");
  if (
    signature.length === 0 ||
    !verify(null, Buffer.from(manifest.release.payload, "utf8"), trust.publicKey, signature)
  ) {
    throw new Error(`Snow Agent manifest signature is invalid: ${manifestName}`);
  }
  const artifactPath = join(releaseDir, manifest.artifactFileName);
  if (!existsSync(artifactPath)) {
    throw new Error(`Snow Agent artifact is missing: ${manifest.artifactFileName}`);
  }
  const artifactSha256 = createHash("sha256")
    .update(readFileSync(artifactPath))
    .digest("hex");
  if (artifactSha256 !== manifest.artifactSha256) {
    throw new Error(`Snow Agent artifact hash mismatch: ${manifest.artifactFileName}`);
  }
  verifiedTargets.add(manifest.target);
}

for (const target of requiredTargets) {
  if (!verifiedTargets.has(target)) {
    throw new Error(`Required Snow Agent release target is missing: ${target}`);
  }
}

console.log(
  `Verified Snow Agent trust configuration and ${manifestNames.length} signed release asset(s)`
);
