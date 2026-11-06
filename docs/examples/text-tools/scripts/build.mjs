import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const normalize = (text) => text.replaceAll("\r\n", "\n");

for (const [entry, output, platform] of [
  ["src/server.ts", "server.js", "node"],
  ["src/renderer/index.ts", "index.js", "browser"],
]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform,
    target: platform === "node" ? "node18" : "es2022",
    write: false,
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
  });
  if (platform === "browser") {
    if (
      Object.keys(result.metafile.inputs).some(
        (input) => !input.startsWith("src/"),
      )
    ) {
      throw new Error("Renderer must use host React, not bundle dependencies");
    }
    if (
      Object.values(result.metafile.outputs).some(
        (item) => item.imports.length !== 0,
      )
    ) {
      throw new Error("Renderer must be self-contained");
    }
  }
  const target = path.join(root, output);
  const source = normalize(result.outputFiles[0].text);
  if (check) {
    if (normalize(await readFile(target, "utf8")) !== source) {
      throw new Error(`${output} is stale; run npm run build`);
    }
  } else {
    await writeFile(target, source, "utf8");
  }
}
console.log(
  check ? "Artifacts match sources." : "Built server.js and index.js.",
);
